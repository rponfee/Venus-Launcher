// Sincronizar ajustes y temas entre PCs: lógica pura, sin DOM ni Supabase (pruebas en test/sync-logic.test.js).
//   SYNC_KEYS            lista blanca: lo único que sale de esta PC. Jamás rutas, tokens ni nada del equipo
//   extract(settings)    { clave: valor } de lo que viaja hoy (saca lo que depende de esta PC)
//   detectChanges(...)   qué claves cambió el usuario: se compara el contenido, no se usa una marca de "estoy aplicando",
//                        así aplicar lo que llega no se vuelve a subir y no hay bucle
//   mergeRemote(...)     fusión por clave: gana la fecha más nueva
//   buildDoc / fitDoc    el JSON que se guarda, con el tope de tamaño
//   createSyncEngine()   el recorrido completo contra la nube (recibe rpc, ajustes y pregunta como funciones)
import { shareableLook } from '../themes/looks.js';
import { APPEARANCE_DEFAULTS } from '../../a11y/appearance-logic.js';

export const MAX_DOC_BYTES = 64 * 1024;
const DOC_VERSION = 1;
const MAX_TEXT = 4096;

// clave -> tipo que se acepta al recibir
const TYPES = {
  'appearance.accent': 'string',
  'appearance.customColor': 'string',
  'appearance.tint': 'boolean',
  'appearance.background': 'string',
  'appearance.wallpaperId': 'string',
  'appearance.bgDim': 'number',
  'appearance.bgBlur': 'number',
  'appearance.uiRadius': 'string',
  'appearance.uiDensity': 'string',
  'appearance.uiSidebar': 'string',
  'appearance.uiFont': 'string',
  'appearance.uiGlass': 'number',
  'appearance.palette': 'object',
  'appearance.scheme': 'string',
  'appearance.autoLightFrom': 'string',
  'appearance.autoLightTo': 'string',
  'appearance.seasonal': 'boolean',
  'appearance.rotation': 'object',
  'appearance.playButton': 'object',
  // 6.1: tamaño del texto, tarjetas, lado del menú, página de inicio y extras de la barra de título
  'appearance.uiText': 'string',
  'appearance.uiCards': 'string',
  'appearance.uiSide': 'string',
  'appearance.startPage': 'string',
  'appearance.titlebar': 'object',
  looks: 'array',
  'decor.particles': 'string',
  'decor.density': 'string',
  'decor.seasonalParticles': 'boolean',
  'decor.sounds': 'object',
  'decor.splash': 'object',
  'decor.cursor': 'string',
  'nav.order': 'array',
  'nav.hidden': 'array',
  'nav.pinned': 'array',
  'nav.iconPack': 'string',
  'home.layout': 'object',
  'home.hero': 'string',
};

export const SYNC_KEYS = Object.keys(TYPES);

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Ruta de cualquier sistema (la misma idea que modules/portability/filter.js, que no se puede importar desde acá)
const PATH_LIKE = /^[a-zA-Z]:[\\/]|^\\\\|^\/(home|users|mnt|media|var|opt|tmp|usr|etc|root|applications|volumes|private|run)(\/|$)|^file:|^~[\\/]|^%[a-z_]+%[\\/]/i;

function clean(v) {
  if (typeof v === 'string') return !PATH_LIKE.test(v) && v.length <= MAX_TEXT;
  if (Array.isArray(v)) return v.every(clean);
  if (isObj(v)) return Object.values(v).every(clean);
  return true;
}

