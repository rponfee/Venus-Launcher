'use strict';
// Ajustes compartidos entre instancias: lógica pura (sin Electron ni disco). Un perfil maestro guarda grupos de
// options.txt y se escribe en las instancias que lo tengan prendido, justo antes de jugar.
//   - Las teclas cambiaron de formato en la 1.13: antes son números (key_key.forward:17) y después nombres
//     (key_key.forward:key.keyboard.w). El perfil las guarda en dos cajones y nunca mezcla: una instancia solo
//     recibe las de su formato. Además, el archivo tiene que coincidir: Minecraft convierte los números a nombres
//     según la clave "version" del archivo y, si encuentra un nombre donde espera un número, descarta TODAS las
//     opciones. Por eso una instancia que cambió de versión y todavía no se abrió no recibe teclas.
//   - El resto de las claves compartidas tienen el mismo formato en todas las versiones (números y true/false).
//     Las que dependen de la versión (ao, graphicsMode, lang, renderClouds...) quedan afuera a propósito.
// Pruebas: node --test "src/main/modules/sharedoptions/test/"
const { parse, parseMc, mcAtLeast } = require('../assistant/options');

const FLOAT = /^-?\d+(\.\d+)?([eE]-?\d+)?$/;
const INT = /^-?\d+$/;
const BOOL = /^(true|false)$/;
const TYPES = { float: FLOAT, int: INT, bool: BOOL };
const BINDING_KEY = /^key_[A-Za-z0-9._:/-]{1,120}$/;
const SOUND_KEY = /^soundCategory_[a-z_]{1,32}$/;
const MODIFIER = '(:[A-Z_]{1,16})?'; // Forge y NeoForge guardan el modificador después del valor: key.keyboard.g:SHIFT
const MODERN_VALUE = new RegExp(`^(key\\.(keyboard|mouse)\\.[a-z0-9._-]{1,48}|scancode\\.\\d{1,6})${MODIFIER}$`, 'i');
const LEGACY_VALUE = new RegExp(`^-?\\d{1,5}${MODIFIER}$`);
const MAX_BINDINGS = 600;
const MODERN_MIN_DATA_VERSION = 1519; // 1.13: antes de esto, Minecraft espera las teclas como números
const FORGE_LOADERS = new Set(['forge', 'neoforge']);

const float = (since) => ({ type: 'float', since });
const int = (since) => ({ type: 'int', since });
const bool = (since) => ({ type: 'bool', since });

// Grupos y sus claves. since: la primera versión que la tiene (a una más vieja no se le agrega).
const GROUPS = {
  controls: {
    bindings: true,
    on: true,
    keys: { autoJump: bool('1.11'), toggleCrouch: bool('1.15'), toggleSprint: bool('1.15') },
  },
  fov: { on: true, keys: { fov: float(), fovEffectScale: float('1.16') } },
  mouse: {
    on: true,
    keys: { mouseSensitivity: float(), invertYMouse: bool(), rawMouseInput: bool('1.15'), discrete_mouse_scroll: bool('1.13'), mouseWheelSensitivity: float('1.13') },
  },
  audio: { on: false, sound: true, since: '1.7', keys: {} },
  video: {
    on: false,
    keys: {
      renderDistance: int('1.7'),
      simulationDistance: int('1.18'),
      maxFps: int('1.7'),
      guiScale: int(),
      gamma: float(),
      particles: int(),
      bobView: bool(),
      entityShadows: bool('1.8'),
      enableVsync: bool('1.7'),
      mipmapLevels: int('1.7'),
      biomeBlendRadius: int('1.13'),
      entityDistanceScaling: float('1.16'),
    },
  },
  chat: {
    on: false,
    keys: {
      chatOpacity: float(),
      textBackgroundOpacity: float('1.14'),
      chatScale: float('1.7'),
      chatWidth: float('1.7'),
      chatHeightFocused: float('1.7'),
      chatHeightUnfocused: float('1.7'),
      chatDelay: float('1.16'),
      chatColors: bool(),
      chatLinks: bool(),
      chatLinksPrompt: bool(),
      backgroundForChatOnly: bool('1.14'),
    },
  },
  accessibility: {
    on: false,
    keys: {
      screenEffectScale: float('1.16'),
      darkMojangStudiosBackground: bool('1.16'),
      hideLightningFlashes: bool('1.16'),
      damageTiltStrength: float('1.19'),
      glintSpeed: float('1.19'),
      glintStrength: float('1.19'),
      panoramaScrollSpeed: float('1.19'),
    },
  },
};
const GROUP_IDS = Object.keys(GROUPS);

