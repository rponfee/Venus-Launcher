'use strict';
// Soporte: consultas con el equipo de Venus, con la identidad de la sesión; los permisos se verifican en Supabase.
// Canales: support:call (action, payload) con todas las acciones de support/client.js, support:fakeMode,
//          support:diagnostic ({ instanceId, lines, ids }) -> diagnóstico para adjuntar, ya sin datos personales,
//          support:upload ({ ticketId, bytes, name }) -> sube una captura, support:attachment ({ attachmentId }) -> la baja.
//          Los viejos support:list / create / detail / reply / resolve siguen.
// Evento:  support:changed ({ action }) cuando la persona cambia algo.
// Modo de capturas (VENUS_DEVSHOT + VENUS_SUPPORT_FAKE=customer|staff|empty, nunca empaquetada): datos de ejemplo en memoria.
const os = require('os');
const fsp = require('fs/promises');
const path = require('path');
const secure = require('../core/secure');
const { createSupportClient, coded } = require('./support/client');
const { safeName } = require('./support/images');
const diag = require('./support/diagnostics');

const SESSION_KEY = 'ui:sb.venus-auth';
const CHANGING = new Set(['create', 'reply', 'resolve', 'closeOwn', 'reopen', 'rate', 'markSeen', 'diagnostic', 'attach', 'assign', 'priority', 'note']);
const CACHE_MS = 60000;
let sendToUi = () => {};
let refreshing = null;
let client = null;
let fake = null;
let electronApp = null;
let cache = null;

// Instalación de ejemplo para el diagnóstico de las capturas: nada de esto sale de la PC real.
const FAKE_RAW = {
  app: { version: '4.6.0', electron: '44.0.0', packaged: true, portable: false, osName: 'Windows 11 (10.0.26200)', arch: 'x64', language: 'es' },
  system: { totalMemMb: 16384, freeMemMb: 7212, cpu: 'AMD Ryzen 5 5600 6-Core Processor', cores: 12, gpu: 'NVIDIA GeForce RTX 3060' },
  java: { requiredMajor: 21, selectedPath: 'C:\\Users\\Mateo\\.jdks\\jdk-21\\bin\\javaw.exe', selected: { version: '21.0.4', vendor: 'Eclipse Adoptium' }, installed: [17, 21],
    jvmArgs: '-Xmx4G -Dfile.encoding=UTF-8 -Djava.library.path=C:\\Users\\Mateo\\AppData\\Roaming\\.venuslauncher\\natives' },
  instance: { mcVersion: '1.21.1', loader: 'fabric', loaderVersion: '0.16.5', memoryMb: 4096, mods: { total: 43, enabled: 38 },
    modFiles: ['fabric-api-0.102.0.jar', 'lithium-0.13.0.jar', 'sodium-0.6.0.jar', 'iris-1.8.0.jar.disabled', 'modmenu-11.0.1.jar'] },
  log: { lines: [
    '[14:02:11] [main/INFO]: Loading Minecraft 1.21.1 with Fabric Loader 0.16.5',
    '[14:02:12] [main/INFO]: Setting user: MateoBuilds',
    '[14:02:14] [main/INFO]: Loaded resource pack C:\\Users\\Mateo\\AppData\\Roaming\\.venuslauncher\\instances\\demo\\resourcepacks\\Faithful.zip',
    '[14:02:19] [Render thread/INFO]: Connecting to 192.168.1.35, 25565',
    '[14:02:20] [Render thread/INFO]: [CHAT] <MateoBuilds> mi correo es mateo@example.com',
    '[14:02:23] [Render thread/ERROR]: Failed to load mod config D:\\Juegos\\MC 2026\\mods\\sodium-0.6.0.jar',
    '[14:02:23] [main/ERROR]: Crash report saved to C:\\Users\\Mateo\\AppData\\Roaming\\.venuslauncher\\instances\\demo\\crash-reports\\crash-2026-11-04_14.02.23-client.txt',
  ] },
};
const FAKE_REDACTOR = { homedir: 'C:\\Users\\Mateo', username: 'Mateo', hostname: 'DESKTOP-MATEO1', players: ['MateoBuilds'], dataDir: 'C:\\Users\\Mateo\\AppData\\Roaming\\.venuslauncher' };
const FAKE_INSTANCES = [{ id: 'demo', name: 'Supervivencia 1.21.1', mcVersion: '1.21.1', loader: 'fabric' }];

function fakeMode() {
  const scenario = process.env.VENUS_SUPPORT_FAKE;
  if (!process.env.VENUS_DEVSHOT || !['customer', 'staff', 'empty'].includes(scenario)) return null;
  try {
    return require('electron').app.isPackaged ? null : scenario;
  } catch {
    return null;
  }
}

async function storedSession() {
  const raw = await secure.get(SESSION_KEY);
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}
const fresh = (s) => s?.access_token && (!s.expires_at || s.expires_at * 1000 - Date.now() > 60000);
async function accessToken(expectedOwner) {
  const session = await storedSession();
  if (!expectedOwner || session?.user?.id !== expectedOwner) throw coded('noSession', 'La cuenta cambió. Volvé a abrir Soporte para continuar.');
  if (fresh(session)) return session.access_token;
  if (!session?.access_token) throw coded('noSession', 'Iniciá sesión con tu cuenta de Venus para contactar a soporte.');
  if (!refreshing) refreshing = (async () => {
    sendToUi('cloud:refreshSession');
    for (let i = 0; i < 25; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const next = await storedSession();
      if (next?.user?.id !== expectedOwner) throw coded('noSession', 'La cuenta cambió. Volvé a abrir Soporte para continuar.');
      if (fresh(next)) return next.access_token;
    }
    throw coded('noSession', 'Tu sesión venció. Volvé a iniciar sesión.');
  })().finally(() => { refreshing = null; });
  const token = await refreshing;
  if ((await storedSession())?.user?.id !== expectedOwner) throw coded('noSession', 'La cuenta cambió. Volvé a abrir Soporte para continuar.');
  return token;
}
function getClient() {
  return client ||= createSupportClient({ fetch: (...args) => fetch(...args), cloudConfig: () => require('../core/cloud-defaults').config(), accessToken });
}

