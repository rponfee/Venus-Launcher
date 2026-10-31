'use strict';
// Diferencias entre un manifiesto y lo que hay en la instancia:
//   added      mods/packs del manifiesto que faltan (se descargan)
//   updated    mismo proyecto con otro archivo (se reemplaza)
//   toggled    mismo archivo, pero activado/desactivado distinto
//   removed    estaban en la revision anterior que se aplico y el anfitrion los saco (o duplicados)
//   extra      archivos propios que no estan en el pack (solo se quitan con removeMissing)
//   configs    configs para escribir: nuevas, cambiadas por el anfitrion o borradas aca
const path = require('path');
const files = require('./files');

const keyFromRecord = (projectId) => `mr:${projectId}`;

function versionInfo(inst, m) {
  const loaderChanged = inst.loader !== m.loader;
  const lvA = inst.loaderVersion && inst.loaderVersion !== 'latest' ? inst.loaderVersion : null;
  const lvB = m.loaderVersion && m.loaderVersion !== 'latest' ? m.loaderVersion : null;
  const changed = inst.mcVersion !== m.mcVersion || loaderChanged || Boolean(lvB && lvA !== lvB) || (m.preset === 'iris') !== (inst.preset === 'iris');
  return {
    changed,
    from: { mcVersion: inst.mcVersion, loader: inst.loader, loaderVersion: inst.loaderVersion || null, preset: inst.preset || null },
    to: { mcVersion: m.mcVersion, loader: m.loader, loaderVersion: m.loaderVersion || null, preset: m.preset || null },
  };
}

/**
 * inst: instancia (core/instances.get), m: manifiesto normalizado, prev: estado aplicado antes (o null).
 * opts.lookup(hashes) -> Map(sha1 -> { projectId } | null) para identificar archivos locales desconocidos.
 * opts.local: listado ya calculado (scanContent).
 */
async function computeDiff(inst, m, prev, opts = {}) {
  const instDir = inst.dir;
  const local = opts.local || (await files.scanContent(instDir, { hash: true }));
  const localFiles = local.filter((f) => !f.dir && f.sha1);
  const matched = new Set();
  const out = { added: [], updated: [], toggled: [], removed: [], extra: [], manualMissing: [], manualPresent: 0, unchanged: 0 };
  const folderOf = (p) => p.split('/')[0];

  // 1) Mismo hash en la misma carpeta: ya esta (quizas con otro estado activado/desactivado)
  const pending = [];
  const all = [...m.files.map((e) => ({ e, manual: false })), ...m.manual.filter((e) => !e.dir).map((e) => ({ e, manual: true }))];
  for (const item of all) {
    const { e } = item;
    if (!e.sha1) {
      pending.push(item);
      continue;
    }
    const cands = localFiles.filter((l) => !matched.has(l) && l.sha1 === e.sha1 && l.folder === folderOf(e.path));
    const hit = cands.find((l) => l.path === e.path) || cands[0];
    if (!hit) {
      pending.push(item);
      continue;
    }
    matched.add(hit);
    if (hit.enabled !== e.enabled) out.toggled.push({ entry: e, local: hit });
    else if (item.manual) out.manualPresent++;
    else out.unchanged++;
  }

  // 2) Identificar los archivos locales que sobran (para saber si son otra version de un mod del pack)
  const unmatched = localFiles.filter((l) => !matched.has(l));
  const keys = new Map(); // local -> key
  const prevBySha = new Map((prev?.files || []).filter((e) => e.sha1 && e.key).map((e) => [e.sha1, e.key]));
  const prevByPath = new Map((prev?.files || []).filter((e) => e.key).map((e) => [e.path, e.key]));
  const records = Object.entries(inst.modrinth?.projects || {});
  const unknown = [];
  for (const l of unmatched) {
    let key = prevBySha.get(l.sha1) || null;
    if (!key) {
      const rec = records.find(([, r]) => r?.file === l.base && (!r.folder || String(r.folder).replace(/\\/g, '/') === l.folder));
      if (rec) key = keyFromRecord(rec[0]);
    }
    if (!key) key = prevByPath.get(l.path) || null;
    if (key) keys.set(l, key);
    else unknown.push(l);
  }
  const wantsKeys = pending.some((p) => !p.manual) && unmatched.length;
  if (wantsKeys && unknown.length && typeof opts.lookup === 'function') {
    const found = await opts.lookup(unknown.map((l) => l.sha1));
    for (const l of unknown) {
      const info = found.get(l.sha1);
      if (info?.projectId) keys.set(l, keyFromRecord(info.projectId));
    }
  }

  // 3) Lo que falta: otra version del mismo proyecto -> updated; si no -> added
  const packKeys = new Set();
  for (const { e, manual } of pending) {
    if (manual) {
      const same = unmatched.find((l) => !matched.has(l) && l.path === e.path);
      if (same) {
        matched.add(same);
        out.manualPresent++;
      } else out.manualMissing.push(e);
      continue;
    }
    packKeys.add(`${folderOf(e.path)}|${e.key}`);
    const old = unmatched.find((l) => !matched.has(l) && l.folder === folderOf(e.path) && keys.get(l) === e.key);
    if (old) {
      matched.add(old);
      out.updated.push({ entry: e, local: old });
    } else out.added.push(e);
  }
  for (const e of m.files) packKeys.add(`${folderOf(e.path)}|${e.key}`);
  for (const e of m.manual) if (!e.dir) packKeys.add(`${folderOf(e.path)}|path:${e.path}`);

  // 4) Lo que sobra: sacado por el anfitrion (estaba en la revision anterior), duplicado de un mod del pack o propio
  const prevShas = new Set([...(prev?.files || []), ...(prev?.manual || [])].map((e) => e.sha1).filter(Boolean));
  const prevPaths = new Set([...(prev?.files || []), ...(prev?.manual || [])].map((e) => e.path));
  const prevKeys = new Set((prev?.files || []).map((e) => e.key).filter(Boolean));
  for (const l of unmatched) {
    if (matched.has(l)) continue;
    const key = keys.get(l);
    if (key && packKeys.has(`${l.folder}|${key}`)) out.removed.push({ local: l, reason: 'duplicate' });
    else if (prev && (prevShas.has(l.sha1) || prevPaths.has(l.path) || (key && prevKeys.has(key)))) out.removed.push({ local: l, reason: 'host' });
    else out.extra.push(l);
  }

  // 5) Configs
  const configs = { write: [], same: 0, kept: 0 };
  const options = { present: false, differs: false, write: [] };
  for (const c of m.configs) {
    const full = files.insideInstance(instDir, c.path);
    const current = await files.readTextIfSmall(full);
    if (files.OPTION_FILES.includes(c.path)) {
      options.present = true;
      const merged = files.mergeOptions(c.content, current || '');
      if (current === null || normalizeNl(current) !== normalizeNl(merged)) {
        options.differs = true;
        options.write.push({ path: c.path, content: merged });
      }
      continue;
    }
    const newHash = files.sha1Text(c.content);
    const localHash = current === null ? null : files.sha1Text(current);
    const prevHash = prev?.configs?.[c.path] || null;
    if (localHash === newHash) configs.same++;
    else if (!prev || prevHash !== newHash || localHash === null) configs.write.push({ path: c.path, content: c.content, kind: localHash === null ? 'added' : 'changed' });
    else configs.kept++;
  }

  const version = versionInfo(inst, m);
  return {
    ...out,
    configs,
    options,
    version,
    summary: {
      added: out.added.length,
      removed: out.removed.length,
      updated: out.updated.length,
      toggled: out.toggled.length,
      extra: out.extra.length,
      manualMissing: out.manualMissing.length,
      configs: configs.write.length,
      options: options.differs,
      version: version.changed,
    },
  };
}

