'use strict';
// Pruebas reales de la busqueda del culpable:
// - ModSwitcher activa/desactiva mods renombrando "x.jar" <-> "x.jar.disabled". Antes de tocar nada deja
//   anotado el estado original en <instancia>/.venus/bisect-state.json (y una copia de options.txt) para
//   poder deshacer todo aunque el launcher se cierre de golpe.
// - createGameRunner abre el juego, mira el registro para decidir si llego al menu principal (o si
//   crasheo) y lo cierra. En modo manual espera la respuesta del usuario.
// Sin Electron: el juego, la cuenta y los ajustes se inyectan.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const parse = require('./parse');

const STATE_DIR = '.venus';
const STATE_FILE = 'bisect-state.json';
const BACKUP_DIR = 'bisect-backup';
const OPTION_FILES = ['options.txt', 'optionsof.txt', 'optionsshaders.txt'];

// Señales de que la prueba fallo (crash, error de carga de mods, JVM que no arranca)
const FAILURE = [
  /---- Minecraft Crash Report ----/,
  /#@!@# Game crashed!/,
  /Crash report saved to:/i,
  /Preparing crash report with UUID/i,
  /Incompatible mods? (?:found|set)/i,
  /Mod resolution (?:failed|encountered)/i,
  /Some of your mods are incompatible/i,
  /Missing or unsupported mandatory dependencies/i,
  /Failed to complete lifecycle event/i,
  /Loading errors encountered/i,
  /(?:Mod)?LoadingException|LoadingFailedException|EarlyLoadingException/,
  /Exception in thread "(?:main|Render thread|Client thread)"/,
  /Encountered an unexpected exception/i,
  /Unreported exception thrown!/i,
  /java\.lang\.OutOfMemoryError/,
  /Could not create the Java Virtual Machine/i,
  /A fatal error has been detected by the Java Runtime/i,
  /Could not find or load main class/i,
  /Could not execute entrypoint stage/i,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// Renombrar con reintentos: Windows puede tener el jar tomado unos segundos despues de cerrar el juego
async function renameRetry(from, to, tries = 15) {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (i >= tries || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(err.code)) throw err;
      await sleep(400);
    }
  }
}

function statePath(instanceDir) {
  return path.join(instanceDir, STATE_DIR, STATE_FILE);
}