// ---------- Diagnóstico ----------
function deps() {
  const app = electronApp;
  return {
    app: { version: app.getVersion(), electron: process.versions.electron, packaged: app.isPackaged, portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR), language: require('../core/i18n').getLanguage?.() },
    os, fsp, path,
    java: require('../core/java'), instances: require('../core/instances'), settings: require('../core/settings'), accounts: require('../core/accounts'),
    gpu: async () => {
      const info = await app.getGPUInfo('basic');
      const dev = (info?.gpuDevice || []).find((d) => d.active) || info?.gpuDevice?.[0];
      return dev?.deviceString || ({ 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x8086: 'Intel' })[dev?.vendorId] || '';
    },
  };
}
async function newRedactor() {
  if (fake) return diag.createSupportRedactor(FAKE_REDACTOR);
  return diag.createSupportRedactor({ players: await diag.playerNames(deps()), dataDir: require('../core/paths').root() });
}

async function diagnostic(opts = {}) {
  const lines = diag.pickLines(opts.lines);
  const list = fake ? FAKE_INSTANCES : (await require('../core/instances').list().catch(() => [])).map((i) => ({ id: i.id, name: i.name, mcVersion: i.mcVersion, loader: i.loader }));
  const instanceId = list.find((i) => i.id === opts.instanceId)?.id || list[0]?.id || null;
  const key = `${instanceId}|${lines}`;
  if (!cache || cache.key !== key || opts.refresh || Date.now() - cache.at > CACHE_MS) {
    const raw = fake ? { ...FAKE_RAW, app: { ...FAKE_RAW.app, language: require('../core/i18n').getLanguage?.() || 'es' } } : await diag.collectRaw(deps(), { instanceId, logLines: lines });
    cache = { key, at: Date.now(), sections: diag.buildSections(raw, await newRedactor()) };
  }
  const have = cache.sections.map((s) => s.id);
  const selected = Array.isArray(opts.ids) ? opts.ids.filter((id) => have.includes(id)) : diag.defaultIds(cache.sections);
  const out = diag.assemble(cache.sections, selected);
  return {
    instances: list, instanceId, lines, linesChoices: diag.LOG_CHOICES, limit: 12000,
    sections: cache.sections.map((s) => ({ id: s.id, chars: s.text.length, on: s.on })), selected,
    text: out.text, chars: out.text.length, truncated: out.truncated, redactions: out.redactions,
  };
}

// ---------- Llamadas ----------
async function call(action, payload) {
  if (fake) {
    const result = await fake.call(action, payload);
    if (CHANGING.has(action)) sendToUi('support:changed', { action });
    return result;
  }
  const owner = (await storedSession())?.user?.id || null;
  let body = payload;
  // Segunda pasada: lo que llegue como diagnóstico se anonimiza otra vez antes de salir de la PC (es idempotente).
  if (['create', 'diagnostic'].includes(action) && typeof payload?.diagnostic === 'string' && payload.diagnostic) {
    body = { ...payload, diagnostic: diag.finalize(payload.diagnostic, await newRedactor()) };
  }
  const result = await getClient().call(action, body, owner);
  if ((await storedSession())?.user?.id !== owner) throw coded('noSession', 'La cuenta cambió. Volvé a abrir Soporte para continuar.');
  if (CHANGING.has(action)) sendToUi('support:changed', { action });
  return result;
}

async function upload({ ticketId, bytes, name } = {}) {
  if (fake) return { ...(await fake.upload({ ticketId })), name: safeName(name) };
  const owner = (await storedSession())?.user?.id || null;
  const done = await getClient().upload({ ticketId, bytes }, owner);
  if ((await storedSession())?.user?.id !== owner) throw coded('noSession', 'La cuenta cambió. Volvé a abrir Soporte para continuar.');
  return { ...done, name: safeName(name) };
}

async function attachment({ attachmentId } = {}) {
  if (fake) return fake.download();
  const owner = (await storedSession())?.user?.id || null;
  const info = await getClient().call('attachmentInfo', { attachmentId }, owner);
  const file = await getClient().download(info?.path, owner);
  return { dataUrl: `data:${file.mime};base64,${file.bytes.toString('base64')}`, mime: file.mime, name: safeName(info?.name), size: file.bytes.length };
}

function register({ app, handle, send }) {
  sendToUi = send;
  electronApp = app;
  const scenario = fakeMode();
  if (scenario) {
    fake = require('./support/fake').createFake(scenario);
    console.warn(`[support] Modo de capturas (VENUS_SUPPORT_FAKE=${scenario}): consultas de ejemplo, sin servidor.`);
  }
  handle('support:fakeMode', () => scenario);
  handle('support:call', call);
  for (const action of ['list', 'create', 'reply', 'resolve']) handle(`support:${action}`, (payload) => call(action, payload));
  handle('support:detail', (ticketId) => call('detail', { ticketId }));
  handle('support:diagnostic', (opts) => diagnostic(opts && typeof opts === 'object' ? opts : {}));
  handle('support:upload', (opts) => upload(opts && typeof opts === 'object' ? opts : {}));
  handle('support:attachment', (opts) => attachment(opts && typeof opts === 'object' ? opts : {}));
}
module.exports = { register, call, diagnostic };