function normalizeNl(s) {
  return String(s).replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

// Version liviana para mandar a la interfaz (sin el contenido de las configs).
function forUi(diff) {
  const slimLocal = (l) => (l ? { path: l.path, file: l.file, folder: l.folder, size: l.size, enabled: l.enabled } : null);
  const slimEntry = (e) => (e ? { path: e.path, title: e.title, icon: e.icon || null, versionNumber: e.versionNumber || null, source: e.source || null, size: e.size || 0, enabled: e.enabled !== false } : null);
  return {
    added: diff.added.map(slimEntry),
    updated: diff.updated.map((u) => ({ ...slimEntry(u.entry), from: slimLocal(u.local) })),
    toggled: diff.toggled.map((u) => ({ ...slimEntry(u.entry), from: slimLocal(u.local) })),
    removed: diff.removed.map((r) => ({ ...slimLocal(r.local), reason: r.reason })),
    extra: diff.extra.map(slimLocal),
    manualMissing: diff.manualMissing.map((e) => ({ path: e.path, title: e.title, size: e.size || 0 })),
    manualPresent: diff.manualPresent,
    unchanged: diff.unchanged,
    configs: { write: diff.configs.write.map((c) => ({ path: c.path, kind: c.kind })), same: diff.configs.same, kept: diff.configs.kept },
    options: { present: diff.options.present, differs: diff.options.differs },
    version: diff.version,
    summary: diff.summary,
  };
}

// Estado que se guarda despues de aplicar (para la proxima revision): hashes, no contenidos.
function appliedState(m, revision) {
  const configs = {};
  for (const c of m.configs) if (!files.OPTION_FILES.includes(c.path)) configs[c.path] = files.sha1Text(c.content);
  return {
    v: 1,
    revision: Number.isInteger(revision) ? revision : null,
    appliedAt: Date.now(),
    mcVersion: m.mcVersion,
    loader: m.loader,
    files: m.files.map((e) => ({ path: e.path, sha1: e.sha1, key: e.key })),
    manual: m.manual.filter((e) => !e.dir).map((e) => ({ path: e.path, sha1: e.sha1 || null })),
    configs,
  };
}

function statePath(instDir) {
  return path.join(instDir, files.VENUS_DIR, 'share-state.json');
}

module.exports = { computeDiff, forUi, appliedState, statePath, versionInfo };
