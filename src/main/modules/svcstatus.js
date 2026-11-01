'use strict';
// Estado de los servicios: cuando falla iniciar sesión o una descarga, dice si el problema es la conexión del
// jugador o un servicio caído (Microsoft/Xbox, Mojang, Modrinth, CurseForge o Venus).
// Privacidad: nunca consulta en segundo plano por su cuenta. Solo cuando el usuario abre el panel, o justo
// después de que falló iniciar sesión (y entonces solo los servicios de esa acción). Pedidos GET/HEAD sin
// cookies, tokens ni datos del usuario; respeta el modo sin conexión (core/http). Lógica pura en svcstatus/.
//
// Canales:
//  svcstatus:check({ ids?, connectivity?: 'always' | 'auto', failed?: ids }) -> { offlineMode, internet ('ok',
//      'down' o 'unknown'), internetReason, internetSlow, dns, checkedAt, nextCheckAt, cached,
//      results: [{ id, group, state ('ok', 'slow', 'down' o 'skipped'), ms, httpStatus?, reason?, detail?, dns?,
//      inferred? (solo la conexión: Cloudflare no contestó pero otros servicios sí), at? }], verdict: { kind, ids } }
//      Reusa resultados de menos de 20 s y nunca corre dos rondas a la vez. failed: servicios que el launcher acaba
//      de ver fallar de su lado (lo que dice classify en known); si ahora contestan bien igual, van como caídos con
//      motivo 'failed' (solo en esa respuesta).
//  svcstatus:classify({ source: 'login' | 'task', code?, text? }) -> { network, offline, autoCheck, ids, focus, known? }
//      (local, sin red: decide si un error amerita mostrar el estado de los servicios; known = { kind: 'down', ids }
//      cuando el error ya prueba que esos servicios fallaron de su lado: un 5xx al iniciar sesión, que entonces no
//      consulta nada, o un "HTTP 5xx en <url>" en una tarea).
const fs = require('fs');
const path = require('path');
const { createChecker } = require('./svcstatus/checker');
const { createClassifier, LOGIN_IDS } = require('./svcstatus/classify');
const { buildDefs } = require('./svcstatus/services');
const fake = require('./svcstatus/fake');

const I18N_DIR = path.join(__dirname, '..', 'i18n');

// Errores de red y de descarga del launcher (sus textos traducidos se usan como plantillas) y errores de disco.
// Los plurales van con todas sus formas (_few y _many existen en ruso, polaco y ucraniano; si falta, se saltea).
const NET_TEMPLATES = [
  ['storage', 'errOffline', { offline: true }],
  ['storage', 'errTimeout'],
  ['storage', 'errNetwork'],
  ['storage', 'errBadJson'],
  ['storage', 'errSomeFailed_one'],
  ['storage', 'errSomeFailed_few'],
  ['storage', 'errSomeFailed_many'],
  ['storage', 'errSomeFailed_other'],
  ['packs', 'errDownloadPack', { ids: ['modrinth'] }],
  ['packs', 'errDownloads_one'],
  ['packs', 'errDownloads_few'],
  ['packs', 'errDownloads_many'],
  ['packs', 'errDownloads_other'],
  ['loaders', 'errOptifineDownload'],
  ['accounts', 'network', { ids: LOGIN_IDS }],
  ['accounts', 'msUnavailable', { ids: ['microsoft'] }],
  ['modrinth', 'errNetwork', { ids: ['modrinth'] }],
  ['compat', 'errNetwork', { ids: ['modrinth'] }],
  ['smartsearch', 'errModrinth', { ids: ['modrinth'] }],
  ['curseforge', 'errNetwork', { ids: ['curseforge'] }],
  ['cloudsync', 'errNetwork', { ids: ['venus'] }],
  // La IA (traducción de mods, que corre como tarea) va por el servidor de Venus.
  ['ai', 'errNetwork', { ids: ['venus'] }],
  ['java', 'errOffline'],
];
const DISK_TEMPLATES = [
  ['storage', 'errNoSpace'],
  ['storage', 'errDiskAccess'],
  ['storage', 'errDisk'],
];

