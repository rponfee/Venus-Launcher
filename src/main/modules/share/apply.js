'use strict';
// Aplica un manifiesto a una instancia: descarga lo que falta (verificando el sha1), reemplaza versiones,
// saca lo que el anfitrion quito, escribe configs y deja registrado el estado para la proxima revision.
// Primero descarga todo a una carpeta temporal: si algo falla, la instancia queda como estaba.
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const http = require('../../core/http');
const instances = require('../../core/instances');
const { t } = require('../../core/i18n');
const { readJson, writeJson, rmrf, exists } = require('../../core/util');
const files = require('./files');
const manifestLib = require('./manifest');
const safety = require('../packs/safety');
const { computeDiff, appliedState, statePath } = require('./diff');

const busy = new Set();
const chains = new Map();

// Una operacion a la vez por instancia
function withLock(id, fn) {
  const prev = chains.get(id) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    busy.add(id);
    try {
      return await fn();
    } finally {
      busy.delete(id);
    }
  });
  const tail = run.catch(() => {});
  chains.set(id, tail);
  tail.then(() => {
    if (chains.get(id) === tail) chains.delete(id);
  });
  return run;
}

function isBusy(id) {
  return busy.has(id);
}

function gameRunning(id) {
  try {
    return Boolean(require('../../core/game').status()[id]);
  } catch {
    return false;
  }
}

async function readState(instDir) {
  const s = await readJson(statePath(instDir), null);
  return s && s.v === 1 && Array.isArray(s.files) ? s : null;
}

async function forgetState(instDir) {
  await fsp.rm(statePath(instDir), { force: true }).catch(() => {});
}

const lookupSoft = (hashes) => manifestLib.lookupHashes(hashes, { soft: true });

// Pone lo descargado en su lugar renombrando encima (otro disco: copia por temporal). Nunca se escribe sobre
// un archivo existente: si es un enlace duro del almacen, cambiaria en todas las instancias que lo comparten.
async function moveInto(src, dest) {
  await safety.moveFile(src, dest);
}

function recordMatches(rec, folder, base) {
  return rec?.file === base && (!rec.folder || String(rec.folder).replace(/\\/g, '/') === folder);
}

/**
 * opts: { removeMissing, applyOptions, fresh (ignora la revision anterior), revision }
 * progress: { from, to } rango de la barra de la tarea para esta parte.
 */