function getPath(obj, key) {
  let cur = obj;
  for (const part of key.split('.')) {
    if (!isObj(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

// Orden estable: { a, b } y { b, a } son lo mismo
export function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

// cyrb53: alcanza para saber si un valor cambió, sin guardarlo dos veces
export function hashValue(v) {
  const s = canon(v);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Lo que por ahora no viaja en esta PC, porque lo está manejando otra cosa o es de este equipo:
//  - temporada activa: el acento y el fondo son los de Halloween o Navidad, no los elegidos
//  - fondos rotativos: el fondo cambia solo cada tantos minutos
//  - fondo con imagen propia: es un archivo de esta PC
export function pausedKeys(settings) {
  const a = settings?.appearance;
  const out = new Set();
  if (!isObj(a)) return out;
  if (a.seasonal && a.seasonalBackup) ['appearance.accent', 'appearance.customColor', 'appearance.background', 'appearance.wallpaperId'].forEach((k) => out.add(k));
  if (a.rotation?.enabled) out.add('appearance.wallpaperId');
  if (a.background === 'image') out.add('appearance.background');
  return out;
}

// Claves de APPEARANCE_DEFAULTS que se sumaron después de la 6.0 y viajan en los looks. Toda clave nueva de
// APPEARANCE_DEFAULTS que viaje en los looks va en esta lista (si no, actualizar cambia el hash de 'looks' en todas las PCs).
const LOOK_KEYS_NEW = ['uiText', 'uiCards', 'uiSide'];

// Un look tal como viaja: sin rutas y sin el logo (pesa hasta 200 KB y no entra en el tope).
function syncLook(raw) {
  if (!isObj(raw) || typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(raw.id)) return null;
  const share = shareableLook(raw);
  if (!share) return null;
  const { logo: _l, logoName: _n, ...branding } = share.branding;
  // Las claves que la 6.0 no conoce solo viajan si no son las de fábrica: así un look sin estilo propio viaja igual que
  // en 6.0, el hash guardado sigue valiendo y actualizar no cuenta como un cambio del usuario (que pisaría los looks
  // más nuevos de las otras PCs). Al recibir, normalizeLook() repone los valores de fábrica.
  const appearance = { ...share.appearance };
  for (const k of LOOK_KEYS_NEW) if (appearance[k] === APPEARANCE_DEFAULTS[k]) delete appearance[k];
  return { id: raw.id, createdAt: Number(raw.createdAt) || 0, name: share.name, appearance, branding };
}

export const syncLooks = (list) => (Array.isArray(list) ? list.map(syncLook).filter(Boolean) : []);

export function extract(settings) {
  const paused = pausedKeys(settings);
  const out = {};
  for (const key of SYNC_KEYS) {
    if (paused.has(key)) continue;
    let v = getPath(settings, key);
    if (key === 'looks') v = v === undefined ? undefined : syncLooks(v);
    if (v === undefined || v === null || !clean(v)) continue;
    out[key] = v;
  }
  return out;
}

// Una clave que llega de la nube: tiene que estar en la lista, ser del tipo esperado y no traer rutas.
export function validRemote(key, value) {
  const type = TYPES[key];
  if (!type || value === undefined || value === null) return false;
  if (type === 'array' ? !Array.isArray(value) : type === 'object' ? !isObj(value) : typeof value !== type) return false;
  if (key === 'appearance.background' && value !== 'stars' && value !== 'wallpaper') return false;
  return clean(value);
}

// Claves válidas de un documento de la nube. Una fecha en el futuro (reloj adelantado en otra PC) vale como ahora: si no,
// esa PC ganaría siempre.
export function readDoc(doc, now) {
  const out = {};
  const keys = isObj(doc?.keys) ? doc.keys : {};
  for (const [key, entry] of Object.entries(keys)) {
    if (!isObj(entry) || !validRemote(key, entry.v)) continue;
    const at = Number(entry.at);
    out[key] = { v: entry.v, at: Number.isFinite(at) && at > 0 ? Math.min(at, now) : 0 };
  }
  return out;
}

// Compara lo que hay ahora con lo último visto. Devuelve las claves que cambió el usuario, con fecha de ahora.
export function detectChanges(local, meta, now) {
  const next = { ...(meta || {}) };
  const changed = [];
  for (const [key, value] of Object.entries(local)) {
    const h = hashValue(value);
    if (next[key]?.h === h) continue;
    next[key] = { h, at: now };
    changed.push(key);
  }
  return { changed, meta: next };
}

/**
 * Fusión por clave con lo de la nube: gana la fecha más nueva; si es la misma generación no se hace nada (así dos versiones
 * del launcher que normalizan distinto no se pisan para siempre).
 * Devuelve { apply: { clave: { v, at } }, upload: boolean }.
 */
export function mergeRemote({ local, meta, remote, paused = new Set() }) {
  const apply = {};
  let upload = false;
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const r = remote[key];
    if (!r) {
      if (key in local) upload = true; // la nube todavía no la tiene
      continue;
    }
    if (paused.has(key)) continue;
    const m = meta[key];
    const mine = m?.at || 0;
    if (m && hashValue(r.v) === m.h) {
      if (mine > r.at) upload = true;
      continue;
    }
    if (r.at > mine) apply[key] = r;
    else if (mine > r.at && key in local) upload = true;
  }
  return { apply, upload };
}

// Los looks que llegan vienen sin logo ni imagen propia: los de esta PC los conservan si son el mismo look.
export function mergeLooks(remote, localList) {
  const byId = new Map((Array.isArray(localList) ? localList : []).filter(isObj).map((l) => [l.id, l]));
  return (Array.isArray(remote) ? remote : []).filter(isObj).map((r) => {
    const l = byId.get(r.id);
    if (!l) return r;
    if (hashValue(syncLook(l)) === hashValue(r)) return l; // sin cambios: tal cual está acá
    const branding = { ...r.branding };
    if (l.branding?.logo) {
      branding.logo = l.branding.logo;
      branding.logoName = l.branding.logoName;
      branding.logoPixel = l.branding.logoPixel;
    }
    return { ...r, branding };
  });
}

// { 'appearance.accent': x } -> { appearance: { accent: x } }, para store.setSettings (mezcla profunda; las listas se reemplazan)
export function toPatch(values, settings) {
  const patch = {};
  for (const [key, value] of Object.entries(values)) {
    if (key === 'looks') {
      patch.looks = mergeLooks(value, settings?.looks);
      continue;
    }
    const parts = key.split('.');
    let cur = patch;
    for (const part of parts.slice(0, -1)) cur = cur[part] || (cur[part] = {});
    cur[parts[parts.length - 1]] = value;
  }
  return patch;
}

const docSize = (doc) => new TextEncoder().encode(JSON.stringify(doc)).length;

export function buildDoc(local, meta, now) {
  const keys = {};
  for (const [key, value] of Object.entries(local)) keys[key] = { v: value, at: meta[key]?.at || now };
  return { v: DOC_VERSION, keys };
}

// Con el tope: si no entra se sueltan los looks más viejos. Lo demás siempre entra (son unas pocas claves chicas).
export function fitDoc(doc, max = MAX_DOC_BYTES) {
  if (docSize(doc) <= max) return { doc, trimmed: 0 };
  const entry = doc.keys.looks;
  if (!entry) return { doc: null, trimmed: 0 };
  const looks = [...entry.v].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  let trimmed = 0;
  while (looks.length) {
    looks.shift();
    trimmed++;
    const next = { ...doc, keys: { ...doc.keys, looks: { ...entry, v: looks } } };
    if (docSize(next) <= max) return { doc: next, trimmed };
  }
  const { looks: _l, ...rest } = doc.keys;
  const next = { ...doc, keys: rest };
  return docSize(next) <= max ? { doc: next, trimmed } : { doc: null, trimmed };
}

export function hasRemoteData(remote) {
  return Number(remote?.version) > 0 && isObj(remote?.data?.keys) && Object.keys(remote.data.keys).length > 0;
}

// ¿Hay que preguntar "traer de la nube" o "subir esto"? La primera vez en esta PC con esta cuenta, si la nube ya tiene algo.
export function needsDecision(state, userId, remote) {
  if (state?.decided && state.userId === userId) return false;
  return hasRemoteData(remote);
}

/**
 * Recorrido contra la nube. deps:
 *   rpc(nombre, args) -> datos (lanza si falla)
 *   getSettings() · applyPatch(parche) -> ajustes nuevos · loadState() · saveState(estado)
 *   ask(remoto) -> 'pull' | 'push' | null · userId() · now()
 * Estado: { enabled, decided, userId, version, keys: { clave: { h, at } }, lastAt, trimmed }
 */
export function createSyncEngine(deps) {
  const now = () => deps.now?.() ?? Date.now();
  let running = null;

  async function applyRemote(apply, state) {
    if (!Object.keys(apply).length) return;
    const values = Object.fromEntries(Object.entries(apply).map(([k, e]) => [k, e.v]));
    // Primero la marca con el valor de la nube, para que lo que dispare setSettings no se tome como un cambio del usuario.
    for (const [key, e] of Object.entries(apply)) state.keys[key] = { h: hashValue(e.v), at: e.at };
    const after = await deps.applyPatch(toPatch(values, deps.getSettings()));
    // Y la definitiva con lo que quedó después de normalizar: esta PC no tiene nada propio que subir.
    const local = extract(after || deps.getSettings());
    for (const [key, e] of Object.entries(apply)) if (key in local) state.keys[key] = { h: hashValue(local[key]), at: e.at };
  }

  async function upload(state, expected) {
    let version = expected;
    for (let attempt = 0; attempt < 4; attempt++) {
      const local = extract(deps.getSettings());
      const fit = fitDoc(buildDoc(local, state.keys, now()));
      if (!fit.doc) throw Object.assign(new Error('too_big'), { code: 'too_big' });
      state.trimmed = fit.trimmed;
      const res = await deps.rpc('settings_sync_save', { p_data: fit.doc, p_version: version });
      if (res?.ok) return res.version;
      if (!res?.conflict) throw new Error('settings_sync_save');
      // Otra PC guardó en el medio: se fusiona con lo suyo y se vuelve a probar
      version = Number(res.version) || 0;
      const remote = readDoc(res.data, now());
      const merged = mergeRemote({ local, meta: state.keys, remote, paused: pausedKeys(deps.getSettings()) });
      await applyRemote(merged.apply, state);
    }
    throw new Error('settings_sync_conflict');
  }

  async function run() {
    const uid = deps.userId();
    if (!uid) return { status: 'signedOut' };
    const state = { keys: {}, version: 0, ...(deps.loadState() || {}) };
    if (state.userId !== uid) Object.assign(state, { userId: uid, decided: false, keys: {}, version: 0 }); // otra cuenta: lo de antes no vale
    const remote = await deps.rpc('settings_sync_get');
    const t = now();
    const doc = readDoc(remote?.data, t);
    let local = extract(deps.getSettings());
    let result = 'current';

    if (needsDecision(state, uid, remote)) {
      const choice = await deps.ask(remote);
      if (!choice) return { status: 'waiting' };
      if (choice === 'pull') {
        // Lo que no está en la nube se queda y sube después, como cualquier clave nueva
        state.keys = detectChanges(local, {}, 0).meta;
        const paused = pausedKeys(deps.getSettings());
        await applyRemote(Object.fromEntries(Object.entries(doc).filter(([k]) => !paused.has(k))), state);
        state.version = Number(remote.version) || 0;
        result = 'pulled';
      } else {
        // Esto manda: todo con fecha de ahora, y se guarda contra la versión que hay
        state.keys = detectChanges(local, {}, t).meta;
        state.version = await upload(state, Number(remote.version) || 0);
        result = 'pushed';
      }
      state.decided = true;
      local = extract(deps.getSettings());
    } else {
      state.decided = true;
      state.keys = detectChanges(local, state.keys, t).meta;
      const merged = mergeRemote({ local, meta: state.keys, remote: doc, paused: pausedKeys(deps.getSettings()) });
      const applied = Object.keys(merged.apply).length;
      await applyRemote(merged.apply, state);
      state.version = Number(remote?.version) || 0;
      if (applied) result = 'pulled';
      if (merged.upload) {
        state.version = await upload(state, state.version);
        result = applied ? 'merged' : 'pushed';
      }
    }
    state.lastAt = now();
    await deps.saveState(state);
    return { status: result, version: state.version, trimmed: state.trimmed || 0 };
  }

  return {
    // Dos pedidos seguidos no se pisan: el segundo espera al primero
    sync() {
      running = (running || Promise.resolve()).catch(() => {}).then(run);
      return running;
    },
    // ¿El usuario cambió algo desde lo último visto? Para no despertar a la red sin motivo.
    hasLocalChanges() {
      const state = deps.loadState() || {};
      return detectChanges(extract(deps.getSettings()), state.keys || {}, 0).changed.length > 0;
    },
    async removeRemote() {
      await deps.rpc('settings_sync_delete');
      const state = { ...(deps.loadState() || {}), version: 0, keys: {}, decided: false, lastAt: 0 };
      await deps.saveState(state);
    },
  };
}
