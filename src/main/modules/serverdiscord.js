'use strict';
// Avisos de cada servidor local por un webhook de Discord: se prendió, se apagó, se cayó, entró o salió un jugador y
// copia lista. Apagado hasta que el usuario pega un webhook en ese servidor. El webhook va cifrado con core/secure
// (safeStorage; sin almacén del sistema queda solo en memoria hasta cerrar) y nunca vuelve a la interfaz: solo su máscara.
//   serverdiscord:get(id)                       -> { configured, masked, enabled, events, canEncrypt, lastError, lastSentAt, queued }
//   serverdiscord:set(id, { url?, enabled?, events? }) -> lo mismo (url inválida: Error con code 'invalid')
//   serverdiscord:remove(id) · serverdiscord:test(id) -> { ok } (lanza con el motivo traducido)
//   evento serverdiscord:changed -> (id)
// Escucha servers.events: 'state', 'player' y 'backup' (este último lo emite serverx/world.js).
const servers = require('../core/servers');
const secure = require('../core/secure');
const http = require('../core/http');
const { t } = require('../core/i18n');
const hook = require('./serverdiscord/webhook');

const SECRET = (id) => `serverdiscord.webhook.${id}`;
const queues = new Map(); // id -> { queue, url }
const lastState = new Map(); // id -> último estado visto (el evento 'state' también llega cuando cambian los jugadores)
const wasOnline = new Set(); // ids que llegaron a estar en línea: un arranque cancelado no avisa "se apagó"
const runtime = new Map(); // id -> { lastError, lastSentAt }
let notify = () => {};
let canEncrypt = () => false;
let pending = Promise.resolve();

const config = (s) => ({ enabled: s.discordNotify?.enabled === true, events: hook.normalizeEvents(s.discordNotify?.events) });

async function post(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'VenusLauncher' },
    body: JSON.stringify(payload),
    redirect: 'error', // el webhook es un secreto: no sigue a ningún otro lado
    signal: AbortSignal.timeout(10000),
  });
  return hook.readResponse(res);
}

function setRuntime(id, patch) {
  runtime.set(id, { ...(runtime.get(id) || {}), ...patch });
  notify('serverdiscord:changed', id);
}

function queueFor(id, url) {
  const cur = queues.get(id);
  if (cur?.url === url) return cur.queue;
  cur?.queue.clear();
  const queue = hook.createQueue({
    send: (payload) => post(url, payload),
    onResult({ ok, code }) {
      if (ok) setRuntime(id, { lastError: null, lastSentAt: Date.now() });
      else if (code !== 'cleared') {
        console.warn('[serverdiscord] aviso sin enviar:', code);
        setRuntime(id, { lastError: code });
      }
    },
  });
  queues.set(id, { queue, url });
  return queue;
}

async function storedUrl(id) {
  const raw = await secure.get(SECRET(id));
  return hook.parseWebhook(raw)?.url || null;
}

async function dispatch(id, kind, vars = {}) {
  if (http.isOffline?.()) return;
  const s = await servers.get(id);
  const cfg = config(s);
  if (!cfg.enabled || !cfg.events[kind]) return;
  const url = await storedUrl(id);
  if (!url) return;
  // enqueue no espera a Discord: esta función termina enseguida
  queueFor(id, url).enqueue(hook.buildMessage(kind, { server: s.name, player: vars.player }, t));
}

// Los eventos del servidor no esperan nada de esto y salen en orden
function schedule(id, kind, vars) {
  pending = pending.then(() => dispatch(id, kind, vars)).catch((err) => console.warn('[serverdiscord] evento:', err?.message || err));
}

function onState(id, st) {
  const prev = lastState.get(id) || 'offline';
  if (st.state === prev) return;
  lastState.set(id, st.state);
  if (st.state === 'online') {
    wasOnline.add(id);
    schedule(id, 'started');
  } else if (st.state === 'offline') {
    if (st.crashed || st.error) schedule(id, 'crashed');
    else if (wasOnline.has(id)) schedule(id, 'stopped');
    wasOnline.delete(id);
  }
}

