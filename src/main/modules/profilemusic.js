'use strict';
// Musica de perfil (4.6): la cancion del perfil se elige de un catalogo de musica libre, sin subir archivos propios.
// Plataforma: Openverse (Fundacion WordPress, https://api.openverse.org/v1/audio/), gratis y sin clave, con audio
// Creative Commons de Jamendo y de Wikimedia Commons. Solo se aceptan licencias que permiten uso comercial (CC0,
// dominio publico, BY, BY-SA y BY-ND). Este modulo solo busca: el audio lo reproduce la interfaz directo desde el
// host de origen (los hosts permitidos estan en profilemusic/policy.js y en la CSP de index.html).
//
// Conexion opcional: apagada hasta que la persona la active en Ajustes > Privacidad (settings.profileMusic.enabled).
// Con el interruptor apagado no sale ningun pedido a Openverse desde este modulo.
//
// Canales:
//  profilemusic:status() -> { enabled, blockedUntil, usedLastMinute, usedToday, limits: { perMinute, perDay }, quota, cached,
//      genres, lengths, sources, license: { ids, names } }
//  profilemusic:search({ text?, genre?, length?, source?, page? }) -> { items: [pista], page, pageCount, total, fromCache, stale }
//      pista: { provider, id, source, title, creator, license, licenseVersion, licenseUrl, landing, url, duration (s), genres }
//      Error esperado: { error: <codigo>, retryAfter? } (en vez de lanzarlo, para que retryAfter llegue a la interfaz).
//      Codigos: disabled, bad_query, offline, rate_limited, daily_limit, network, timeout, server, bad_response.
//  profilemusic:clearCache() -> { removed }
//
// Ajustes: settings.profileMusic { enabled: false }. Datos: data/profilemusic.json (cache de resultados y contador de pedidos).
// Desarrollo: VENUS_PROFILEMUSIC_FAKE=1|limit|empty (con VENUS_DEVSHOT y sin empaquetar) usa un Openverse de mentira.
const paths = require('../core/paths');
const settings = require('../core/settings');
const { createClient } = require('./profilemusic/client');
const { createDiskStore } = require('./profilemusic/store');
const { GENRE_IDS, LENGTH_IDS, SOURCE_CHOICE_IDS } = require('./profilemusic/query');
const { LICENSES, LICENSE_IDS } = require('./profilemusic/policy');

const EXPECTED = new Set(['bad_query', 'offline', 'rate_limited', 'daily_limit', 'network', 'timeout', 'server', 'bad_response']);

let client = null;

// El interruptor se lee en cada pedido (settings.get() sale de memoria): apagarlo corta todo al instante
const isEnabled = async () => (await settings.get())?.profileMusic?.enabled === true;

function makeClient(app) {
  const version = app?.getVersion?.() || '4.6.0';
  const fakeMode = process.env.VENUS_PROFILEMUSIC_FAKE;
  const useFake = Boolean(process.env.VENUS_DEVSHOT) && !app?.isPackaged && ['1', 'limit', 'empty'].includes(fakeMode);
  return createClient({
    fetch: useFake ? require('./profilemusic/fake').fakeFetch(fakeMode) : (url, init) => fetch(url, init),
    userAgent: `VenusLauncher/${version} (+https://github.com/rponfee/Venus-Launcher; profile music via Openverse)`,
    store: useFake ? undefined : createDiskStore(paths.data('profilemusic.json')),
    isOffline: () => {
      try {
        return require('../core/http').isOffline();
      } catch {
        return false;
      }
    },
  });
}

async function search(input) {
  if (!(await isEnabled())) return { error: 'disabled' };
  try {
    return await client.search(input);
  } catch (err) {
    if (EXPECTED.has(err?.code)) return { error: err.code, ...(err.retryAfter ? { retryAfter: err.retryAfter } : {}) };
    console.warn('[profilemusic] busqueda:', err?.message || err);
    return { error: 'network' };
  }
}

async function status() {
  return {
    enabled: await isEnabled(),
    ...(await client.status()),
    genres: GENRE_IDS,
    lengths: LENGTH_IDS,
    sources: SOURCE_CHOICE_IDS,
    license: { ids: LICENSE_IDS, names: Object.fromEntries(LICENSE_IDS.map((id) => [id, LICENSES[id].name])) },
  };
}

function register({ app, handle }) {
  client = makeClient(app);
  handle('profilemusic:status', () => status());
  handle('profilemusic:search', (input) => search(input));
  handle('profilemusic:clearCache', () => client.clearCache());
}

module.exports = { register };