function defaultGroups() {
  return Object.fromEntries(GROUP_IDS.map((id) => [id, GROUPS[id].on]));
}

// Grupo de una clave "común" (no tecla), o null si no se comparte.
function groupOfKey(key) {
  if (SOUND_KEY.test(key)) return 'audio';
  for (const id of GROUP_IDS) if (Object.prototype.hasOwnProperty.call(GROUPS[id].keys, key)) return id;
  return null;
}

function validCommon(key, value) {
  if (SOUND_KEY.test(key)) return FLOAT.test(value);
  const group = groupOfKey(key);
  return Boolean(group) && TYPES[GROUPS[group].keys[key].type].test(value);
}

// ---------- Formato de las teclas ----------
// 'modern' (1.13 en adelante), 'legacy' (antes) o null si no se puede saber por el nombre de la versión.
function keyFormat(version) {
  const v = String(version ?? '').trim();
  const mc = parseMc(v);
  if (mc) return mc[0] > 1 || mc[1] >= 13 ? 'modern' : 'legacy';
  const snap = /^(\d{2})w(\d{2})/i.exec(v);
  if (snap) {
    const year = Number(snap[1]);
    return year > 17 || (year === 17 && Number(snap[2]) >= 43) ? 'modern' : 'legacy';
  }
  if (/^(b|a|c|rd-|inf-)\d/i.test(v)) return 'legacy';
  return null;
}

// 'modern', 'legacy', 'mixed' o null (el archivo no tiene teclas).
function fileFormat(doc) {
  let modern = false;
  let legacy = false;
  for (const e of doc.entries) {
    if (!e.key || !e.key.startsWith('key_')) continue;
    const v = String(e.value ?? '').trim();
    if (LEGACY_VALUE.test(v)) legacy = true;
    else if (MODERN_VALUE.test(v)) modern = true;
  }
  if (modern && legacy) return 'mixed';
  return modern ? 'modern' : legacy ? 'legacy' : null;
}

// Formato que se puede usar con esa instancia, o null si el archivo y la versión no coinciden.
function effectiveFormat(mcVersion, doc) {
  const byVersion = keyFormat(mcVersion);
  const byFile = fileFormat(doc);
  if (byFile === 'mixed') return null;
  if (byVersion && byFile && byVersion !== byFile) return null;
  return byVersion || byFile;
}

const rawOf = (doc, key) => {
  const e = doc.entries.find((x) => x.key === key);
  return e ? e.value : null;
};

function dataVersionOf(doc) {
  const v = String(rawOf(doc, 'version') ?? '').trim();
  return /^\d{1,7}$/.test(v) ? v : null;
}

// ---------- Perfil ----------
function emptyProfile() {
  return { version: 1, groups: defaultGroups(), syncBack: false, common: {}, bindings: { modern: {}, legacy: {} }, dataVersion: { modern: null, legacy: null }, source: null, updatedAt: 0 };
}

function cleanBindings(raw, format) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const valid = format === 'modern' ? MODERN_VALUE : LEGACY_VALUE;
  for (const [k, v] of Object.entries(raw)) {
    if (!BINDING_KEY.test(k) || typeof v !== 'string' || !valid.test(v)) continue;
    out[k] = v;
    if (Object.keys(out).length >= MAX_BINDINGS) break;
  }
  return out;
}

