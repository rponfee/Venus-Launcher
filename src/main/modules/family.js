'use strict';
// Modo familia: tope de horas por dia, horario permitido y lista de servidores, protegidos con un PIN. Reglas en
// family/logic.js, PIN en family/pin.js y el motor que mira las partidas en family/engine.js. Es un control del launcher,
// no una barrera de seguridad del sistema: el que puede abrir un juego por otro lado o borrar data/family.json lo saltea.
// El hash del PIN y el resto viven en data/family.json, fuera de settings.json: no viajan con Exportar ni con la nube.
//   family:status()                        -> { enabled, config, usedMs, remainingMs, reason, insideWindow, opensAt, extendUntil,
//                                               phase, countdownEndsAt, servers, lock: { locked, retryInMs, attemptsLeft } }
//   family:enable(pin, config)             -> { recoveryCode } (el codigo se muestra una sola vez)
//   family:update(pin, config) · family:disable(pin) · family:changePin(pin, pinNuevo)
//   family:recover(codigo, pinNuevo)       -> { recoveryCode } (el codigo usado deja de servir)
//   family:extend(pin, minutos)            -> estado · family:allowServer(pin, instanceId, { save }) -> estado
// Errores con err.code: badPin, locked, badInput, notEnabled, alreadyEnabled. Evento family:event (kind: warn, countdown,
// cancelled, closing, server, serverClosing, serverAllowed).
const fs = require('fs');
const paths = require('../core/paths');
const game = require('../core/game');
const { readJson, writeJson } = require('../core/util');
const { t } = require('../core/i18n');
const logic = require('./family/logic');
const pin = require('./family/pin');
const { createEngine } = require('./family/engine');

const FILE = () => paths.data('family.json');
const GRACE_MS = 10 * 1000; // lo que tiene el juego para cerrarse y guardar antes de cerrarlo a la fuerza

const st = { data: { enabled: false }, engine: null, ctx: null, chain: Promise.resolve(), closing: new Map() };

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

// Todo lo que toca el PIN va en fila: dos intentos a la vez no pueden gastar un solo intento.
function inOrder(fn) {
  const run = st.chain.then(fn);
  st.chain = run.catch(() => {});
  return run;
}

const save = () => writeJson(FILE(), st.data);

// Los intentos se guardan antes de contestar: reiniciar el launcher no da intentos nuevos.
async function checkOrThrow(kind, value) {
  const now = Date.now();
  const lock = pin.lockInfo(st.data.attempts, now);
  if (lock.locked) throw coded('locked', t('datatools.familyLocked', { minutes: Math.max(1, Math.ceil(lock.retryInMs / 60000)) }));
  const saved = kind === 'pin' ? st.data.pin : st.data.recovery;
  const okay = await pin.checkSecret(kind === 'pin' ? String(value ?? '') : pin.normalizeCode(value), saved);
  if (okay) {
    st.data.attempts = pin.okAttempt();
    await save();
    return;
  }
  st.data.attempts = pin.failedAttempt(st.data.attempts, Date.now());
  await save();
  const after = pin.lockInfo(st.data.attempts, Date.now());
  if (after.locked) throw coded('locked', t('datatools.familyLocked', { minutes: Math.ceil(after.retryInMs / 60000) }));
  throw coded('badPin', t(kind === 'pin' ? 'datatools.familyBadPin' : 'datatools.familyBadCode', { count: after.attemptsLeft }));
}

function requireEnabled() {
  if (!st.data.enabled) throw coded('notEnabled', t('datatools.familyNotEnabled'));
}

function requireValidPin(value) {
  if (!pin.validPin(value)) throw coded('badInput', t('datatools.familyPinRule'));
}

function status() {
  const lock = pin.lockInfo(st.data.attempts, Date.now());
  const base = { enabled: Boolean(st.data.enabled), config: logic.normalizeConfig(st.data.config), lock: { locked: lock.locked, retryInMs: lock.retryInMs, attemptsLeft: lock.attemptsLeft } };
  return { ...base, ...(st.engine ? st.engine.status() : {}) };
}

async function newRecovery() {
  const code = pin.newRecoveryCode();
  st.data.recovery = await pin.hashSecret(pin.normalizeCode(code));
  return code;
}

// ---------- Cerrar el juego ----------
// Primero se le pide a la ventana que se cierre, asi Minecraft guarda el mundo; game.stop corta del todo a los 10 s.
// platform se inyecta solo en las pruebas (el motor llama closeGame(id, motivo)).
function closeGame(id, _reason, platform = process.platform) {
  if (st.closing.has(id)) return;
  const entry = game.status()[id];
  if (!entry?.pid) {
    game.stop(id);
    return;
  }
  // Windows: taskkill sin /F (la ventana se cierra y el juego sale con 0). macOS y Linux: SIGTERM al grupo del juego
  // con game.stop, que lo marca como cerrado por el launcher: Java sale con 143 y no tiene que contar como crash.
  try {
    if (platform === 'win32') require('../core/platform').stopProcess({ pid: entry.pid, force: false });
    else game.stop(id, { force: false });
  } catch {
    /* se corta abajo */
  }
  const timer = setTimeout(() => {
    st.closing.delete(id);
    if (game.status()[id]) game.stop(id);
  }, GRACE_MS);
  timer.unref?.();
  st.closing.set(id, timer);
}

