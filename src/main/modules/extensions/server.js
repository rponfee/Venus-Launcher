'use strict';
// Lógica del protocolo venus-ext:// (sin Electron: la prueba Node puro). Decide qué se sirve y con qué encabezados.
//   venus-ext://<id>/<página>.html?t=<ficha>   documento: exige una ficha de un solo uso que entrega el launcher
//   venus-ext://<id>/<archivo>                 scripts, estilos e imágenes de esa misma extensión
// Una página HTML sin ficha no se sirve, así una extensión no puede abrir otra adentro de su marco ni recargarse con
// otra identidad: el puente reconoce al marco, no al documento, y le daría sus permisos a quien cargara ahí.
const safety = require('../packs/safety');
const { contentTypeOf, LIMITS } = require('./package');
const { ID_RE } = require('./manifest');
const { BOOT_PATH, BOOT_SCRIPT, injectBoot } = require('./boot');

const SCHEME = 'venus-ext';

// CSP de todo lo que sale por el protocolo: sin red, sin eval, sin inline y solo los archivos propios.
// sandbox repite lo del iframe por si el documento llegara a abrirse de otra forma. Trusted Types cierra innerHTML y
// los demás caminos de texto a HTML (por ahí se podría armar un marco anidado: ver boot.js).
function cspFor(id) {
  const self = `${SCHEME}://${id}`;
  return [
    "default-src 'none'",
    `script-src ${self}`,
    `style-src ${self}`,
    `img-src ${self}`,
    "font-src 'none'",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
    'sandbox allow-scripts',
  ].join('; ');
}

function headersFor(id, type) {
  return {
    'Content-Type': type,
    'Content-Security-Policy': cspFor(id),
    'X-Content-Type-Options': 'nosniff',
    'X-DNS-Prefetch-Control': 'off',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

// id y ruta relativa de una URL del protocolo, o null si no es exactamente lo que se espera.
function parseUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 1024) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${SCHEME}:` || url.username || url.password || url.port) return null;
  const id = url.hostname;
  if (!ID_RE.test(id)) return null;
  const parts = [];
  for (const seg of url.pathname.split('/').slice(1)) {
    let clean;
    try {
      clean = decodeURIComponent(seg);
    } catch {
      return null;
    }
    // Una barra escondida en %2f o %5c no es un separador: la ruta se rechaza
    if (!clean || clean.includes('/') || clean.includes('\\')) return null;
    parts.push(clean);
  }
  if (!parts.length) return null;
  const rel = safety.safeRelPath(parts.join('/'), { instance: false, maxLength: LIMITS.MAX_PATH, maxDepth: LIMITS.MAX_DEPTH });
  if (!rel) return null;
  return { id, rel, token: url.searchParams.get('t') || '' };
}

// ctx: { servable(id) -> boolean, takeToken(id, rel, token) -> boolean, read(id, rel) -> Promise<Buffer|null> }
// Devuelve { status, headers?, body? }.
async function respond(request, ctx) {
  if (!request || request.method !== 'GET') return { status: 405 };
  const parsed = parseUrl(request.url);
  if (!parsed) return { status: 404 };
  const { id, rel, token } = parsed;
  if (!ctx.servable(id)) return { status: 404 };
  const type = contentTypeOf(rel);
  if (!type) return { status: 404 };
  if (rel === BOOT_PATH) return { status: 200, headers: headersFor(id, type), body: Buffer.from(BOOT_SCRIPT, 'utf8') };
  const isHtml = rel.toLowerCase().endsWith('.html');
  if (isHtml && !ctx.takeToken(id, rel, token)) return { status: 403 };
  const body = await ctx.read(id, rel);
  if (!body) return { status: 404 };
  return { status: 200, headers: headersFor(id, type), body: isHtml ? injectBoot(body, id) : body };
}

module.exports = { SCHEME, cspFor, headersFor, parseUrl, respond };