// Cualquier cosa -> perfil válido (lo que no sirve se descarta).
function normalizeProfile(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = emptyProfile();
  for (const id of GROUP_IDS) if (typeof r.groups?.[id] === 'boolean') out.groups[id] = r.groups[id];
  out.syncBack = r.syncBack === true;
  if (r.common && typeof r.common === 'object') {
    for (const [k, v] of Object.entries(r.common)) if (typeof v === 'string' && validCommon(k, v)) out.common[k] = v;
  }
  out.bindings.modern = cleanBindings(r.bindings?.modern, 'modern');
  out.bindings.legacy = cleanBindings(r.bindings?.legacy, 'legacy');
  for (const f of ['modern', 'legacy']) {
    const v = r.dataVersion?.[f];
    if (typeof v === 'string' && /^\d{1,7}$/.test(v)) out.dataVersion[f] = v;
  }
  if (r.source && typeof r.source === 'object' && typeof r.source.id === 'string') {
    out.source = { id: r.source.id.slice(0, 120), name: String(r.source.name ?? '').slice(0, 80), mcVersion: String(r.source.mcVersion ?? '').slice(0, 40) };
  }
  out.updatedAt = Number.isFinite(Number(r.updatedAt)) ? Number(r.updatedAt) : 0;
  return out;
}

// Lo que se puede leer de un options.txt: { common, bindings, format, dataVersion }.
function extract(doc, { mcVersion } = {}) {
  const common = {};
  for (const e of doc.entries) {
    if (e.key && validCommon(e.key, String(e.value ?? '').trim())) common[e.key] = String(e.value).trim();
  }
  const format = effectiveFormat(mcVersion, doc);
  const bindings = {};
  if (format) {
    const valid = format === 'modern' ? MODERN_VALUE : LEGACY_VALUE;
    for (const e of doc.entries) {
      if (!e.key || !BINDING_KEY.test(e.key)) continue;
      const v = String(e.value ?? '').trim();
      if (valid.test(v) && Object.keys(bindings).length < MAX_BINDINGS) bindings[e.key] = v;
    }
  }
  return { common, bindings, format, dataVersion: dataVersionOf(doc) };
}

// "Guardar desde esta instancia": el perfil queda con lo de ese archivo. El cajón del otro formato no se toca.
function saveFrom(profile, data, { source, now = Date.now() } = {}) {
  const next = normalizeProfile(profile);
  next.common = { ...next.common, ...data.common };
  if (data.format && Object.keys(data.bindings).length) {
    next.bindings[data.format] = { ...data.bindings };
    next.dataVersion[data.format] = data.dataVersion || next.dataVersion[data.format];
  }
  if (source) next.source = source;
  next.updatedAt = now;
  return next;
}

// Al cerrar el juego: solo los grupos prendidos llegan al perfil y nunca se borra nada.
// Devuelve { profile, changed: [claves] }.
function mergeBack(profile, data, { now = Date.now() } = {}) {
  const next = normalizeProfile(profile);
  const changed = [];
  for (const [k, v] of Object.entries(data.common)) {
    const group = groupOfKey(k);
    if (!group || !next.groups[group] || next.common[k] === v) continue;
    next.common[k] = v;
    changed.push(k);
  }
  if (next.groups.controls && data.format) {
    const bucket = next.bindings[data.format];
    for (const [k, v] of Object.entries(data.bindings)) {
      if (bucket[k] === v) continue;
      bucket[k] = v;
      changed.push(k);
    }
    if (data.dataVersion && next.dataVersion[data.format] !== data.dataVersion) next.dataVersion[data.format] = data.dataVersion;
  }
  if (changed.length) next.updatedAt = now;
  return { profile: next, changed };
}

// El modificador de Forge rompe la tecla en los otros loaders.
function adaptBinding(value, loader) {
  return FORGE_LOADERS.has(loader) ? value : String(value).replace(/:[A-Z_]+$/, '');
}

