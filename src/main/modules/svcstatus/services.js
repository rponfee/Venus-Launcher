'use strict';
// Estado de los servicios: catálogo de lo que se comprueba. Un pedido barato por servicio (HEAD, o GET sin leer
// el cuerpo) que tiene que contestar rápido. Sin Electron: lo usan el módulo y las pruebas.
//
// Reglas de privacidad: solo GET/HEAD, sin cookies ni datos del usuario. Las únicas cabeceras extra son claves
// públicas del launcher y cada una viaja solo a su host (x-api-key a api.curseforge.com, apikey al proyecto de
// Supabase del launcher); safeHeaders() lo vuelve a verificar justo antes de cada pedido.

const GROUPS = Object.freeze(['connection', 'login', 'downloads', 'content', 'venus']);

const CURSEFORGE_HOST = 'api.curseforge.com';

// company: empresa detrás de cada servicio (Mojang es de Microsoft). Si fallan a la vez servicios de varias
// empresas pero internet anda, lo más probable es que la red o el antivirus los esté bloqueando.
// requests[].via: 'name' (necesita DNS) o 'ip' (dirección fija): así se nota cuando falla solo el DNS.
// anyAnswer: en la prueba de conexión cualquier respuesta HTTP (también un 5xx de Cloudflare) prueba que internet anda.
const SERVICES = Object.freeze([
  {
    id: 'internet',
    group: 'connection',
    company: 'cloudflare',
    anyAnswer: true,
    requests: [
      { url: 'https://www.cloudflare.com/cdn-cgi/trace', method: 'HEAD', via: 'name' },
      { url: 'https://1.1.1.1/cdn-cgi/trace', method: 'HEAD', via: 'ip' },
    ],
  },
  { id: 'microsoft', group: 'login', company: 'microsoft', requests: [{ url: 'https://login.live.com/', method: 'HEAD' }] },
  { id: 'xbox', group: 'login', company: 'microsoft', requests: [{ url: 'https://user.auth.xboxlive.com/', method: 'HEAD' }] },
  { id: 'minecraftServices', group: 'login', company: 'microsoft', requests: [{ url: 'https://api.minecraftservices.com/', method: 'HEAD' }] },
  // El manifiesto pesa ~280 KB: HEAD alcanza para saber si responde, sin bajarlo.
  { id: 'mojangMeta', group: 'downloads', company: 'microsoft', requests: [{ url: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', method: 'HEAD' }] },
  { id: 'mojangLibraries', group: 'downloads', company: 'microsoft', requests: [{ url: 'https://libraries.minecraft.net/', method: 'HEAD' }] },
  { id: 'mojangAssets', group: 'downloads', company: 'microsoft', requests: [{ url: 'https://resources.download.minecraft.net/', method: 'HEAD' }] },
  { id: 'modrinth', group: 'content', company: 'modrinth', requests: [{ url: 'https://api.modrinth.com/', method: 'HEAD' }] },
  { id: 'curseforge', group: 'content', company: 'curseforge', needs: 'curseforgeKey', requests: [{ url: `https://${CURSEFORGE_HOST}/`, method: 'HEAD' }] },
  // La URL sale de core/cloud-defaults.js (el proyecto del launcher). HEAD ahí contesta 405: se usa GET (~100 bytes).
  { id: 'venus', group: 'venus', company: 'venus', needs: 'cloud', requests: [] },
]);

const IDS = Object.freeze(SERVICES.map((s) => s.id));
const BY_ID = new Map(SERVICES.map((s) => [s.id, s]));

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

// Ids pedidos por la interfaz: solo los conocidos, sin repetir y en el orden del catálogo.
// Sin lista (o vacía) = todos.
function pickIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return [...IDS];
  const wanted = new Set(ids.filter((id) => typeof id === 'string' && id.length <= 40 && BY_ID.has(id)));
  return IDS.filter((id) => wanted.has(id));
}

// Definiciones vigentes. curseforgeApiKey: la de core/app-config (vacía = CurseForge no se comprueba).
// cloud: { url, anonKey, configured } de core/cloud-defaults. userAgent: el del launcher.
function buildDefs({ curseforgeApiKey = '', cloud = null, userAgent = 'VenusLauncher' } = {}) {
  const ua = String(userAgent || 'VenusLauncher').slice(0, 120);
  const cfKey = typeof curseforgeApiKey === 'string' ? curseforgeApiKey.trim().slice(0, 200) : '';
  const cloudOk = Boolean(cloud && cloud.configured && typeof cloud.url === 'string' && /^https?:\/\//i.test(cloud.url) && cloud.anonKey);
  return SERVICES.map((svc) => {
    const def = { id: svc.id, group: svc.group, company: svc.company, anyAnswer: Boolean(svc.anyAnswer), skip: null, requests: [] };
    if (svc.needs === 'curseforgeKey' && !cfKey) def.skip = 'noKey';
    else if (svc.needs === 'cloud' && !cloudOk) def.skip = 'notConfigured';
    if (def.skip) return def;
    if (svc.id === 'venus') {
      const url = `${cloud.url.replace(/\/+$/, '')}/auth/v1/health`;
      def.requests = [{ url, method: 'GET', headers: { 'User-Agent': ua, apikey: String(cloud.anonKey) }, secretHost: hostOf(url) }];
      return def;
    }
    def.requests = svc.requests.map((r) => {
      const req = { url: r.url, method: r.method, via: r.via || 'name', headers: { 'User-Agent': ua } };
      if (svc.id === 'curseforge') {
        req.headers['x-api-key'] = cfKey;
        req.secretHost = CURSEFORGE_HOST;
      }
      return req;
    });
    return def;
  });
}

// Cabeceras que se pueden mandar a esa URL: las claves solo van a su propio host (secretHost).
function safeHeaders(req) {
  const out = {};
  const host = hostOf(req && req.url);
  for (const [k, v] of Object.entries((req && req.headers) || {})) {
    if (typeof v !== 'string') continue;
    const name = k.toLowerCase();
    if (name === 'user-agent') out[k] = v;
    else if ((name === 'x-api-key' || name === 'apikey') && req.secretHost && host === req.secretHost) out[k] = v;
  }
  return out;
}

const companyOf = (id) => BY_ID.get(id)?.company || id;
const groupOf = (id) => BY_ID.get(id)?.group || null;

module.exports = { GROUPS, SERVICES, IDS, CURSEFORGE_HOST, pickIds, buildDefs, safeHeaders, hostOf, companyOf, groupOf };
