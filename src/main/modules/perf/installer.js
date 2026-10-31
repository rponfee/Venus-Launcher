'use strict';
// Instalacion en lote de proyectos de Modrinth en una instancia (con dependencias), compartida
// por la optimizacion y el catalogo de packs.
const instances = require('../../core/instances');
const modrinth = require('../../core/modrinth');
const { t } = require('../../core/i18n');

// Registra como proyectos de Modrinth los mods que ya estan en la carpeta pero no figuran
// (por ejemplo, los de un modpack). Asi las dependencias que ya existen no se bajan dos veces.
async function adoptExisting(instanceId) {
  const inst = await instances.get(instanceId);
  const projects = inst.modrinth?.projects || {};
  const known = new Set(Object.values(projects).map((r) => r.file));
  const files = (await modrinth.listFolder(inst.dir, 'mods')).filter((f) => !f.isDir && !known.has(f.file.replace(/\.disabled$/, '')));
  if (!files.length) return 0;
  const ids = await modrinth.identify(inst.dir, files);
  const add = {};
  for (const [file, info] of Object.entries(ids)) {
    if (!info.projectId || projects[info.projectId] || add[info.projectId]) continue;
    add[info.projectId] = {
      title: info.title || file,
      icon: info.icon || null,
      type: 'mod',
      versionId: info.versionId,
      versionNumber: info.versionNumber,
      file: file.replace(/\.disabled$/, ''),
      folder: 'mods',
      installedAt: Date.now(),
      adopted: true,
    };
  }
  const count = Object.keys(add).length;
  if (count) {
    const fresh = await instances.get(instanceId);
    await instances.update(instanceId, { modrinth: { ...fresh.modrinth, projects: { ...add, ...(fresh.modrinth?.projects || {}) } } });
  }
  return count;
}

// items: [{ projectId, versionId?, title?, slug?, type? }]
// Devuelve { installed: [titulos], skipped: [titulos], failed: [{ title, error }], warnings: [] }
async function installAll(instanceId, items, task, { from = 0, to = 1 } = {}) {
  const result = { installed: [], skipped: [], failed: [], warnings: [] };
  if (!items.length) return result;
  task?.update({ detail: t('perf.taskScanning'), progress: from });
  try {
    await adoptExisting(instanceId);
  } catch (err) {
    console.warn('[perf] No se pudieron reconocer los mods existentes:', err.message);
  }
  const n = items.length;
  for (let i = 0; i < n; i++) {
    if (task?.signal?.aborted) throw task.signal.reason || new Error(t('perf.errCancelled'));
    const it = items[i];
    const title = it.title || it.slug || it.projectId;
    const inst = await instances.get(instanceId);
    if (inst.modrinth?.projects?.[it.projectId]) {
      result.skipped.push(title);
      continue;
    }
    const a = from + ((to - from) * i) / n;
    const b = from + ((to - from) * (i + 1)) / n;
    task?.update({ detail: t('perf.taskInstalling', { title, current: i + 1, total: n }), progress: a });
    // Tarea "intermedia": el avance de cada descarga ocupa su tramo de la barra general
    const sub = task
      ? {
          signal: task.signal,
          update: (p) => task.update(p),
          downloadProgress: (label) => task.downloadProgress(label, a, b),
        }
      : undefined;
    try {
      const r = await instances.installProject(instanceId, it.projectId, it.versionId || null, { task: sub, type: it.type });
      result.installed.push(...(r.installed || [title]));
      result.warnings.push(...(r.warnings || []));
    } catch (err) {
      if (task?.signal?.aborted) throw err;
      result.failed.push({ title, error: err.message });
    }
  }
  task?.update({ progress: to });
  return result;
}

module.exports = { adoptExisting, installAll };
