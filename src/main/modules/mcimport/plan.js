'use strict';
// Plan de importacion, sin Electron: que instancias se crean y que se copia en cada una, a partir del escaneo y
// de lo que eligio el usuario. Todo lo que llega de la interfaz se valida contra el escaneo (ids de perfiles y
// de carpetas, destino del contenido, categorias y nombres de mundos): lo que no coincide se ignora.
//
// Regla de las carpetas compartidas: varios perfiles suelen usar la misma .minecraft. Su contenido se copia una
// sola vez, a la instancia elegida (por defecto, la del perfil usado mas recientemente; si la carpeta tiene mods,
// la del perfil con mods usado mas recientemente). Los perfiles con carpeta propia traen su propio contenido.
const path = require('path');
const safety = require('../packs/safety');
const { CATEGORIES, MODDED_ONLY, OPTION_FILES, FOLDER_OF } = require('./scan');

const MAX_PROFILES = 40;
const NAME_MAX = 60;

const importable = (p) => Boolean(p && p.version && p.version.ok);

// Nombre libre entre los que ya existen: "Nombre", "Nombre (2)", "Nombre (3)"... (sin distinguir mayusculas).
function uniqueName(base, taken) {
  const clean = String(base || 'Minecraft').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) || 'Minecraft';
  const has = (n) => taken.has(n.toLowerCase());
  let name = clean;
  for (let n = 2; has(name) && n < 1000; n++) {
    const suffix = ` (${n})`;
    name = `${clean.slice(0, NAME_MAX - suffix.length).trim()}${suffix}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

// Perfiles elegidos que pueden recibir el contenido de una carpeta: los que la usan o, si ningun perfil la usa
// (por ejemplo la .minecraft cuando todos tienen carpeta propia), cualquiera de los elegidos. Mas reciente primero.
function targetCandidates(group, selected) {
  const using = selected.filter((p) => group.profileIds.includes(p.id));
  const list = group.profileIds.length ? using : selected;
  return [...list].sort((a, b) => b.lastUsed - a.lastUsed || a.suggestedName.localeCompare(b.suggestedName));
}

function defaultTarget(group, candidates) {
  if (!candidates.length) return null;
  if (group.content?.mods?.count > 0) {
    const modded = candidates.find((p) => p.modded);
    if (modded) return modded;
  }
  return candidates[0];
}

function categoryAllowed(cat, target) {
  return Boolean(target) && (!MODDED_ONLY.has(cat) || target.modded);
}

// Lo que se marca por defecto: todo lo que tiene contenido y sirve para el destino (los shaders no sirven en vanilla).
function defaultCategories(group, target) {
  const out = {};
  for (const cat of CATEGORIES) {
    const has = group.content?.[cat]?.count > 0;
    out[cat] = has && categoryAllowed(cat, target) && !(cat === 'shaderpacks' && target?.version?.loader === 'vanilla');
  }
  return out;
}

// Nombre de carpeta valido en Venus para un mundo (la carpeta original puede tener un nombre que Windows no acepta).
// Va siempre dentro de saves/, asi que no puede chocar con los archivos internos de la instancia.
function safeFolderName(name) {
  if (safety.validSegment(name)) return name;
  let out = String(name || '')
    .replace(/[\x00-\x1f\x7f<>:"|?*\\/]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 80);
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(out)) out = `_${out}`;
  if (!out || out === '.' || out === '..' || !safety.validSegment(out)) out = 'world';
  return out;
}

function uniqueFolder(name, taken) {
  let out = name;
  for (let n = 2; taken.has(out.toLowerCase()) && n < 1000; n++) out = `${name} (${n})`;
  taken.add(out.toLowerCase());
  return out;
}

const bool = (v) => v === true;

/**
 * Normaliza lo que manda la interfaz: { dir, profiles: [id], groups: { [groupId]: { target, categories: { worlds:
 * true | false | [carpetas], mods, resourcepacks, shaderpacks, config, options, servers } } } }.
 */
function normalizeSelection(raw) {
  const sel = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const ids = Array.isArray(sel.profiles) ? sel.profiles.filter((x) => typeof x === 'string' && x.length <= 140) : [];
  const groups = {};
  const rawGroups = sel.groups && typeof sel.groups === 'object' && !Array.isArray(sel.groups) ? sel.groups : {};
  for (const [gid, g] of Object.entries(rawGroups).slice(0, 100)) {
    if (!/^[0-9a-f]{12}$/.test(gid) || !g || typeof g !== 'object') continue;
    const cats = g.categories && typeof g.categories === 'object' ? g.categories : {};
    const out = { target: typeof g.target === 'string' && g.target.length <= 140 ? g.target : null, categories: {} };
    for (const cat of CATEGORIES) {
      if (!(cat in cats)) continue;
      if (cat === 'worlds' && Array.isArray(cats.worlds)) out.categories.worlds = cats.worlds.filter((w) => typeof w === 'string' && w.length <= 255).slice(0, 1000);
      else out.categories[cat] = bool(cats[cat]);
    }
    groups[gid] = out;
  }
  return { dir: typeof sel.dir === 'string' ? sel.dir : null, profiles: [...new Set(ids)], groups };
}

/**
 * Arma el plan. scan: resultado de scanFolder. selection: normalizeSelection(...). opts: { existingNames }.
 * Devuelve { instances: [{ profileId, profileKey, profileName, name, mcVersion, loader, loaderVersion, copies, bytes }],
 * bytes, files, worlds, groups: [{ id, dir, target }] } o { error: 'nothing' | 'changed' | 'tooMany' }.
 */
function buildPlan(scan, selection, { existingNames = [] } = {}) {
  const sel = normalizeSelection(selection);
  const byId = new Map((scan?.profiles || []).map((p) => [p.id, p]));
  if (sel.profiles.some((id) => !byId.has(id))) return { error: 'changed' };
  const chosen = sel.profiles.map((id) => byId.get(id)).filter(importable);
  if (!chosen.length) return { error: 'nothing' };
  if (chosen.length > MAX_PROFILES) return { error: 'tooMany' };
  // En el orden del escaneo (usado mas reciente primero), no en el de la seleccion.
  chosen.sort((a, b) => scan.profiles.indexOf(a) - scan.profiles.indexOf(b));

  const taken = new Set(existingNames.filter((n) => typeof n === 'string').map((n) => n.toLowerCase()));
  const planned = chosen.map((p) => ({
    profileId: p.id,
    profileKey: p.key,
    profileName: p.name || p.suggestedName,
    name: uniqueName(p.suggestedName, taken),
    mcVersion: p.version.mcVersion,
    loader: p.version.loader,
    loaderVersion: p.version.loaderVersion || null,
    copies: [],
    bytes: 0,
    worldFolders: new Set(),
  }));
  const plannedById = new Map(planned.map((x) => [x.profileId, x]));

  const groupsOut = [];
  for (const g of scan.groups || []) {
    if (!g.exists || g.problem || !g.hasContent) continue;
    const candidates = targetCandidates(g, chosen);
    if (!candidates.length) continue;
    const want = sel.groups[g.id] || {};
    const target = candidates.find((p) => p.id === want.target) || defaultTarget(g, candidates);
    const cats = { ...defaultCategories(g, target), ...want.categories };
    const dest = plannedById.get(target.id);
    let used = false;
    for (const cat of CATEGORIES) {
      const info = g.content?.[cat];
      if (!info || !info.count || !categoryAllowed(cat, target)) continue;
      const pick = cats[cat];
      if (!pick) continue;
      if (cat === 'worlds') {
        const wanted = Array.isArray(pick) ? new Set(pick) : null;
        for (const w of info.items || []) {
          if (wanted && !wanted.has(w.folder)) continue;
          const folder = uniqueFolder(safeFolderName(w.folder), dest.worldFolders);
          dest.copies.push({ category: 'worlds', kind: 'world', src: path.join(g.dir, 'saves', w.folder), dest: `saves/${folder}`, bytes: w.bytes || 0, files: w.files || 0, label: w.name || w.folder, groupId: g.id, groupDir: g.dir });
          dest.bytes += w.bytes || 0;
          used = true;
        }
      } else if (cat === 'options') {
        for (const file of info.files || []) {
          if (!OPTION_FILES.includes(file)) continue;
          dest.copies.push({ category: 'options', kind: 'file', src: path.join(g.dir, file), dest: file, bytes: 0, files: 1, label: file, groupId: g.id, groupDir: g.dir });
        }
        dest.bytes += info.bytes || 0;
        used = true;
      } else if (cat === 'servers') {
        dest.copies.push({ category: 'servers', kind: 'file', src: path.join(g.dir, 'servers.dat'), dest: 'servers.dat', bytes: info.bytes || 0, files: 1, label: 'servers.dat', groupId: g.id, groupDir: g.dir });
        dest.bytes += info.bytes || 0;
        used = true;
      } else {
        const folder = FOLDER_OF[cat];
        dest.copies.push({ category: cat, kind: 'dir', src: path.join(g.dir, folder), dest: folder, bytes: info.bytes || 0, files: info.files || 0, label: folder, groupId: g.id, groupDir: g.dir });
        dest.bytes += info.bytes || 0;
        used = true;
      }
    }
    if (used) groupsOut.push({ id: g.id, dir: g.dir, target: target.id });
  }

  const instances = planned.map(({ worldFolders: _w, ...rest }) => rest);
  return {
    instances,
    bytes: instances.reduce((a, x) => a + x.bytes, 0),
    files: instances.reduce((a, x) => a + x.copies.reduce((b, c) => b + (c.files || 0), 0), 0),
    worlds: instances.reduce((a, x) => a + x.copies.filter((c) => c.category === 'worlds').length, 0),
    groups: groupsOut,
  };
}

module.exports = { buildPlan, normalizeSelection, uniqueName, targetCandidates, defaultTarget, defaultCategories, categoryAllowed, safeFolderName, MAX_PROFILES };