async function view(id) {
  const s = await servers.get(id);
  const parsed = hook.parseWebhook(await secure.get(SECRET(id)));
  const rt = runtime.get(id) || {};
  return {
    configured: Boolean(parsed),
    masked: parsed ? hook.maskWebhook(parsed.id) : '',
    canEncrypt: canEncrypt(),
    lastError: rt.lastError || null,
    lastSentAt: rt.lastSentAt || null,
    queued: queues.get(id)?.queue.size() || 0,
    ...config(s),
  };
}

async function setConfig(id, patch = {}) {
  const s = await servers.get(id);
  if (patch.url !== undefined) {
    const parsed = hook.parseWebhook(patch.url);
    if (!parsed) throw Object.assign(new Error(t('serverremote.errWebhookInvalid')), { code: 'invalid' });
    await secure.set(SECRET(id), parsed.url);
    queues.get(id)?.queue.clear();
    queues.delete(id);
    runtime.delete(id);
  }
  const cur = config(s);
  const next = { enabled: typeof patch.enabled === 'boolean' ? patch.enabled : patch.url !== undefined ? true : cur.enabled, events: hook.normalizeEvents({ ...cur.events, ...(patch.events && typeof patch.events === 'object' ? patch.events : {}) }) };
  await servers.patchMeta(id, { discordNotify: next });
  return view(id);
}

async function forget(id) {
  queues.get(id)?.queue.clear();
  queues.delete(id);
  runtime.delete(id);
  lastState.delete(id);
  wasOnline.delete(id);
  await secure.remove(SECRET(id));
}

const TEST_WAIT_MS = 20000;
const TEST_ERRORS = { invalid: 'errWebhookRejected', rejected: 'errWebhookRejected', limit: 'errDiscordLimit', overflow: 'errDiscordLimit', retries: 'errDiscordFailed' };

// Prueba: va por la misma cola, así respeta los límites de Discord igual que un aviso real
async function test(id) {
  const s = await servers.get(id);
  const url = await storedUrl(id);
  if (!url) throw Object.assign(new Error(t('serverremote.errWebhookNone')), { code: 'none' });
  if (http.isOffline?.()) throw Object.assign(new Error(t('serverremote.errDiscordOffline')), { code: 'offline' });
  const queue = queueFor(id, url);
  queue.reset();
  // Si Discord tiene frenada la cola no se deja esperando al botón: el aviso igual sale cuando pueda
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, code: 'limit' }), TEST_WAIT_MS);
  });
  const res = await Promise.race([queue.enqueue(hook.buildMessage('test', { server: s.name }, t), { important: true }), late]);
  clearTimeout(timer);
  if (!res.ok) throw Object.assign(new Error(t(`serverremote.${TEST_ERRORS[res.code] || 'errDiscordFailed'}`)), { code: res.code });
  return { ok: true };
}

function register({ handle, send, onQuit }) {
  notify = (channel, ...args) => send(channel, ...args);
  canEncrypt = () => {
    try {
      const { safeStorage } = require('electron');
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };
  handle('serverdiscord:get', (id) => view(id));
  handle('serverdiscord:set', (id, patch) => setConfig(id, patch || {}));
  handle('serverdiscord:remove', async (id) => {
    await servers.get(id);
    await forget(id);
    await servers.patchMeta(id, { discordNotify: { ...config(await servers.get(id)), enabled: false } });
    return view(id);
  });
  handle('serverdiscord:test', (id) => test(id));

  servers.events.on('state', (id, st) => onState(id, st));
  servers.events.on('player', (id, ev) => {
    if (ev?.type === 'join' || ev?.type === 'leave') schedule(id, ev.type, { player: ev.name });
  });
  servers.events.on('backup', (id) => schedule(id, 'backup'));
  // Al cerrar se manda lo que se pueda: main.js espera como mucho 4 s a estos ganchos
  onQuit(async () => {
    await Promise.race([pending, new Promise((r) => setTimeout(r, 1500))]);
  });
}

module.exports = { register, forget };