// Modo de capturas: solo con VENUS_DEVSHOT y sin empaquetar (nunca en la app que usa la gente).
function fakeScenario() {
  const name = fake.scenarioName(process.env.VENUS_SVCSTATUS_FAKE);
  if (!name || !process.env.VENUS_DEVSHOT) return null;
  try {
    return require('../core/app-config').devEnv() ? name : null;
  } catch {
    return null;
  }
}

let checker = null;
function getChecker() {
  if (checker) return checker;
  const http = require('../core/http');
  const scenario = fakeScenario();
  checker = createChecker({
    fetch: scenario ? fake.createFakeFetch(scenario) : (...args) => fetch(...args),
    isOffline: async () => {
      await http.loadSettings();
      return http.isOffline();
    },
    defs: () => {
      let cfKey = '';
      let cloud = null;
      try {
        cfKey = require('../core/app-config').get().curseforgeApiKey;
      } catch {
        cfKey = '';
      }
      try {
        cloud = require('../core/cloud-defaults').config();
      } catch {
        cloud = null;
      }
      return buildDefs({ curseforgeApiKey: cfKey, cloud, userAgent: http.getUserAgent() });
    },
  });
  return checker;
}

async function check(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const ids = Array.isArray(o.ids) ? o.ids.slice(0, 20) : null;
  const failed = Array.isArray(o.failed) ? o.failed.slice(0, 20) : null;
  return getChecker().check({ ids, connectivity: o.connectivity === 'auto' ? 'auto' : 'always', failed });
}

// Texto crudo de una clave (con sus {variables}) en un idioma, leído del diccionario del proceso principal.
function rawText(lang, ns, key) {
  if (!/^[a-z]{2}$/.test(lang)) return null;
  const file = path.join(I18N_DIR, lang, `${ns}.js`);
  try {
    if (!fs.existsSync(file)) return null;
    const dict = require(file);
    return dict && typeof dict[key] === 'string' ? dict[key] : null;
  } catch {
    return null;
  }
}

const classifiers = new Map(); // idioma -> clasificador
function getClassifier() {
  let lang = 'es';
  try {
    lang = require('../core/i18n').getLanguage() || 'es';
  } catch {
    lang = 'es';
  }
  if (classifiers.has(lang)) return classifiers.get(lang);
  const langs = [...new Set([lang, 'en', 'es'])];
  const templates = [];
  for (const [ns, key, extra] of NET_TEMPLATES) {
    for (const l of langs) {
      const text = rawText(l, ns, key);
      if (text) templates.push({ text, ...(extra || {}) });
    }
  }
  const disk = [];
  for (const [ns, key] of DISK_TEMPLATES) for (const l of langs) disk.push(rawText(l, ns, key));
  const fn = createClassifier({ templates, disk: disk.filter(Boolean) });
  classifiers.set(lang, fn);
  return fn;
}

function classify(info) {
  return getClassifier()(info);
}

function register({ handle }) {
  handle('svcstatus:check', (opts) => check(opts));
  handle('svcstatus:classify', (info) => classify(info));
  // Solo en el modo de capturas: una tarea que falla por la red, para ver el botón del panel de tareas.
  // { kind: 'http' }: falla con un 503 de la CDN de Modrinth (el panel lo marca aunque Modrinth conteste).
  if (fakeScenario()) {
    handle('svcstatus:devFailTask', (opts) => {
      const tasks = require('../core/tasks');
      const { t } = require('../core/i18n');
      const http = opts && opts.kind === 'http';
      const task = new tasks.Task(t('instances.taskInstalling', { name: http ? 'Fabulously Optimized' : 'Minecraft 1.21.4' }), {});
      const err = http
        ? t('storage.errSomeFailed', { count: 3, name: 'sodium-fabric-0.6.13.jar', error: t('storage.errHttp', { status: 503, url: 'https://cdn.modrinth.com/data/AANobbMI/versions/sodium-fabric-0.6.13.jar' }) })
        : t('storage.errNetwork', { host: 'piston-meta.mojang.com', error: 'ENOTFOUND' });
      setTimeout(() => task.fail(new Error(err)), 400);
      return { id: task.id };
    });
  }
}

module.exports = { register, check, classify };
