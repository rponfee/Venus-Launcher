'use strict';
// Sets de mods: lógica sin Electron. Un set es un conjunto con nombre que recuerda qué mods quedan prendidos y
// cuáles apagados. Aplicarlo renombra .jar y .jar.disabled en la carpeta mods/ de la instancia; lo que el set no
// conoce (un mod instalado después de guardarlo) queda como estaba. Si un renombrado falla, se vuelve todo atrás.
// Pruebas: node --test "src/main/modules/modsets/test/"
const fsp = require('fs/promises');
const path = require('path');

const MAX_SETS = 30;
const MAX_ENTRIES = 3000;
const NAME_MAX = 40;
const DISABLED = /\.disabled$/i;
const MOD_FILE = /\.(jar|zip|litemod)$/i;
const BAD_NAME = /[\\/\x00-\x1f<>:"|?*]/;
const SET_ID = /^[A-Za-z0-9_-]{1,40}$/;
const PROJECT = /^(modrinth|curseforge):[A-Za-z0-9_-]{1,40}$/;
const BUILTIN = new Set(['minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt_base', 'forge', 'neoforge', 'fml', 'javafml', 'mixinextras']);
// fabric-api trae adentro sus módulos (fabric-api-base, fabric-resource-loader-v0...): el .jar no los declara.
const FABRIC_MODULE = /^fabric[-_]/;
const FABRIC_API_IDS = ['fabric-api', 'fabric', 'quilted_fabric_api'];

// Plantillas: arrancan con los mods de ese estilo que ya están en la instancia y el usuario las completa.
const TEMPLATES = {
  pvp: /keystroke|\bcps\b|cps-?|armor-?hud|armorhud|zoom|hud|betterf3|better-?pvp|sprint|tiers?|fps-?display|fpsdisplay|fps-?reducer|coordinates|dynamic-?fps|appleskin|sodium|lithium/i,
  shaders: /iris|oculus|optifine|optifabric|sodium|embeddium|indium|reeses|nvidium|distant-?horizons|immediatelyfast/i,
  lite: /sodium|embeddium|lithium|phosphor|starlight|nvidium|c2me|krypton|lazydfu|immediatelyfast|entityculling|entity-?culling|dynamic-?fps|ferrite-?core|smoothboot|fastload|moreculling|sodium-extra|alternate-?current|spark/i,
};
const TEMPLATE_IDS = Object.keys(TEMPLATES);

function baseName(file) {
  return String(file ?? '').replace(DISABLED, '');
}

function validFileName(file) {
  return typeof file === 'string' && file.length > 0 && file.length <= 255 && file !== '.' && file !== '..' && !BAD_NAME.test(file) && MOD_FILE.test(baseName(file));
}

function cleanName(raw) {
  const name = String(raw ?? '').replace(/[\x00-\x1f\x7f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return name ? Array.from(name).slice(0, NAME_MAX).join('') : null;
}

function normalizeEntries(raw) {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(raw) ? raw : []) {
    if (!e || typeof e !== 'object') continue;
    const file = baseName(e.file);
    if (!validFileName(file)) continue;
    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, project: typeof e.project === 'string' && PROJECT.test(e.project) ? e.project : null, on: e.on === true });
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

function newSetId() {
  return `set-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function normalizeSet(raw, { now = Date.now() } = {}) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const name = cleanName(r.name);
  if (!name) return null;
  const createdAt = Number(r.createdAt) > 0 ? Number(r.createdAt) : now;
  return {
    id: typeof r.id === 'string' && SET_ID.test(r.id) ? r.id : newSetId(),
    name,
    template: TEMPLATE_IDS.includes(r.template) ? r.template : null,
    entries: normalizeEntries(r.entries),
    createdAt,
    updatedAt: Number(r.updatedAt) > 0 ? Number(r.updatedAt) : createdAt,
  };
}

function normalizeStore(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const sets = [];
  const ids = new Set();
  for (const item of Array.isArray(r.sets) ? r.sets : []) {
    const set = normalizeSet(item);
    if (!set || ids.has(set.id)) continue;
    ids.add(set.id);
    sets.push(set);
    if (sets.length >= MAX_SETS) break;
  }
  const last = r.lastApply && typeof r.lastApply === 'object' ? r.lastApply : null;
  return {
    version: 1,
    sets,
    lastApply: last && typeof last.snapshotId === 'string' && last.snapshotId ? { setId: String(last.setId ?? '').slice(0, 40), name: cleanName(last.name) || '', snapshotId: last.snapshotId.slice(0, 80), at: Number(last.at) || 0 } : null,
  };
}

// Mods de la carpeta -> { file, name, enabled, project }. project es la identidad que sobrevive a una actualización.
function projectOf(records, name) {
  for (const [source, projects] of Object.entries(records || {})) {
    for (const [id, rec] of Object.entries(projects || {})) {
      if (baseName(rec?.file) === name && (!rec.folder || rec.folder === 'mods')) return `${source}:${id}`;
    }
  }
  return null;
}

// Lo que recuerda un set a partir de lo que hay ahora en la carpeta (on: lista de nombres; sin lista, lo activo).
function entriesFromFiles(files, on) {
  const active = on ? new Set(on) : null;
  return files.map((f) => ({ file: f.name, project: f.project || null, on: active ? active.has(f.name) : f.enabled }));
}

// Plantilla inicial: prendidos los que coinciden por nombre o título; el usuario completa el resto en el editor.
function templateEntries(id, files) {
  const re = TEMPLATES[id];
  if (!re) return [];
  return files.map((f) => ({ file: f.name, project: f.project || null, on: re.test(f.name) || re.test(f.title || '') }));
}

function entryFor(set, file) {
  const low = file.name.toLowerCase();
  return set.entries.find((e) => e.file.toLowerCase() === low) || (file.project ? set.entries.find((e) => e.project === file.project) : null) || null;
}

// Qué haría aplicar el set: { renames: [{ from, to }], enable, disable, unknown, missing, conflicts }.
// conflicts: x.jar y x.jar.disabled conviven, no se elige uno a ciegas (quedan como están).
function planApply(set, files) {
  const names = new Set(files.map((f) => f.file.toLowerCase()));
  const plan = { renames: [], enable: [], disable: [], same: [], unknown: [], missing: [], conflicts: [] };
  const used = new Set();
  for (const f of files) {
    const entry = entryFor(set, f);
    if (!entry) {
      plan.unknown.push(f.name);
      continue;
    }
    used.add(entry);
    if (entry.on === f.enabled) {
      plan.same.push(f.name);
      continue;
    }
    const to = entry.on ? f.name : `${f.name}.disabled`;
    if (names.has(to.toLowerCase())) {
      plan.conflicts.push(f.name);
      continue;
    }
    plan.renames.push({ from: f.file, to });
    (entry.on ? plan.enable : plan.disable).push(f.name);
  }
  for (const e of set.entries) if (e.on && !used.has(e)) plan.missing.push(e.file);
  return plan;
}

// Qué mods quedan prendidos si se aplica un set: lo que dice el set y, lo que no conoce, como está ahora.
function activeAfter(entries, files) {
  const set = { entries };
  return files.filter((f) => {
    const entry = entryFor(set, f);
    return entry ? entry.on : f.enabled;
  }).map((f) => f.name);
}

// Renombra en orden; si uno falla, deshace los anteriores y relanza el error (la carpeta queda como estaba).
async function executeRenames(dir, renames, { rename = fsp.rename } = {}) {
  const done = [];
  try {
    for (const r of renames) {
      await rename(path.join(dir, r.from), path.join(dir, r.to));
      done.push(r);
    }
  } catch (err) {
    for (const r of done.reverse()) await rename(path.join(dir, r.to), path.join(dir, r.from)).catch(() => {});
    err.renamed = 0;
    err.failedFile = renames[done.length]?.from;
    throw err;
  }
  return done.length;
}

function idsOf(mod) {
  return [mod.id, ...(mod.provides || [])].filter(Boolean).map((x) => String(x).toLowerCase());
}

// Ids obligatorios que pide un mod de los metadatos de su propio .jar.
function requiredOf(mod) {
  const out = new Set();
  for (const id of Object.keys(mod.depends || {})) out.add(String(id).toLowerCase());
  for (const d of mod.deps || []) if (d?.type === 'required' && d.modId) out.add(String(d.modId).toLowerCase());
  for (const id of BUILTIN) out.delete(id);
  return [...out];
}

// Dependencias que el set deja afuera: un mod prendido pide algo que está en la carpeta pero queda apagado.
// mods: [{ name, title, mods: [metadatos del .jar] }], active: nombres que quedan prendidos.
// Lo que no está en la carpeta no se avisa: pudo venir adentro de otro .jar y el set no cambia nada ahí.
// -> [{ file, title, dep, provider, providerTitle }]
function missingDependencies(mods, active) {
  const on = new Set(active);
  const providers = new Map(); // id -> mod
  for (const m of mods) for (const inner of m.mods || []) for (const id of idsOf(inner)) if (!providers.has(id)) providers.set(id, m);
  const activeIds = new Set();
  for (const m of mods) if (on.has(m.name)) for (const inner of m.mods || []) for (const id of idsOf(inner)) activeIds.add(id);
  const out = [];
  const seen = new Set();
  for (const m of mods) {
    if (!on.has(m.name)) continue;
    for (const inner of m.mods || []) {
      for (const dep of requiredOf(inner)) {
        const module = FABRIC_MODULE.test(dep) && !providers.has(dep);
        const satisfied = module ? FABRIC_API_IDS.some((id) => activeIds.has(id)) : activeIds.has(dep);
        if (satisfied) continue;
        const provider = module ? FABRIC_API_IDS.map((id) => providers.get(id)).find(Boolean) : providers.get(dep);
        if (!provider || on.has(provider.name)) continue;
        const key = `${m.name}|${provider.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ file: m.name, title: m.title || m.name, dep, provider: provider.name, providerTitle: provider.title || provider.name });
      }
    }
  }
  return out;
}

module.exports = {
  MAX_SETS,
  NAME_MAX,
  TEMPLATE_IDS,
  baseName,
  validFileName,
  cleanName,
  newSetId,
  normalizeEntries,
  normalizeSet,
  normalizeStore,
  projectOf,
  entriesFromFiles,
  templateEntries,
  planApply,
  activeAfter,
  executeRenames,
  missingDependencies,
};
