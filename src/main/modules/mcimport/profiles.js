'use strict';
// Perfiles del launcher oficial de Minecraft, sin Electron (se prueba con Node puro).
//  - launcher_profiles.json: launcher oficial (y el de Java viejo, con perfiles sin "type").
//  - launcher_profiles_microsoft_store.json: el launcher de la Microsoft Store / app de Xbox (misma carpeta).
// Todo lo que viene del archivo se valida: textos con largo maximo y sin caracteres de control, ids de version
// con los caracteres de un id real, fechas razonables e iconos solo como data: de imagen (o nombre del icono
// incorporado). javaArgs no se importa a proposito: Venus elige la memoria y los flags, y argumentos
// arbitrarios de la JVM podrian ejecutar codigo (-javaagent).

const PROFILE_FILES = Object.freeze([
  { file: 'launcher_profiles.json', source: 'official', prefix: 'o' },
  { file: 'launcher_profiles_microsoft_store.json', source: 'store', prefix: 's' },
]);
const TYPES = new Set(['latest-release', 'latest-snapshot', 'custom']);
const LATEST_IDS = new Set(['latest-release', 'latest-snapshot']);
const MAX_PROFILES = 200;
const MAX_FILE = 8 * 1024 * 1024; // un launcher_profiles.json con iconos propios pesa unos pocos cientos de KB
const MAX_ICON = 256 * 1024;
const ICON_DATA = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const BUILTIN_ICON = /^[A-Za-z_]{1,40}$/;
const VERSION_ID = /^[\w .+-]{1,100}$/;
const MIN_TIME = Date.UTC(2009, 0, 1); // antes de esto no habia Minecraft: 1970 es "nunca"
// Caracteres de control, separadores de linea y marcas de direccion. Se arman con codigos (un caracter literal de
// estos en el codigo rompe la interfaz, ver docs/arquitectura.md 8).
const hex4 = (c) => `${String.fromCharCode(92)}u${c.toString(16).padStart(4, '0')}`;
const CONTROL_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200e, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]];
const CONTROL = new RegExp(`[${CONTROL_RANGES.map(([a, b]) => `${hex4(a)}-${hex4(b)}`).join('')}]`, 'g');
const BOM = String.fromCharCode(0xfeff);

// Texto visible: sin caracteres de control ni marcas de direccion, espacios colapsados y largo maximo.
function cleanText(v, max = 80) {
  if (typeof v !== 'string') return '';
  return v.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

function validVersionId(id) {
  return typeof id === 'string' && VERSION_ID.test(id) && id.trim() === id && id !== '.' && id !== '..';
}

// Fecha ISO (o milisegundos) -> milisegundos; 0 si falta, es invalida, es de antes de 2009 o del futuro.
function parseTime(v, now = Date.now()) {
  const ms = typeof v === 'number' ? v : typeof v === 'string' && v.length <= 40 ? Date.parse(v) : NaN;
  return Number.isFinite(ms) && ms >= MIN_TIME && ms <= now + 24 * 60 * 60 * 1000 ? Math.round(ms) : 0;
}

function cleanIcon(v) {
  if (typeof v !== 'string' || !v) return null;
  if (v.length <= MAX_ICON && ICON_DATA.test(v)) return { kind: 'image', data: v };
  if (BUILTIN_ICON.test(v)) return { kind: 'builtin', name: v };
  return null;
}

// gameDir tal cual viene (se resuelve y se valida al escanear). Sin NUL ni rutas absurdamente largas.
function cleanGameDir(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 1024 || s.includes('\u0000')) return null;
  return s;
}

function validKey(k) {
  return typeof k === 'string' && k.length > 0 && k.length <= 128 && !/[\u0000-\u001f\u007f]/.test(k);
}

/**
 * Lee el texto de un archivo de perfiles. Devuelve { ok: true, profiles, selected } o { ok: false, error }
 * con error 'malformed' (JSON roto o demasiado grande) o 'noProfiles' (sin objeto "profiles").
 * opts: { source ('official' | 'store'), prefix ('o' | 's'), now }
 */
function parseProfilesText(text, { source = 'official', prefix = 'o', now = Date.now() } = {}) {
  if (typeof text !== 'string' || text.length > MAX_FILE) return { ok: false, error: 'malformed' };
  let data;
  try {
    data = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
  } catch {
    return { ok: false, error: 'malformed' };
  }
  const raw = data && typeof data === 'object' && !Array.isArray(data) ? data.profiles : null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'noProfiles' };
  const profiles = [];
  for (const [key, p] of Object.entries(raw)) {
    if (profiles.length >= MAX_PROFILES) break;
    if (!validKey(key) || !p || typeof p !== 'object' || Array.isArray(p)) continue;
    const type = TYPES.has(p.type) ? p.type : 'custom';
    const lastVersionId = validVersionId(p.lastVersionId) ? p.lastVersionId : null;
    // El launcher viejo dejaba perfiles sin version (usaban la ultima release) o con "latest-release" /
    // "latest-snapshot" como version: 'latest-release', 'latest-snapshot' o null. Una version que vino pero no
    // es valida no se adivina (queda "sin version").
    const noId = p.lastVersionId === undefined || p.lastVersionId === null || p.lastVersionId === '';
    let implicitLatest = null;
    if (type === 'custom') implicitLatest = LATEST_IDS.has(lastVersionId) ? lastVersionId : noId ? 'latest-release' : null;
    profiles.push({
      id: `${prefix}:${key}`,
      key,
      source,
      type,
      name: cleanText(p.name, 80),
      lastVersionId,
      implicitLatest,
      gameDir: cleanGameDir(p.gameDir),
      icon: cleanIcon(p.icon),
      lastUsed: parseTime(p.lastUsed, now),
      created: parseTime(p.created, now),
    });
  }
  const selected = validKey(data.selectedProfile) ? `${prefix}:${data.selectedProfile}` : null;
  return { ok: true, profiles, selected };
}

function normDir(d) {
  return String(d || '')
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}

/**
 * Junta los perfiles de los dos archivos. El launcher de la Store puede repetir los mismos perfiles del
 * oficial: un perfil igual (tipo, nombre, version y carpeta) aparece una sola vez, el usado mas reciente.
 * Ordena por ultimo uso (los nunca usados al final) y despues por nombre.
 */
function mergeProfiles(lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const p of Array.isArray(list) ? list : []) {
      const k = `${p.type}|${p.name.toLowerCase()}|${p.lastVersionId || ''}|${normDir(p.gameDir)}`;
      const prev = byKey.get(k);
      if (!prev) byKey.set(k, { ...p, sources: [p.source] });
      else {
        const keep = p.lastUsed > prev.lastUsed ? { ...p } : { ...prev };
        keep.sources = [...new Set([...prev.sources, p.source])];
        byKey.set(k, keep);
      }
    }
  }
  return [...byKey.values()].sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

module.exports = {
  BOM,
  PROFILE_FILES,
  MAX_FILE,
  TYPES,
  cleanText,
  cleanIcon,
  cleanGameDir,
  parseTime,
  validVersionId,
  parseProfilesText,
  mergeProfiles,
};