function setEntry(doc, key, value, changed) {
  const raw = `${key}:${value}`;
  const i = doc.entries.findIndex((e) => e.key === key);
  if (i >= 0) {
    if (doc.entries[i].value === value) return;
    doc.entries[i] = { raw, key, value };
  } else doc.entries.push({ raw, key, value });
  changed.push(key);
}

function sinceOf(key) {
  if (SOUND_KEY.test(key)) return GROUPS.audio.since;
  const group = groupOfKey(key);
  return group ? GROUPS[group].keys[key].since : undefined;
}

// La versión no tiene esa opción (se conserva si ya estaba en el archivo). Sin versión comparable, se agrega.
function missingInVersion(key, mcVersion) {
  const since = sinceOf(key);
  if (!since || !parseMc(mcVersion)) return false;
  return !mcAtLeast(mcVersion, since);
}

// Razón para no escribir las teclas en este archivo, o null si se puede.
function bindingsBlocked(profile, doc, mcVersion, format) {
  if (!format) return 'formatMismatch';
  if (!Object.keys(profile.bindings[format]).length) return 'emptyFormat';
  const fileVersion = dataVersionOf(doc);
  if (format === 'modern') {
    // Sin "version", Minecraft arranca la conversión desde cero y descartaría todas las opciones.
    if (!fileVersion && !profile.dataVersion.modern) return 'noDataVersion';
    if (fileVersion && Number(fileVersion) < MODERN_MIN_DATA_VERSION) return 'formatMismatch';
  }
  return null;
}

// Mezcla el perfil en un documento de options.txt (no lo toca: devuelve uno nuevo).
// Devuelve { doc, changed: [claves], blocked: razón por la que no se escribieron las teclas o null }.
function applyTo(docIn, profileIn, { mcVersion, loader } = {}) {
  const profile = normalizeProfile(profileIn);
  const doc = { ...docIn, entries: docIn.entries.map((e) => ({ ...e })) };
  const changed = [];
  for (const [key, value] of Object.entries(profile.common)) {
    if (!profile.groups[groupOfKey(key)]) continue;
    if (!doc.entries.some((e) => e.key === key) && missingInVersion(key, mcVersion)) continue;
    setEntry(doc, key, value, changed);
  }
  let blocked = null;
  if (profile.groups.controls) {
    const format = effectiveFormat(mcVersion, doc);
    blocked = bindingsBlocked(profile, doc, mcVersion, format);
    if (!blocked) {
      if (!dataVersionOf(doc) && profile.dataVersion[format]) {
        // "version" va primero, como lo escribe Minecraft.
        const value = profile.dataVersion[format];
        doc.entries.unshift({ raw: `version:${value}`, key: 'version', value });
        changed.push('version');
      }
      for (const [key, value] of Object.entries(profile.bindings[format])) setEntry(doc, key, adaptBinding(value, loader), changed);
    }
  }
  return { doc, changed, blocked };
}

function serialize(doc) {
  return doc.entries.length ? doc.entries.map((e) => e.raw).join(doc.eol) + doc.eol : '';
}

// Cuántas claves tiene el perfil por grupo (para la interfaz).
function summarize(profileIn) {
  const profile = normalizeProfile(profileIn);
  const counts = Object.fromEntries(GROUP_IDS.map((id) => [id, 0]));
  for (const k of Object.keys(profile.common)) counts[groupOfKey(k)]++;
  const modern = Object.keys(profile.bindings.modern).length;
  const legacy = Object.keys(profile.bindings.legacy).length;
  counts.controls += modern + legacy;
  return { groups: profile.groups, syncBack: profile.syncBack, counts, modern, legacy, source: profile.source, updatedAt: profile.updatedAt, saved: profile.updatedAt > 0 };
}

module.exports = {
  GROUPS,
  GROUP_IDS,
  parse,
  serialize,
  keyFormat,
  fileFormat,
  effectiveFormat,
  emptyProfile,
  normalizeProfile,
  extract,
  saveFrom,
  mergeBack,
  applyTo,
  adaptBinding,
  summarize,
};
