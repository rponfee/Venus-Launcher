'use strict';
// Actualizar un modpack de Modrinth en una instancia:
//  1. instantanea (con o sin mundos) para poder volver atras
//  2. descarga de lo nuevo a una carpeta temporal (si algo falla, la instancia no se toca)
//  3. se cambian SOLO los archivos del pack: los mods agregados a mano se conservan
//     (si alguno es el mismo mod que trae el pack, se desactiva para no tenerlo dos veces)
//  4. overrides en tres vias: si el pack no cambio un archivo de configuracion, se respeta el del usuario
//     (sus mundos y lo que cambio fuera de la instantanea, como servers.dat, no se pisan nunca)
//  5. version de Minecraft/loader, estado del pack y preparacion de la instancia
const fsp = require('fs/promises');
const path = require('path');
const instances = require('../../core/instances');
const modrinth = require('../../core/modrinth');
const game = require('../../core/game');
const tasks = require('../../core/tasks');
const { t } = require('../../core/i18n');
const lookup = require('./lookup');
const safety = require('./safety');
const { userError, clientFiles, writeState, packInfo, resolveInside } = require('./state');
const { readPack, fetchVersion, openPack, overrideEntries, downloadItems, runDownloads, scaledTask } = require('./mrpack');
const { installedState, matchFiles, userFiles, worldOf, playerWorlds, keepsLocal } = require('./diff');

const busy = new Set();

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function rmForce(p) {
  await fsp.rm(p, { force: true, maxRetries: 3, retryDelay: 150 });
}

// Mientras se busca el mod culpable (modulo crash) los mods estan a medio desactivar: no se actualiza.
function notBisecting(id) {
  let crash = null;
  try {
    crash = require('../crash');
  } catch {
    crash = null;
  }
  crash?.assertNotBisecting?.(id);
}

// Pone el archivo descargado en su lugar renombrando encima (nunca se escribe sobre el viejo: si es un
// enlace duro del almacen, las otras instancias conservan su copia).
async function moveInto(src, dest) {
  await safety.moveFile(src, dest);
}

const sameHash = (a, b) => (a?.sha1 && b?.sha1 ? a.sha1 === b.sha1 : Boolean(a?.sha512 && a.sha512 === b?.sha512));

async function localFilesAsOld(instDir) {
  const out = new Map();
  for (const folder of ['mods', 'resourcepacks', 'shaderpacks']) {
    const entries = await fsp.readdir(path.join(instDir, folder), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile() || /\.disabled$/i.test(e.name)) continue;
      const rel = `${folder}/${e.name}`;
      const sha1 = await lookup.localSha1(path.join(instDir, folder, e.name));
      if (sha1) out.set(rel, { path: rel, sha1, sha512: null, size: 0 });
    }
  }
  return out;
}

