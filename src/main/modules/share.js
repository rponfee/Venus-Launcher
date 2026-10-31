'use strict';
// Compartir instancias: manifiesto (lista de mods por hash de Modrinth/CurseForge + configs de texto),
// diferencias, aplicar una revision y crear una instancia identica a partir de un codigo.
// Las llamadas a Supabase (codigos, grupos, revisiones) las hace la interfaz con cloud.client;
// aca solo se trabaja con archivos. La logica esta en ./share/*.
//
// Canales:
//   share:buildManifest(instanceId, opts)        -> manifiesto { name, mcVersion, loader, loaderVersion, files, manual, configs, ... }
//   share:encode(manifest)                       -> { manifest (configs comprimidas), bytes } para guardar en la nube
//   share:preview(manifest)                      -> manifiesto validado sin el contenido de las configs (vista previa)
//   share:diff(instanceId, manifest, { fresh })  -> { added, removed, updated, toggled, extra, configs, version, summary }
//   share:compare(viejo, nuevo)                  -> cambios entre dos manifiestos (antes de publicar una revision)
//   share:applyManifest(instanceId, manifest, { removeMissing, applyOptions, fresh, revision }) -> resumen (tarea)
//   share:createFromManifest(manifest, { name, applyOptions, share }) -> { instance, summary } (tarea)
//   share:state(instanceId)                      -> revision aplicada en esta PC (o null)
//   share:forget(instanceId)                     -> olvida el estado (al dejar un grupo)
const tasks = require('../core/tasks');
const instances = require('../core/instances');
const { t } = require('../core/i18n');
const { rmrf } = require('../core/util');
const files = require('./share/files');
const manifestLib = require('./share/manifest');
const { computeDiff, forUi } = require('./share/diff');
const applyLib = require('./share/apply');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^PACK-[A-HJ-NP-Z2-9]{6}$/;

let emit = () => {};

function cleanOpts(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  return {
    includeConfigs: o.includeConfigs !== false,
    includeOptions: Boolean(o.includeOptions),
    folders: Array.isArray(o.folders) ? o.folders.filter((f) => files.CONTENT_FOLDERS.includes(f)) : undefined,
  };
}

// Datos del grupo/codigo que se guardan en la instancia (instance.share).
function cleanShareMeta(s) {
  if (!s || typeof s !== 'object') return null;
  if (!UUID_RE.test(String(s.packId || '')) || !CODE_RE.test(String(s.code || ''))) return null;
  return {
    packId: String(s.packId),
    code: String(s.code),
    name: manifestLib.cleanText(s.name, 60) || String(s.code),
    revision: Number.isInteger(s.revision) && s.revision >= 0 ? s.revision : 0,
    role: ['owner', 'member', 'copy'].includes(s.role) ? s.role : 'copy',
    isGroup: Boolean(s.isGroup),
    auto: s.auto !== false,
    owner: typeof s.owner === 'string' && UUID_RE.test(s.owner) ? s.owner : null,
    ownerName: manifestLib.cleanText(s.ownerName, 40),
    syncedAt: Date.now(),
  };
}

// Vista previa: manifiesto validado + resumen, sin el contenido de las configs.
function preview(raw) {
  const m = manifestLib.normalizeManifest(raw);
  const bytes = (list) => list.reduce((a, e) => a + (e.size || 0), 0);
  const by = (folder) => m.files.filter((e) => e.path.startsWith(`${folder}/`));
  return {
    name: m.name,
    mcVersion: m.mcVersion,
    loader: m.loader,
    loaderVersion: m.loaderVersion,
    preset: m.preset,
    icon: m.icon,
    files: m.files.map(({ key: _k, url: _u, ...e }) => e),
    manual: m.manual,
    configs: m.configs.filter((c) => !files.OPTION_FILES.includes(c.path)).map((c) => c.path),
    options: m.configs.filter((c) => files.OPTION_FILES.includes(c.path)).map((c) => c.path),
    stats: {
      mods: by('mods').length,
      resourcepacks: by('resourcepacks').length,
      shaderpacks: by('shaderpacks').length,
      manual: m.manual.length,
      configs: m.configs.length,
      downloadBytes: bytes(m.files),
      curseforge: m.files.filter((e) => e.source === 'curseforge').length,
    },
  };
}