// ---------- Avisos ----------
function noticeText(ev) {
  if (ev.kind === 'warn') return { title: t('datatools.familyWarnTitle'), body: t(ev.reason === 'schedule' ? 'datatools.familyWarnSchedule' : 'datatools.familyWarnLimit', { count: ev.minutes }) };
  if (ev.kind === 'countdown') return { title: t('datatools.familyCountdownTitle'), body: t(ev.reason === 'schedule' ? 'datatools.familyCountdownSchedule' : 'datatools.familyCountdownLimit') };
  if (ev.kind === 'server') return { title: t('datatools.familyServerTitle'), body: t('datatools.familyServerBody', { address: ev.address }) };
  return null;
}

// En el juego el launcher no se ve: se avisa en el overlay y con una notificacion del sistema, por si el overlay esta apagado.
function notify(ev) {
  st.ctx?.send?.('family:event', ev);
  const text = noticeText(ev);
  if (!text) return;
  try {
    require('./overlay').push({ kind: 'alert', icon: 'info', title: text.title, body: text.body, ttl: 12 }, { direct: true });
  } catch {
    /* sin overlay */
  }
  try {
    const { Notification } = require('electron');
    const win = st.ctx?.getWindow?.();
    if (Notification.isSupported() && !win?.isFocused?.()) new Notification({ title: text.title, body: text.body, silent: false }).show();
  } catch {
    /* sin notificaciones */
  }
}

function launchMessage(res) {
  if (res.reason === 'schedule') {
    const when = res.opensAt ? new Date(res.opensAt).toTimeString().slice(0, 5) : null;
    return when ? t('datatools.familyBlockedSchedule', { time: when }) : t('datatools.familyBlockedScheduleNow');
  }
  return t('datatools.familyBlockedLimit');
}

// ---------- Registro ----------
function register({ handle, send, getWindow, onQuit }) {
  st.ctx = { send, getWindow };
  st.data = { enabled: false };
  // Lectura sincronica: el chequeo antes de jugar tiene que valer desde el primer momento
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (raw && typeof raw === 'object') st.data = raw;
  } catch {
    /* primera vez o archivo ilegible: sin modo familia */
  }
  st.engine = createEngine({
    game,
    getData: () => st.data,
    saveUsage: (usage) =>
      inOrder(async () => {
        if (!st.data.enabled) return;
        st.data.usage = usage;
        await save();
      }),
    notify,
    closeGame,
  });
  st.engine.start();

  game.events.on('state', (id, state) => {
    if (state?.state !== 'stopped' && state?.state !== 'crashed') return;
    const timer = st.closing.get(id);
    if (timer) clearTimeout(timer);
    st.closing.delete(id);
  });

  game.addBeforeLaunch(async () => {
    const res = st.engine.canLaunch();
    return res.ok ? null : { block: true, message: launchMessage(res) };
  });

  handle('family:status', () => status());
  handle('family:enable', (value, config) =>
    inOrder(async () => {
      if (st.data.enabled) throw coded('alreadyEnabled', t('datatools.familyAlreadyEnabled'));
      requireValidPin(value);
      st.data = { version: 1, enabled: true, config: logic.normalizeConfig(config), pin: await pin.hashSecret(value), attempts: pin.okAttempt(), usage: null };
      const recoveryCode = await newRecovery();
      await save();
      st.engine.resetUsage();
      st.engine.reload();
      send('family:event', { kind: 'changed' });
      return { recoveryCode };
    }),
  );
  handle('family:update', (value, config) =>
    inOrder(async () => {
      requireEnabled();
      await checkOrThrow('pin', value);
      st.data.config = logic.normalizeConfig(config);
      await save();
      st.engine.reload();
      send('family:event', { kind: 'changed' });
      return status();
    }),
  );
  handle('family:disable', (value) =>
    inOrder(async () => {
      requireEnabled();
      await checkOrThrow('pin', value);
      // Sin modo familia no queda nada guardado: ni el hash del PIN ni el tiempo jugado.
      st.data = { version: 1, enabled: false };
      await save();
      st.engine.reload();
      send('family:event', { kind: 'changed' });
      return status();
    }),
  );
  handle('family:changePin', (value, next) =>
    inOrder(async () => {
      requireEnabled();
      requireValidPin(next);
      await checkOrThrow('pin', value);
      st.data.pin = await pin.hashSecret(next);
      await save();
      return true;
    }),
  );
  handle('family:recover', (code, next) =>
    inOrder(async () => {
      requireEnabled();
      requireValidPin(next);
      await checkOrThrow('recovery', code);
      st.data.pin = await pin.hashSecret(next);
      const recoveryCode = await newRecovery();
      await save();
      return { recoveryCode };
    }),
  );
  handle('family:extend', (value, minutes) =>
    inOrder(async () => {
      requireEnabled();
      await checkOrThrow('pin', value);
      st.engine.extend(minutes);
      send('family:event', { kind: 'changed' });
      return status();
    }),
  );
  handle('family:allowServer', (value, instanceId, opts) =>
    inOrder(async () => {
      requireEnabled();
      await checkOrThrow('pin', value);
      const address = st.engine.allowServer(String(instanceId || ''));
      if (address && opts?.save) {
        const cfg = logic.normalizeConfig(st.data.config);
        cfg.servers.list = logic.normalizeServerList([...cfg.servers.list, address]);
        st.data.config = cfg;
        await save();
      }
      send('family:event', { kind: 'changed' });
      return status();
    }),
  );

  onQuit?.(() => st.engine.stop());
}

module.exports = { register, status, closeGame };