async function applyInternal(instanceId, rawManifest, opts, task, progress = { from: 0, to: 1 }) {
  const m = manifestLib.normalizeManifest(rawManifest);
  let inst = await instances.get(instanceId);
  if (gameRunning(instanceId)) throw new Error(t('share.errGameRunning'));
  const span = (a) => progress.from + (progress.to - progress.from) * a;
  task?.update({ detail: t('share.stepCompare'), progress: span(0.02) });
  const prev = opts.fresh ? null : await readState(inst.dir);
  const diff = await computeDiff(inst, m, prev, { lookup: lookupSoft });
  const warnings = [];

  // ---------- Descargas a una carpeta temporal ----------
  const downloads = [...diff.added, ...diff.updated.map((u) => u.entry)];
  const mr = downloads.filter((e) => e.source === 'modrinth');
  const found = mr.length ? await lookupSoft(mr.map((e) => e.sha1)) : new Map();
  const tmpDir = path.join(inst.dir, files.VENUS_DIR, `share-incoming-${crypto.randomBytes(4).toString('hex')}`);
  const items = [];
  for (const e of downloads) {
    let url = null;
    let info = null;
    if (e.source === 'modrinth') {
      // La URL sale de Modrinth por el hash (fuente confiable); la del manifiesto es el respaldo.
      info = found.get(e.sha1) || null;
      url = (info && manifestLib.allowedDownload('modrinth', info.url)) || e.url;
    } else url = e.url;
    if (!url) {
      warnings.push(t('share.warnUnavailable', { name: e.title }));
      continue;
    }
    const base = e.path.split('/')[1];
    items.push({ entry: e, info, url, path: path.join(tmpDir, `${items.length}-${base}`), sha1: e.sha1, size: e.size || undefined });
  }

  try {
    if (items.length) {
      task?.update({ detail: t('share.stepDownload', { count: items.length }), progress: span(0.05) });
      await http.downloadAll(
        items.map(({ url, path: p, sha1, size }) => ({ url, path: p, sha1, size })),
        { concurrency: 6, verify: 'hash', signal: task?.signal, onProgress: task?.downloadProgress(t('share.progressLabel'), span(0.05), span(0.85)) },
      );
    }
    if (task?.signal?.aborted) throw task.signal.reason || new Error('aborted');
    if (gameRunning(instanceId)) throw new Error(t('share.errGameRunning'));
    task?.update({ detail: t('share.stepApply'), progress: span(0.88) });

    // ---------- Quitar ----------
    const removals = [...diff.removed.map((r) => r.local), ...(opts.removeMissing ? diff.extra : [])];
    const goneFiles = [];
    for (const l of removals) {
      const full = files.insideInstance(inst.dir, `${l.folder}/${l.file}`);
      await files.trash(full).catch((err) => warnings.push(t('share.warnRemove', { name: l.file, error: err.message })));
      goneFiles.push(l);
    }
    for (const u of diff.updated) {
      const full = files.insideInstance(inst.dir, `${u.local.folder}/${u.local.file}`);
      await files.trash(full).catch(() => {});
      goneFiles.push(u.local);
    }

    // ---------- Poner lo descargado ----------
    const placed = [];
    for (const it of items) {
      const [folder, base] = it.entry.path.split('/');
      const name = it.entry.enabled ? base : `${base}.disabled`;
      const dest = files.insideInstance(inst.dir, `${folder}/${name}`);
      const other = files.insideInstance(inst.dir, `${folder}/${it.entry.enabled ? `${base}.disabled` : base}`);
      if (await exists(dest)) await files.trash(dest).catch(() => fsp.rm(dest, { force: true }));
      if (await exists(other)) await files.trash(other).catch(() => fsp.rm(other, { force: true }));
      await moveInto(it.path, dest);
      placed.push({ ...it, folder, base });
    }

    // ---------- Activar / desactivar ----------
    for (const tg of diff.toggled) {
      const from = files.insideInstance(inst.dir, `${tg.local.folder}/${tg.local.file}`);
      const name = tg.entry.enabled ? tg.local.base : `${tg.local.base}.disabled`;
      const to = files.insideInstance(inst.dir, `${tg.local.folder}/${name}`);
      if (from === to) continue;
      if (await exists(to)) await files.trash(to).catch(() => {});
      await fsp.rename(from, to).catch((err) => warnings.push(t('share.warnToggle', { name: tg.local.base, error: err.message })));
    }

    // ---------- Configs ----------
    let configsWritten = 0;
    for (const c of diff.configs.write) {
      try {
        await files.writeTextAtomic(files.insideInstance(inst.dir, c.path), c.content);
        configsWritten++;
      } catch (err) {
        warnings.push(t('share.warnConfig', { name: c.path, error: err.message }));
      }
    }
    let optionsWritten = false;
    if (opts.applyOptions) {
      for (const c of diff.options.write) {
        await files.writeTextAtomic(files.insideInstance(inst.dir, c.path), c.content).catch(() => {});
        optionsWritten = true;
      }
    }

    // ---------- Version del juego / loader ----------
    if (diff.version.changed) {
      inst = await instances.update(instanceId, {
        mcVersion: m.mcVersion,
        loader: m.loader,
        loaderVersion: m.loaderVersion || 'latest',
        preset: m.preset || null,
        installed: false,
        versionId: null,
      });
      await instances.clearPrepared(instanceId).catch(() => {});
    }

    // ---------- Registros de Modrinth (titulos, iconos y actualizaciones en la pagina de la instancia) ----------
    // Dentro de la cola de la instancia, sobre los datos recien leidos (nada que otro escribio se pierde).
    await instances.update(instanceId, (fresh) => {
      const projects = { ...(fresh.modrinth?.projects || {}) };
      for (const l of goneFiles) {
        for (const [pid, rec] of Object.entries(projects)) if (recordMatches(rec, l.folder, l.base)) delete projects[pid];
      }
      for (const p of placed) {
        if (p.entry.source !== 'modrinth') continue;
        const pid = p.info?.projectId || p.entry.projectId;
        if (!pid) continue;
        projects[pid] = {
          title: p.info?.title || p.entry.title,
          icon: p.info?.icon || p.entry.icon || null,
          type: files.TYPE_BY_FOLDER[p.folder] || 'mod',
          versionId: p.info?.versionId || p.entry.versionId || null,
          versionNumber: p.info?.versionNumber || p.entry.versionNumber || null,
          file: p.base,
          folder: p.folder,
          installedAt: Date.now(),
        };
      }
      return { modrinth: { ...(fresh.modrinth || {}), projects } };
    });
    await writeJson(statePath(inst.dir), appliedState(m, opts.revision));

    task?.update({ detail: t('share.stepDone'), progress: span(1) });
    return {
      added: diff.added.length,
      updated: diff.updated.length,
      removed: removals.length,
      toggled: diff.toggled.length,
      configs: configsWritten,
      options: optionsWritten,
      version: diff.version.changed ? diff.version : null,
      manualMissing: diff.manualMissing.map((e) => ({ path: e.path, title: e.title })),
      warnings,
    };
  } finally {
    await rmrf(tmpDir).catch(() => {});
  }
}

function applyManifest(instanceId, manifest, opts = {}, task, progress) {
  try {
    // Mientras se busca el mod culpable de un crash, la carpeta mods es de esa búsqueda
    require('../crash').assertNotBisecting(instanceId);
  } catch (err) {
    return Promise.reject(err);
  }
  return withLock(instanceId, () => applyInternal(instanceId, manifest, opts, task, progress));
}

module.exports = { applyManifest, applyInternal, withLock, isBusy, readState, forgetState, gameRunning };
