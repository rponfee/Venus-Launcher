'use strict';
// Estado de los servicios: decide si un error parece de la red o de un servicio (para ofrecer el panel o
// comprobar solo) y qué servicios están involucrados. Sin Electron: los textos traducidos de los errores del
// launcher (plantillas con {variables}) se inyectan, así funciona en cualquier idioma.
const { IDS, groupOf } = require('./services');

const LOGIN_IDS = Object.freeze(['microsoft', 'xbox', 'minecraftServices']);
// Errores al iniciar sesión que son de la cuenta (o del usuario), no de la red: no se consulta nada.
const ACCOUNT_CODES = new Set(['cancelled', 'codeExpired', 'invalidName', 'notFound', 'noAccount', 'noGame', 'noProfile', 'noProfileOrGame', 'mcRateLimited']);
// Errores al iniciar sesión que ya prueban que el servicio falló de su lado (core/accounts): un 5xx en el texto
// ("error 503") o un error de servidor de OAuth. Un HEAD a la raíz de ese host puede contestar bien igual (el
// balanceador anda y el servicio de atrás no), así que no se consulta nada: el veredicto ya se sabe.
const LOGIN_SERVICE = { msUnavailable: 'microsoft', msRejected: 'microsoft', xblFailed: 'xbox', xstsFailed: 'xbox', mcLoginFailed: 'minecraftServices', profileFailed: 'minecraftServices' };
const SERVER_SIDE = /\b5\d\d\b|\bserver_error\b|\btemporarily_unavailable\b/i;

// Host que aparece en el error -> servicio que lo cubre.
const HOSTS = [
  [/(^|\.)(login\.live\.com|login\.microsoftonline\.com)$/, 'microsoft'],
  [/(^|\.)xboxlive\.com$/, 'xbox'],
  [/(^|\.)minecraftservices\.com$/, 'minecraftServices'],
  [/^(piston-meta|piston-data|launchermeta|launcher)\.mojang\.com$/, 'mojangMeta'],
  [/^libraries\.minecraft\.net$/, 'mojangLibraries'],
  [/^resources\.download\.minecraft\.net$/, 'mojangAssets'],
  [/(^|\.)modrinth\.com$/, 'modrinth'],
  [/(^|\.)(curseforge\.com|forgecdn\.net)$/, 'curseforge'],
  [/\.supabase\.co$/, 'venus'],
];

const NET_CODES = /\b(ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|EAI_AGAIN|EAI_FAIL|ENETUNREACH|EHOSTUNREACH|ENETDOWN|EPIPE|UND_ERR_[A-Z_]+|CERT_[A-Z_]+|SELF_SIGNED_CERT[A-Z_]*|UNABLE_TO_(?:GET|VERIFY)_[A-Z_]+|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z_]+)\b/;
// También las excepciones de red de Java (el instalador de Forge o NeoForge baja archivos en sus procesadores)
// y el tiempo agotado de AbortSignal.timeout(). Son nombres de clases y mensajes fijos: no aparecen en otros errores.
const NET_WORDS = /socket hang up|fetch failed|getaddrinfo|network error|network is unreachable|aborted due to timeout|java\.net\.(?:UnknownHostException|SocketTimeoutException|ConnectException|NoRouteToHostException|SocketException)|javax\.net\.ssl\.SSL\w*Exception/i;
const HTTP_5XX = /\bHTTP\s*5\d\d\b/i;
// "HTTP 503 en https://cdn.modrinth.com/..." (storage.errHttp en cualquier idioma): ese host contestó con un 5xx.
// En turco va al revés ("{url} adresinde HTTP {status}"): se buscan los dos órdenes.
const HTTP_5XX_URL = [/\bHTTP\s*5\d\d\b[^\n]{0,24}?https?:\/\/([a-z0-9.-]{1,253})/gi, /https?:\/\/([a-z0-9.-]{1,253})[^\s]{0,300}[^\n]{0,24}?\bHTTP\s*5\d\d\b/gi];
const HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}\b/gi;
const MAX_TEXT = 2000;