// Cambios entre dos manifiestos (lo publicado y lo que hay ahora), sin tocar el disco.
function compare(rawOld, rawNew) {
  const a = manifestLib.normalizeManifest(rawOld);
  const b = manifestLib.normalizeManifest(rawNew);
  const keyOf = (e) => `${e.path.split('/')[0]}|${e.key}`;
  const oldByKey = new Map(a.files.map((e) => [keyOf(e), e]));
  const newByKey = new Map(b.files.map((e) => [keyOf(e), e]));
  const slim = (e) => ({ path: e.path, title: e.title, icon: e.icon || null, versionNumber: e.versionNumber || null });
  const added = [];
  const updated = [];
  const toggled = [];
  for (const [k, e] of newByKey) {
    const o = oldByKey.get(k);
    if (!o) added.push(slim(e));
    else if (o.sha1 !== e.sha1) updated.push({ ...slim(e), from: o.versionNumber || o.path.split('/')[1] });
    else if (o.enabled !== e.enabled) toggled.push({ ...slim(e), enabled: e.enabled });
  }
  const removed = [...oldByKey].filter(([k]) => !newByKey.has(k)).map(([, e]) => slim(e));
  const oldManual = new Map(a.manual.map((e) => [e.path, e]));
  const newManual = new Map(b.manual.map((e) => [e.path, e]));
  const manualAdded = [...newManual.keys()].filter((p) => !oldManual.has(p)).map((p) => ({ path: p, title: newManual.get(p).title }));
  const manualRemoved = [...oldManual.keys()].filter((p) => !newManual.has(p)).map((p) => ({ path: p, title: oldManual.get(p).title }));
  const oldConf = new Map(a.configs.map((c) => [c.path, files.sha1Text(c.content)]));
  const newConf = new Map(b.configs.map((c) => [c.path, files.sha1Text(c.content)]));
  let configsChanged = 0;
  for (const [p, h] of newConf) if (oldConf.get(p) !== h) configsChanged++;
  const configsRemoved = [...oldConf.keys()].filter((p) => !newConf.has(p)).length;
  const version =
    a.mcVersion !== b.mcVersion || a.loader !== b.loader || (a.loaderVersion || null) !== (b.loaderVersion || null) || a.preset !== b.preset
      ? { from: { mcVersion: a.mcVersion, loader: a.loader, loaderVersion: a.loaderVersion }, to: { mcVersion: b.mcVersion, loader: b.loader, loaderVersion: b.loaderVersion } }
      : null;
  const summary = {
    added: added.length + manualAdded.length,
    removed: removed.length + manualRemoved.length,
    updated: updated.length,
    toggled: toggled.length,
    configs: configsChanged + configsRemoved,
    version: Boolean(version),
    name: a.name !== b.name,
  };
  return {
    added,
    removed,
    updated,
    toggled,
    manualAdded,
    manualRemoved,
    configsChanged,
    configsRemoved,
    version,
    summary,
    changed: Object.entries(summary).some(([, v]) => (typeof v === 'number' ? v > 0 : v)),
  };
}

async function diff(instanceId, raw, opts = {}) {
  const inst = await instances.get(instanceId);
  const m = manifestLib.normalizeManifest(raw);
  const prev = opts?.fresh ? null : await applyLib.readState(inst.dir);
  const d = await computeDiff(inst, m, prev, { lookup: (h) => manifestLib.lookupHashes(h, { soft: true }) });
  return { ...forUi(d), linked: Boolean(prev), prevRevision: prev?.revision ?? null };
}

function cleanApplyOpts(o) {
  const opts = o && typeof o === 'object' ? o : {};
  return {
    removeMissing: Boolean(opts.removeMissing),
    applyOptions: Boolean(opts.applyOptions),
    fresh: Boolean(opts.fresh),
    revision: Number.isInteger(opts.revision) && opts.revision >= 0 ? opts.revision : null,
  };
}