async function writeState(instanceDir, state) {
  const file = statePath(instanceDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
  await renameRetry(tmp, file, 5);
}

async function readState(instanceDir) {
  try {
    return JSON.parse(await fsp.readFile(statePath(instanceDir), 'utf8'));
  } catch {
    return null;
  }
}

// Nombre del archivo desactivado para "x.jar" (si ya existe "x.jar.disabled" se usa otro)
async function disabledName(dir, file) {
  const first = `${file}.disabled`;
  if (!(await exists(path.join(dir, first)))) return first;
  for (let i = 0; i < 50; i++) {
    const alt = `${file}.bisect${i ? `-${i}` : ''}.disabled`;
    if (!(await exists(path.join(dir, alt)))) return alt;
  }
  throw new Error(`No se pudo desactivar ${file}`);
}

/**
 * Deja la carpeta mods como estaba segun el estado guardado. Sirve al terminar, al cancelar y al abrir
 * el launcher si quedo una busqueda a medias. Devuelve { restored, failed: [archivos] }.
 */
async function restoreFromState(instanceDir, state) {
  const st = state || (await readState(instanceDir));
  if (!st) return { restored: 0, failed: [] };
  const modsDir = path.join(instanceDir, 'mods');
  let restored = 0;
  const failed = [];
  for (const file of st.original || []) {
    if (typeof file !== 'string' || file !== path.basename(file)) continue;
    const target = path.join(modsDir, file);
    if (await exists(target)) continue;
    const candidates = [st.renamed?.[file], `${file}.disabled`, `${file}.bisect.disabled`].filter(Boolean);
    let done = false;
    let found = false;
    for (const c of candidates) {
      if (c !== path.basename(c)) continue;
      const from = path.join(modsDir, c);
      if (await exists(from)) {
        found = true;
        try {
          await renameRetry(from, target);
          restored++;
          done = true;
        } catch {
          /* se intenta con el siguiente nombre */
        }
        break;
      }
    }
    // Si ya no esta con ningun nombre, lo quito o lo reemplazo otra cosa: no hay nada que reactivar. Contarlo
    // como fallido dejaria el estado para siempre y cada inicio volveria a pisar options.txt con la copia.
    if (!done && found && !(await exists(target))) failed.push(file);
  }
  // Opciones del juego (atajos de teclado de mods desactivados, etc.)
  const backup = path.join(instanceDir, STATE_DIR, BACKUP_DIR);
  for (const name of OPTION_FILES) {
    const src = path.join(backup, name);
    if (await exists(src)) {
      try {
        await fsp.copyFile(src, path.join(instanceDir, name));
      } catch {
        /* sin permiso: se deja la copia */
      }
    }
  }
  if (!failed.length) {
    await fsp.rm(statePath(instanceDir), { force: true }).catch(() => {});
    await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
  }
  return { restored, failed };
}

class ModSwitcher {
  constructor(instanceDir, originalEnabled, meta = {}) {
    this.dir = instanceDir;
    this.modsDir = path.join(instanceDir, 'mods');
    this.original = [...originalEnabled];
    this.renamed = {};
    this.meta = meta;
  }

  async save() {
    await writeState(this.dir, { version: 1, ...this.meta, savedAt: Date.now(), original: this.original, renamed: this.renamed });
  }

  // Primero se guarda el estado y la copia de las opciones; recien despues se toca algun archivo
  async begin() {
    if (await readState(this.dir)) await restoreFromState(this.dir);
    await this.save();
    const backup = path.join(this.dir, STATE_DIR, BACKUP_DIR);
    await fsp.mkdir(backup, { recursive: true });
    for (const name of OPTION_FILES) {
      const src = path.join(this.dir, name);
      if (await exists(src)) await fsp.copyFile(src, path.join(backup, name)).catch(() => {});
    }
  }

  // Deja activos exactamente los mods de "enabled" (entre los que estaban activos al empezar)
  async apply(enabled) {
    const want = enabled instanceof Set ? enabled : new Set(enabled);
    let changed = 0;
    for (const file of this.original) {
      const on = path.join(this.modsDir, file);
      if (want.has(file)) {
        if (await exists(on)) continue;
        const off = this.renamed[file] || `${file}.disabled`;
        if (await exists(path.join(this.modsDir, off))) {
          await renameRetry(path.join(this.modsDir, off), on);
          delete this.renamed[file];
          changed++;
        }
      } else if (await exists(on)) {
        const off = await disabledName(this.modsDir, file);
        this.renamed[file] = off;
        await this.save();
        await renameRetry(on, path.join(this.modsDir, off));
        changed++;
      }
    }
    if (changed) await this.save();
    return changed;
  }

  async restore() {
    return restoreFromState(this.dir, { original: this.original, renamed: this.renamed });
  }
}

// Busca instancias con una busqueda a medias (el launcher se cerro de golpe) y las deja como estaban
async function recoverAll(instancesDir) {
  const out = [];
  let entries = [];
  try {
    entries = await fsp.readdir(instancesDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(instancesDir, e.name);
    if (!fs.existsSync(statePath(dir))) continue;
    const st = await readState(dir);
    const res = await restoreFromState(dir, st);
    out.push({ instanceId: e.name, ...res, startedAt: st?.startedAt || null });
  }
  return out;
}

// Dependencias faltantes informadas por el loader al probar (para aprenderlas)
function missingFrom(text) {
  const out = [];
  const fab = parse.parseFabricResolution(text);
  for (const d of fab.details) if (d.kind === 'missing') out.push({ requester: d.mod.id, dependency: d.dep.id });
  for (const d of parse.parseForgeDeps(text)) if (d.actual === null) out.push({ requester: d.requestedBy, dependency: d.modId });
  return out;
}

/**
 * Corre una prueba del juego.
 * deps: { game (core/game), getLaunch: async () => ({ account, settings, launcherVersion }) }
 * opts: { instanceId, stableMs, idleMs, firstTimeoutMs }
 */
function createGameRunner(deps, opts) {
  const { game, getLaunch } = deps;
  const instanceId = opts.instanceId;
  const STABLE = opts.stableMs ?? 10000;
  const IDLE = opts.idleMs ?? 5 * 60 * 1000;
  const TICK = opts.tickMs ?? 1000;
  const FAIL_GRACE = opts.failGraceMs ?? 8000;
  let maxSuccessMs = 0;
  let manual = null; // ronda manual en curso: { answer(works), relaunch(), closed }

  const timeoutFor = () => (maxSuccessMs ? Math.max(3 * 60 * 1000, 3 * maxSuccessMs) : opts.firstTimeoutMs ?? 12 * 60 * 1000);

  async function launch() {
    const { account, settings, launcherVersion } = await getLaunch();
    await game.start(instanceId, { account, settings, skipChecks: true, launcherVersion, quiet: true });
  }

  // Modo automatico: ¿llega al menu principal sin crashear?
  function crashRound({ signal, onGame } = {}) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const lines = [];
      let done = false;
      let failedAt = 0;
      let atlasAt = 0;
      let soundAt = 0;
      let legacyAt = 0;
      let lastMarker = 0;
      let lastLine = Date.now();
      let running = false;
      let stopReason = null;
      let stopAt = 0;
      let passed = false;
      let exitCode = null;

      const finish = (res) => {
        if (done) return;
        done = true;
        clearInterval(timer);
        game.events.off('log', onLog);
        game.events.off('state', onState);
        signal?.removeEventListener('abort', onAbort);
        resolve({ ms: Date.now() - startedAt, code: exitCode, lines: lines.slice(-300), ...res });
      };
      const stop = (reason) => {
        if (stopReason) return;
        stopReason = reason;
        stopAt = Date.now();
        onGame?.('stopping');
        if (!game.stop(instanceId)) setTimeout(() => decide(), 1500);
      };
      const decide = () => {
        if (stopReason === 'cancel') return finish({ cancelled: true });
        if (passed) {
          maxSuccessMs = Math.max(maxSuccessMs, Date.now() - startedAt);
          return finish({ pass: true, kind: 'menu' });
        }
        const text = lines.join('\n');
        const missing = missingFrom(text);
        if (missing.length) return finish({ pass: false, kind: 'dependency', missing });
        if (stopReason === 'timeout') return finish({ pass: false, kind: 'timeout' });
        return finish({ pass: false, kind: failedAt ? 'crash' : 'exit' });
      };
      const onLog = (id, ls) => {
        if (id !== instanceId || done) return;
        const now = Date.now();
        lastLine = now;
        for (const l of ls) {
          const text = String(l?.text ?? l ?? '');
          for (const piece of text.split(/\r?\n/)) {
            lines.push(piece);
            if (!failedAt && FAILURE.some((re) => re.test(piece))) failedAt = now;
            if (parse.MENU_MARKERS.atlas.test(piece)) {
              atlasAt = atlasAt || now;
              lastMarker = now;
            } else if (parse.MENU_MARKERS.sound.test(piece)) {
              soundAt = soundAt || now;
              lastMarker = now;
            } else if (parse.MENU_MARKERS.legacyDone.test(piece)) {
              legacyAt = legacyAt || now;
              lastMarker = now;
            }
          }
        }
        if (lines.length > 6000) lines.splice(0, lines.length - 4000);
      };
      const onState = (id, st) => {
        if (id !== instanceId || done) return;
        if (st.state === 'running') {
          running = true;
          lastLine = Date.now();
          onGame?.('running');
        } else if (st.state === 'crashed' || st.state === 'stopped') {
          exitCode = st.code ?? null;
          running = false;
          onGame?.('closed');
          if (st.state === 'stopped' && st.error && !stopReason) {
            // No se pudo preparar/lanzar
            return finish({ error: new Error(st.error) });
          }
          decide();
        }
      };
      const onAbort = () => {
        if (running) stop('cancel');
        else finish({ cancelled: true });
      };
      const tick = () => {
        if (done) return;
        const now = Date.now();
        if (stopReason) {
          // El proceso no termino despues de pedir que se cierre
          if (now - stopAt > 25000) decide();
          return;
        }
        if (!running) {
          if (now - startedAt > timeoutFor() + 5 * 60 * 1000) finish({ pass: false, kind: 'timeout' });
          return;
        }
        if (failedAt) {
          // Dejar que escriba el crash report; despues cerrar (Forge muestra una pantalla de error y no se cierra solo)
          if (now - failedAt > FAIL_GRACE) stop('failure');
          return;
        }
        // Forge viejo (1.12 o antes) crea el atlas antes de terminar de cargar los mods: ahi manda su propio aviso
        const ready = opts.legacyForge ? legacyAt : legacyAt || (atlasAt && (soundAt || now - atlasAt > 8000));
        if (ready && now - lastMarker >= STABLE) {
          passed = true;
          stop('success');
          return;
        }
        if (now - startedAt > timeoutFor() || now - lastLine > IDLE) stop('timeout');
      };
      const timer = setInterval(tick, TICK);
      game.events.on('log', onLog);
      game.events.on('state', onState);
      if (signal?.aborted) return finish({ cancelled: true });
      signal?.addEventListener('abort', onAbort, { once: true });
      onGame?.('launching');
      launch().catch((err) => finish({ error: err }));
    });
  }

  // Modo manual: el usuario prueba el juego y responde si el problema sigue (un crash cuenta como "sigue")
  function manualRound({ signal, onGame } = {}) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const lines = [];
      let done = false;
      let running = false;
      let answer = null;
      let stopping = false;

      const finish = (res) => {
        if (done) return;
        done = true;
        manual = null;
        game.events.off('state', onState);
        game.events.off('log', onLog);
        signal?.removeEventListener('abort', onAbort);
        resolve({ ms: Date.now() - startedAt, lines: lines.slice(-300), ...res });
      };
      const afterExit = () => {
        if (answer === 'cancel') return finish({ cancelled: true });
        if (answer !== null) return finish({ pass: answer, kind: 'answer' });
      };
      const onLog = (id, ls) => {
        if (id !== instanceId || done) return;
        for (const l of ls) lines.push(...String(l?.text ?? l ?? '').split(/\r?\n/));
        if (lines.length > 6000) lines.splice(0, lines.length - 4000);
      };
      const onState = (id, st) => {
        if (id !== instanceId || done) return;
        if (st.state === 'running') {
          running = true;
          onGame?.('running');
          return;
        }
        if (st.state !== 'crashed' && st.state !== 'stopped') return;
        running = false;
        onGame?.('closed');
        if (stopping || answer !== null) return afterExit();
        if (st.state === 'stopped' && st.error) return finish({ error: new Error(st.error) });
        if (st.state === 'crashed') {
          const missing = missingFrom(lines.join('\n'));
          if (missing.length) return finish({ pass: false, kind: 'dependency', missing });
          return finish({ pass: false, kind: 'crash' });
        }
        // Lo cerro el usuario: se sigue esperando la respuesta (puede volver a abrirlo)
      };
      const respond = (value) => {
        if (done || answer !== null) return;
        answer = value;
        if (running) {
          stopping = true;
          onGame?.('stopping');
          if (!game.stop(instanceId)) afterExit();
          setTimeout(() => afterExit(), 25000);
        } else afterExit();
      };
      const onAbort = () => respond('cancel');
      manual = {
        answer: (works) => respond(Boolean(works)),
        relaunch: async () => {
          if (done || running) return false;
          onGame?.('launching');
          await launch();
          return true;
        },
        get running() {
          return running;
        },
      };
      game.events.on('state', onState);
      game.events.on('log', onLog);
      if (signal?.aborted) return finish({ cancelled: true });
      signal?.addEventListener('abort', onAbort, { once: true });
      onGame?.('launching');
      launch().catch((err) => finish({ error: err }));
    });
  }

  return {
    crashRound,
    manualRound,
    answer: (works) => {
      if (!manual) return false;
      manual.answer(works);
      return true;
    },
    relaunch: () => (manual ? manual.relaunch() : Promise.resolve(false)),
    get waiting() {
      return Boolean(manual);
    },
  };
}

module.exports = { ModSwitcher, createGameRunner, restoreFromState, recoverAll, readState, statePath, missingFrom, FAILURE, OPTION_FILES };