const NONE = Object.freeze({ network: false, offline: false, autoCheck: false, ids: [], focus: null });

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 'No se pudo conectar con {host} ({error}).' -> /No se pudo conectar con [\s\S]*? \([\s\S]*?\)\./i
// Plantillas casi sin texto fijo (menos de 8 letras) se descartan: atraparían cualquier cosa.
function templateRegex(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const parts = text.split(/\{\w+\}/);
  const fixed = parts.join('').replace(/[^\p{L}]/gu, '');
  if (fixed.length < 8) return null;
  try {
    return new RegExp(parts.map(escapeRe).join('[\\s\\S]{0,400}?'), 'iu');
  } catch {
    return null;
  }
}

function compile(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const re = templateRegex(item && item.text);
    if (re) out.push({ re, offline: Boolean(item.offline), ids: Array.isArray(item.ids) ? item.ids.filter((id) => IDS.includes(id)) : [] });
  }
  return out;
}

function servicesInText(text) {
  const found = new Set();
  for (const host of text.match(HOST_RE) || []) {
    const h = host.toLowerCase();
    for (const [re, id] of HOSTS) if (re.test(h)) found.add(id);
  }
  return found;
}

// templates: [{ text, offline?, ids? }] (errores de red del launcher, en el idioma actual y de respaldo).
// disk: [texto] (errores de disco: no son de la red aunque digan "No se pudo descargar").
function createClassifier({ templates = [], disk = [] } = {}) {
  const net = compile(templates);
  const diskRes = compile(disk.map((text) => ({ text })));

  // info: { source: 'login' | 'task', code?, text? } -> { network, offline, autoCheck, ids, focus, known? }
  //  network    vale la pena mostrar el estado de los servicios
  //  autoCheck  comprobar solo, enseguida (únicamente después de un error al iniciar sesión)
  //  known      { kind: 'down', ids } cuando el error ya dice qué servicio falló de su lado: al iniciar sesión no
  //             se consulta nada; en una tarea el panel lo recibe (failed) para no contradecir al error
  return function classify(info) {
    const o = info && typeof info === 'object' ? info : {};
    const code = typeof o.code === 'string' ? o.code.slice(0, 64) : '';
    const text = typeof o.text === 'string' ? o.text.slice(0, MAX_TEXT) : '';
    if (o.source === 'login') {
      const account = ACCOUNT_CODES.has(code) || /^xerr_\d+$/.test(code);
      if (account) return { ...NONE, ids: [] };
      const svc = Object.prototype.hasOwnProperty.call(LOGIN_SERVICE, code) ? LOGIN_SERVICE[code] : null;
      if (svc && (code === 'msUnavailable' || SERVER_SIDE.test(text))) {
        return { network: true, offline: false, autoCheck: false, ids: [svc], focus: 'login', known: { kind: 'down', ids: [svc] } };
      }
      return { network: true, offline: false, autoCheck: true, ids: [...LOGIN_IDS], focus: 'login' };
    }
    if (!text.trim()) return { ...NONE, ids: [] };
    if (diskRes.some((d) => d.re.test(text))) return { ...NONE, ids: [] };
    let network = NET_CODES.test(text) || NET_WORDS.test(text) || HTTP_5XX.test(text);
    let offline = false;
    const ids = servicesInText(text);
    for (const tp of net) {
      if (!tp.re.test(text)) continue;
      network = true;
      if (tp.offline) offline = true;
      tp.ids.forEach((id) => ids.add(id));
    }
    if (!network) return { ...NONE, ids: [] };
    const ordered = IDS.filter((id) => ids.has(id));
    const out = { network: true, offline, autoCheck: false, ids: ordered, focus: ordered.length ? groupOf(ordered[0]) : 'downloads' };
    // Un servicio que contestó con 5xx en esta tarea falló de su lado aunque después su raíz conteste bien: el
    // panel lo recibe (failed) para no decir "Todo responde bien" justo después de ese error.
    const failed = new Set();
    for (const re of HTTP_5XX_URL) for (const m of text.matchAll(re)) servicesInText(m[1]).forEach((id) => failed.add(id));
    const failedIds = IDS.filter((id) => failed.has(id));
    if (failedIds.length) out.known = { kind: 'down', ids: failedIds };
    return out;
  };
}

module.exports = { createClassifier, templateRegex, LOGIN_IDS, ACCOUNT_CODES };