async function applyManifest(instanceId, manifest, opts = {}) {
  const inst = await instances.get(instanceId);
  const clean = cleanApplyOpts(opts);
  const result = await tasks.run(
    t('share.taskApply', { name: inst.name }),
    (task) => applyLib.applyManifest(instanceId, manifest, clean, task),
    { instanceId, kind: 'share:apply' },
  );
  if (opts?.share) {
    const meta = cleanShareMeta(opts.share);
    if (meta) await instances.update(instanceId, { share: meta });
  }
  emit('instances:changed');
  return result;
}

async function createFromManifest(manifest, opts = {}) {
  const m = manifestLib.normalizeManifest(manifest);
  const name = manifestLib.cleanText(opts?.name, 60) || m.name;
  const inst = await instances.create({ name, mcVersion: m.mcVersion, loader: m.loader, loaderVersion: m.loaderVersion || 'latest', preset: m.preset, icon: m.icon });
  emit('instances:changed');
  let applied = false;
  try {
    return await tasks.run(
      t('share.taskCreate', { name: inst.name }),
      async (task) => {
        const summary = await applyLib.applyManifest(
          inst.id,
          m,
          { fresh: true, removeMissing: true, applyOptions: opts?.applyOptions !== false, revision: Number.isInteger(opts?.revision) ? opts.revision : null },
          task,
          { from: 0, to: 0.55 },
        );
        applied = true;
        const meta = cleanShareMeta(opts?.share);
        if (meta) await instances.update(inst.id, { share: meta });
        emit('instances:changed');
        // Deja el juego y el loader instalados (si falla, se reintenta al jugar).
        try {
          await instances.prepare(inst.id, task);
        } catch (err) {
          if (task.signal.aborted) throw err;
          summary.warnings.push(t('share.warnPrepare', { error: err?.message || String(err) }));
        }
        return { instance: await instances.get(inst.id), summary };
      },
      { instanceId: inst.id, kind: 'share:create' },
    );
  } catch (err) {
    if (!applied) await rmrf(instances.dir(inst.id)).catch(() => {});
    throw err;
  } finally {
    emit('instances:changed');
  }
}

function register({ handle, send }) {
  emit = (channel, ...args) => {
    try {
      send(channel, ...args);
    } catch {
      /* ventana cerrada */
    }
  };

  handle('share:buildManifest', (instanceId, opts) => manifestLib.buildManifest(instanceId, cleanOpts(opts)));
  handle('share:encode', (manifest) => manifestLib.encodeManifest(manifest));
  handle('share:preview', (manifest) => preview(manifest));
  handle('share:diff', (instanceId, manifest, opts) => diff(instanceId, manifest, opts || {}));
  handle('share:compare', (a, b) => compare(a, b));
  handle('share:applyManifest', (instanceId, manifest, opts) => applyManifest(instanceId, manifest, opts || {}));
  handle('share:createFromManifest', (manifest, opts) => createFromManifest(manifest, opts || {}));
  handle('share:state', async (instanceId) => {
    const inst = await instances.get(instanceId);
    const s = await applyLib.readState(inst.dir);
    return s ? { revision: s.revision, appliedAt: s.appliedAt, mcVersion: s.mcVersion, loader: s.loader, files: s.files.length } : null;
  });
  handle('share:forget', async (instanceId) => {
    const inst = await instances.get(instanceId);
    await applyLib.forgetState(inst.dir);
    return true;
  });

  // No dejar jugar mientras se aplica una revision (la instancia quedaria a medio cambiar).
  try {
    require('../core/game').addBeforeLaunch(async ({ id }) => (applyLib.isBusy(id) ? { block: true, message: t('share.errBusyLaunch') } : null));
  } catch (err) {
    console.warn('[share] beforeLaunch:', err?.message || err);
  }
}

module.exports = {
  register,
  buildManifest: (instanceId, opts) => manifestLib.buildManifest(instanceId, cleanOpts(opts)),
  applyManifest: (instanceId, manifest, opts) => applyLib.applyManifest(instanceId, manifest, cleanApplyOpts(opts)),
  diff,
  compare,
  preview,
  createFromManifest,
  normalizeManifest: manifestLib.normalizeManifest,
  encodeManifest: manifestLib.encodeManifest,
};