async function applyUpdate(inst, versionId, opts, task, hooks) {
  const signal = task?.signal;
  const pack = packInfo(inst);
  const target = await modrinth.getVersion(versionId);
  if (target.project_id !== pack.projectId) throw userError('packs.errWrongVersion');

  // 1) Instantanea
  let snapshot = null;
  if (opts.snapshot !== false) {
    task?.update({ detail: t('packs.stepSnapshot'), progress: 0 });
    try {
      snapshot = await require('../snapshots').create(inst.id, {
        kind: 'auto',
        reasonCode: 'packUpdate',
        reason: t('packs.snapshotReason', { from: pack.version || '?', to: target.version_number }),
        worlds: opts.worlds === 'all' ? 'all' : 'none',
        task: scaledTask(task, 0, 0.2),
      });
    } catch (err) {
      throw userError('packs.errSnapshot', { error: err?.message || String(err) });
    }
  }

  // 2) Que hay instalado y que trae la version nueva
  task?.update({ detail: t('packs.stepCompare'), progress: 0.2 });
  const fresh = await instances.get(inst.id);
  const old = await installedState(fresh, { signal });
  const { file } = await fetchVersion(target.id, signal);
  const next = await readPack(file);
  const oldMap = old.index ? clientFiles(old.index) : new Map();
  const newMap = clientFiles(next.index);
  const unknown = !old.index;
  const localOld = unknown ? await localFilesAsOld(inst.dir) : null;
  const before = unknown ? localOld : oldMap;

  let vmap = {};
  let projects = new Map();
  try {
    vmap = await lookup.versionsByHash([...before.values(), ...newMap.values()].map((f) => f.sha1).filter(Boolean), { signal });
    projects = await lookup.projectsByIds(Object.values(vmap).filter(Boolean).map((v) => v.project_id));
  } catch {
    /* sin Modrinth: se empareja por ruta y por nombre */
  }
  const m = matchFiles(before, newMap, vmap, projects, { keepUnpaired: unknown });

  // Plan de archivos del indice
  const toDownload = [];
  for (const [p, f] of newMap) {
    const oldRel = m.pairs.get(p) || null;
    const of = oldRel ? before.get(oldRel) : null;
    const dest = resolveInside(inst.dir, p);
    if (!dest) continue;
    const curOn = await exists(dest);
    const curOff = !curOn && (await exists(`${dest}.disabled`));
    let wasDisabled = curOff;
    if (oldRel && oldRel !== p) {
      const oldAbs = resolveInside(inst.dir, oldRel);
      wasDisabled = Boolean(oldAbs && !(await exists(oldAbs)) && (await exists(`${oldAbs}.disabled`)));
    }
    if (oldRel === p && of && sameHash(of, f) && (curOn || curOff)) {
      const st = await fsp.stat(curOn ? dest : `${dest}.disabled`).catch(() => null);
      if (st && (!f.size || st.size === f.size)) continue; // no cambio y esta bien en disco
    }
    toDownload.push({ f, disabled: wasDisabled });
  }
  const removals = new Set();
  if (!unknown) for (const p of oldMap.keys()) if (!newMap.has(p)) removals.add(p);
  for (const [np, op] of m.pairs) if (op !== np) removals.add(op);

  // 3) Descargas a una carpeta temporal dentro de la instancia (mismo disco: mover es instantaneo)
  const staging = path.join(inst.dir, '.venus', 'pack-staging');
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });
  try {
    const { items, blocked } = downloadItems(inst.dir, toDownload.map((x) => x.f), staging);
    const blockedSet = new Set(blocked.map((b) => b.path));
    await runDownloads(items, task, signal, 0.25, 0.8);
    if (signal?.aborted) throw signal.reason || new Error('aborted');

    // 4) Aplicar (desde aca no se corta a mitad de camino)
    task?.update({ detail: t('packs.stepApply'), progress: 0.82 });
    const disabledDupes = [];
    const newOverrides = {};
    const keptWorlds = new Set();
    const keptFiles = [];
    try {
      for (const rel of removals) {
        const abs = resolveInside(inst.dir, rel);
        if (!abs) continue;
        await rmForce(abs);
        await rmForce(`${abs}.disabled`);
      }
      const disabledByPath = new Map(toDownload.map((x) => [x.f.path, x.disabled]));
      for (const it of items) {
        const base = resolveInside(inst.dir, it.file.path);
        const off = disabledByPath.get(it.file.path);
        await rmForce(off ? base : `${base}.disabled`);
        await moveInto(it.path, off ? `${base}.disabled` : base);
      }

      // Overrides en tres vias. Lo del jugador que la instantanea no guarda (sus mundos, servers.dat...) no se
      // pisa: se conserva y se informa (diff.js, keepsLocal).
      const zip = await openPack(file);
      try {
        const oldO = old.overrides;
        const entries = overrideEntries(zip);
        const worlds = await playerWorlds(inst.dir, oldO, [...entries.keys(), ...Object.keys(oldO || {})]);
        for (const [rel, e] of entries) {
          const sha = next.overrides[rel];
          newOverrides[rel] = sha;
          const dest = resolveInside(inst.dir, rel);
          if (!dest) continue;
          const unchanged = Boolean(oldO && oldO[rel] === sha);
          if (unchanged && (await exists(dest))) continue; // el pack no lo cambio: queda lo del usuario
          if (await keepsLocal(rel, dest, oldO, worlds)) {
            // Se informa solo lo que el pack cambio (lo que falta en un mundo del jugador no se vuelve a poner)
            if (!unchanged) {
              const w = worldOf(rel);
              if (w) keptWorlds.add(w);
              else keptFiles.push(rel);
            }
            continue;
          }
          await zip.extract(e, dest);
        }
        if (oldO) {
          for (const rel of Object.keys(oldO)) {
            if (rel in newOverrides) continue;
            const dest = resolveInside(inst.dir, rel);
            if (!dest || !(await exists(dest))) continue;
            const w = worldOf(rel);
            if (w && worlds.has(w)) {
              keptWorlds.add(w); // mundo del jugador: no se borra nada
              continue;
            }
            if ((await lookup.localSha1(dest)) === oldO[rel]) await rmForce(dest); // nadie lo toco: el pack lo saco
          }
        }
      } finally {
        await zip.close().catch(() => {});
      }

      // Mods agregados a mano que el pack ahora trae: se desactivan (no se borran)
      if (!unknown) {
        const newProjects = new Set([...m.newDesc.values()].map((d) => d.projectId).filter(Boolean));
        const managed = new Set([...oldMap.keys(), ...newMap.keys(), ...Object.keys(old.overrides || {}), ...Object.keys(old.files || {}), ...Object.keys(newOverrides)]);
        for (const u of await userFiles(inst.dir, managed)) {
          if (u.disabled || !u.rel.startsWith('mods/')) continue;
          const h = await lookup.localSha1(u.abs);
          const v = h ? (await lookup.versionsByHash([h]).catch(() => ({})))[h] : null;
          if (v && newProjects.has(v.project_id) && !(await exists(`${u.abs}.disabled`))) {
            await fsp.rename(u.abs, `${u.abs}.disabled`).catch(() => {});
            disabledDupes.push(u.rel);
          }
        }
      }

      // 5) Estado del pack e instancia
      const files = {};
      for (const [p, f] of newMap) if (!blockedSet.has(p)) files[p] = { sha1: f.sha1, src: 'index' };
      for (const [rel, sha] of Object.entries(newOverrides)) files[rel] = { sha1: sha, src: 'override' };
      await writeState(inst.dir, {
        meta: { projectId: pack.projectId, versionId: target.id, versionNumber: target.version_number, installedAt: Date.now() },
        index: next.index,
        overrides: newOverrides,
        files,
      });
      const nd = next.index.dependencies || {};
      const { loader, loaderVersion } = modrinth.packLoader(nd);
      // Dentro de la cola de la instancia: se parte de los datos actuales (nada que otro escribio se pierde).
      await instances.update(inst.id, (cur) => {
        const patch = {
          modrinth: {
            ...(cur.modrinth || {}),
            projects: cur.modrinth?.projects || {},
            pack: { projectId: pack.projectId, versionId: target.id, name: next.index.name || pack.name || null, version: next.index.versionId || target.version_number },
          },
        };
        const gameChanged = nd.minecraft !== cur.mcVersion || loader !== cur.loader || (loaderVersion || null) !== (cur.loaderVersion || null);
        if (gameChanged) Object.assign(patch, { mcVersion: nd.minecraft, loader, loaderVersion: loaderVersion || 'latest', versionId: null, installed: false });
        return patch;
      });
      hooks.onChanged?.();
    } catch (err) {
      throw userError(snapshot ? 'packs.errApplySnapshot' : 'packs.errApply', { error: err?.message || String(err) });
    }

    // 6) Preparar (loader y Minecraft nuevos). Si falla, se reintenta al jugar.
    let prepareError = null;
    if (opts.prepare !== false) {
      try {
        await instances.prepare(inst.id, task);
      } catch (err) {
        if (signal?.aborted) throw err;
        prepareError = err?.message || String(err);
      }
    }
    return {
      instanceId: inst.id,
      versionId: target.id,
      versionNumber: target.version_number,
      snapshotId: snapshot?.id || null,
      added: m.added.length,
      removed: m.removed.length,
      updated: m.updated.length,
      downloaded: items.length,
      disabledDuplicates: disabledDupes,
      blocked: [...blockedSet],
      keptWorlds: [...keptWorlds].sort(),
      keptFiles,
      prepareError,
    };
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Actualiza el modpack de la instancia a la version indicada (como tarea).
 * opts: { snapshot: true|false, worlds: 'none'|'all', prepare: true|false }
 */
async function update(instanceId, versionId, opts = {}, hooks = {}) {
  const inst = await instances.get(instanceId);
  const pack = packInfo(inst);
  if (!pack?.projectId) throw userError('packs.errNotModrinthPack');
  if (typeof versionId !== 'string' || !versionId) throw userError('packs.errWrongVersion');
  if (game.status()[inst.id]) throw userError('packs.errRunning');
  notBisecting(inst.id);
  if (busy.has(inst.id)) throw userError('packs.errBusy');
  busy.add(inst.id);
  try {
    return await tasks.run(t('packs.taskUpdate', { name: inst.name }), (task) => applyUpdate(inst, versionId, opts || {}, task, hooks), { instanceId: inst.id, kind: 'packs:update' });
  } finally {
    busy.delete(inst.id);
  }
}

module.exports = { update, applyUpdate, busy };
