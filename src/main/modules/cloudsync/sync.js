'use strict';
// Sincronizacion de mundos y configuraciones con Supabase Storage:
//   estado      al dia | local mas nuevo | nube mas nueva | conflicto | solo en esta PC | solo en la nube
//   subir       comprime el mundo en partes de 45 MB, las sube a una carpeta nueva (<user>/<clave>/<mundo>/<subida>/)
//               y recien despues actualiza la fila de cloud_saves con concurrencia optimista (version = version + 1).
//               Si otra PC subio en el medio, no se pisa nada: se avisa el conflicto.
//   bajar       descarga las partes verificando el sha1, extrae al lado y reemplaza el mundo local
//               (el anterior va a la papelera; nunca se borra sin copia).
const os = require('os');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const instances = require('../../core/instances');
const tasks = require('../../core/tasks');
const { t } = require('../../core/i18n');
const { rmrf, uid, exists, sanitizeFileName } = require('../../core/util');
const local = require('./local');
const { Session, CloudError } = require('./supa');
const { extractZip } = require('./zipstream');
const safety = require('../packs/safety');

const CONFIG = '@config';
const SELECT = 'id,kind,instance_key,name,label,storage_prefix,version,sha1,size,parts,device,device_id,meta,updated_at';

const busy = new Set();
const chains = new Map();

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

const isBusy = (id) => busy.has(id);

// ---------- Restos de una operacion cortada ----------
// Si el launcher se cerro a mitad de una bajada, el mundo pudo quedar apartado en .venus/cloudsync-old-*
// (y saves/<mundo> vacio) y quedan las carpetas temporales. Se arregla una vez por instancia, dentro de su
// cola (nunca a la vez que una subida o bajada de esa instancia).
const DAY = 24 * 60 * 60 * 1000;
const recovered = new Set();
let tempSwept = false;

// Temporales de %TEMP% de subidas o bajadas de otras sesiones (con mas de un dia).
async function sweepTemp() {
  if (tempSwept) return;
  tempSwept = true;
  const root = os.tmpdir();
  for (const name of await fsp.readdir(root).catch(() => [])) {
    if (!name.startsWith('venus-cloudsync-')) continue;
    const dir = path.join(root, name);
    const st = await fsp.stat(dir).catch(() => null);
    if (st?.isDirectory() && Date.now() - st.mtimeMs > DAY) await rmrf(dir).catch(() => {});
  }
}

async function recoverLeftovers(inst) {
  if (recovered.has(inst.id)) return;
  await sweepTemp();
  const venus = path.join(inst.dir, local.VENUS_DIR);
  const savesDir = path.join(inst.dir, 'saves');
  const moved = [];
  let ok = true;
  for (const e of await fsp.readdir(venus, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    const holder = path.join(venus, e.name);
    if (e.name.startsWith('cloudsync-incoming-')) {
      await rmrf(holder).catch(() => (ok = false));
      continue;
    }
    if (!e.name.startsWith('cloudsync-old-')) continue;
    const when = (await fsp.stat(holder).catch(() => null))?.mtime || new Date();
    for (const w of await fsp.readdir(holder, { withFileTypes: true }).catch(() => [])) {
      if (!w.isDirectory() || !local.validSegment(w.name)) continue;
      const src = path.join(holder, w.name);
      const target = path.join(savesDir, w.name);
      try {
        if (!(await exists(target))) {
          // Se corto entre los dos renombres: el mundo vuelve a su lugar
          await fsp.mkdir(savesDir, { recursive: true });
          await fsp.rename(src, target);
          local.forgetStamp(target);
          console.warn(`[cloudsync] ${inst.id}: se devolvió a saves/ el mundo «${w.name}» de una bajada interrumpida`);
        } else {
          // El mundo de la nube ya estaba en su lugar: la copia vieja sigue el camino de una bajada normal
          const date = when.toISOString().slice(0, 16).replace(/[:T]/g, '-');
          const to = await moveAside(src, t('cloudsync.localCopyName', { name: w.name, date }), savesDir);
          if (to) moved.push(to);
        }
      } catch (err) {
        ok = false;
        console.warn('[cloudsync] restos de una bajada:', err?.message || err);
      }
    }
    await fsp.rmdir(holder).catch(() => {}); // solo si quedo vacia
  }
  if (moved.length) {
    // la copia que quedo aparte no se sube sola (como en una bajada normal)
    const state = await local.readState(inst);
    state.ignored = [...new Set([...(Array.isArray(state.ignored) ? state.ignored : []), ...moved])].slice(-50);
    await local.writeState(inst, state).catch(() => {});
  }
  if (ok) recovered.add(inst.id);
}

// Desde las vistas (estado, ajustes): solo si no hay nada en la cola de esa instancia, para no esperarla.
async function recoverIdle(inst) {
  if (recovered.has(inst.id) || chains.has(inst.id)) return;
  await withLock(inst.id, () => recoverLeftovers(inst)).catch((err) => console.warn('[cloudsync] restos:', err?.message || err));
}

function gameRunning(id) {
  try {
    return Boolean(require('../../core/game').status()[id]);
  } catch {
    return false;
  }
}

const enc = (v) => encodeURIComponent(String(v));
const pad = (i) => String(i).padStart(3, '0');
const mb = (n) => (n / 1048576).toFixed(1);

function slimRemote(r) {
  if (!r) return null;
  const m = r.meta && typeof r.meta === 'object' ? r.meta : {};
  return {
    id: r.id,
    version: r.version,
    size: Number(r.size) || 0,
    rawSize: Number(m.rawSize) || null,
    parts: r.parts,
    device: r.device || null,
    deviceId: r.device_id || null,
    updatedAt: r.updated_at ? Date.parse(r.updated_at) : null,
    label: r.label || null,
    lastPlayed: Number(m.lastPlayed) || null,
    mcVersion: typeof m.mcVersion === 'string' ? m.mcVersion : null,
  };
}

// Copias que son la misma partida aunque esta PC nunca haya sincronizado (misma fecha de juego y tamaño).
function sameWorld(loc, remote) {
  const m = remote?.meta || {};
  return Boolean(loc && m.lastPlayed && loc.lastPlayed && Math.abs(Number(m.lastPlayed) - Number(loc.lastPlayed)) < 2000 && Number(m.rawSize) === loc.size);
}

function classify(loc, remote, base, same) {
  if (loc && !remote) return 'localOnly';
  if (!loc && remote) return 'remoteOnly';
  if (!loc && !remote) return null;
  if (!base) return same ? 'synced' : 'conflict';
  const localChanged = base.stamp !== loc.stamp;
  const remoteChanged = base.version !== remote.version || base.sha1 !== remote.sha1;
  if (localChanged && remoteChanged) return same ? 'synced' : 'conflict';
  if (localChanged) return 'localNewer';
  if (remoteChanged) return 'remoteNewer';
  return 'synced';
}

function validWorld(world) {
  if (!local.validSegment(world)) throw new CloudError('bad_world', t('cloudsync.errBadWorld'));
  return world;
}

async function rowsFor(session, filter = '') {
  const rows = await session.rest('GET', `cloud_saves?select=${SELECT}${filter}&order=updated_at.desc&limit=2000`);
  return Array.isArray(rows) ? rows : [];
}

async function findRow(session, kind, key, name) {
  const rows = await rowsFor(session, `&kind=eq.${kind}&instance_key=eq.${enc(key)}&name=eq.${enc(name)}`);
  return rows[0] || null;
}

function partPaths(session, row) {
  const prefix = String(row?.storage_prefix || '');
  if (!prefix.startsWith(`${session.userId}/`) || prefix.includes('..')) return [];
  return Array.from({ length: Math.max(0, Math.min(400, Number(row.parts) || 0)) }, (_, i) => `${prefix}/part-${pad(i)}`);
}

// ---------- Estado ----------

async function localWorlds(inst) {
  const list = await instances.content(inst.id, 'saves').catch(() => []);
  const out = [];
  for (const w of list) {
    const st = await local.worldStamp(path.join(inst.dir, 'saves', w.folder));
    if (st) out.push({ ...w, stamp: st.stamp, size: st.size, files: st.files });
  }
  return out;
}

async function status(instanceId, auth, notify) {
  const inst = await instances.get(instanceId);
  await recoverIdle(inst);
  const state = await local.readState(inst);
  const dev = await local.device();
  const session = await Session.open(auth, notify);
  const rows = await rowsFor(session);
  const mine = rows.filter((r) => r.instance_key === state.key);
  const worlds = [];
  const seen = new Set();
  let dirty = false;
  for (const w of await localWorlds(inst)) {
    const remote = mine.find((r) => r.kind === 'world' && r.name === w.folder) || null;
    const base = state.worlds[w.folder] || null;
    const same = sameWorld(w, remote);
    const st = classify(w, remote, base, same);
    if (st === 'synced' && remote && (!base || base.stamp !== w.stamp || base.version !== remote.version)) {
      state.worlds[w.folder] = { version: remote.version, sha1: remote.sha1, stamp: w.stamp, syncedAt: base?.syncedAt || Date.now() };
      dirty = true;
    }
    seen.add(w.folder);
    worlds.push({
      folder: w.folder,
      displayName: w.displayName,
      icon: w.icon,
      iconTime: w.iconTime,
      lastPlayed: w.lastPlayed,
      mcVersion: w.version,
      gameMode: w.gameMode,
      hardcore: w.hardcore,
      local: { size: w.size, files: w.files },
      remote: slimRemote(remote),
      state: st,
      syncedAt: state.worlds[w.folder]?.syncedAt || null,
    });
  }
  for (const r of mine.filter((x) => x.kind === 'world' && !seen.has(x.name))) {
    worlds.push({
      folder: r.name,
      displayName: r.label || r.meta?.displayName || r.name,
      icon: null,
      lastPlayed: Number(r.meta?.lastPlayed) || null,
      mcVersion: r.meta?.mcVersion || null,
      local: null,
      remote: slimRemote(r),
      state: 'remoteOnly',
      syncedAt: null,
    });
  }
  const order = { conflict: 0, remoteNewer: 1, localNewer: 2, remoteOnly: 3, localOnly: 4, synced: 5 };
  worlds.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || (b.lastPlayed || 0) - (a.lastPlayed || 0));

  const cs = await local.configStamp(inst.dir);
  const cr = mine.find((r) => r.kind === 'config') || null;
  const cfgSame = Boolean(cs && cr && cr.meta?.stamp === cs.stamp);
  const cfgState = classify(cs, cr, state.config, cfgSame);
  if (cfgState === 'synced' && cr && cs && (!state.config || state.config.stamp !== cs.stamp || state.config.version !== cr.version)) {
    state.config = { version: cr.version, sha1: cr.sha1, stamp: cs.stamp, syncedAt: state.config?.syncedAt || Date.now() };
    dirty = true;
  }
  if (dirty) await local.writeState(inst, state);

  const others = new Map();
  for (const r of rows) {
    if (r.instance_key === state.key) continue;
    const g = others.get(r.instance_key) || { key: r.instance_key, label: null, worlds: 0, config: false, bytes: 0, updatedAt: 0 };
    if (r.kind === 'world') g.worlds++;
    else g.config = true;
    g.bytes += Number(r.size) || 0;
    g.updatedAt = Math.max(g.updatedAt, Date.parse(r.updated_at) || 0);
    g.label = g.label || (typeof r.meta?.instanceName === 'string' ? r.meta.instanceName : null);
    others.set(r.instance_key, g);
  }
  return {
    key: state.key,
    defaultKey: local.defaultKey(inst.id),
    auto: state.auto,
    autoSince: state.autoSince,
    configs: state.configs,
    device: dev,
    usage: { bytes: rows.reduce((a, r) => a + (Number(r.size) || 0), 0), count: rows.length },
    worlds,
    config: { local: cs ? { size: cs.size, files: cs.files } : null, remote: slimRemote(cr), state: cfgState, syncedAt: state.config?.syncedAt || null },
    otherKeys: [...others.values()].sort((a, b) => b.updatedAt - a.updatedAt),
    busy: isBusy(instanceId),
  };
}

// ---------- Subir ----------

async function upload(instanceId, world, auth, opts = {}, notify) {
  return withLock(instanceId, async () => {
    if (gameRunning(instanceId)) throw new CloudError('running', t('cloudsync.errGameRunning'));
    const inst = await instances.get(instanceId);
    await recoverLeftovers(inst);
    const state = await local.readState(inst);
    const session = await Session.open(auth, notify);
    const isConfig = world === CONFIG;
    let list;
    let name;
    let label;
    let meta;
    let stamp;
    let segment;
    if (isConfig) {
      const cs = await local.configStamp(inst.dir);
      if (!cs) throw new CloudError('empty', t('cloudsync.errNoConfigs'));
      list = cs.list;
      name = 'config';
      label = inst.name;
      segment = '_config';
      stamp = cs.stamp;
      meta = { stamp: cs.stamp, rawSize: cs.size, files: cs.files, instanceName: inst.name, mcVersion: inst.mcVersion };
    } else {
      validWorld(world);
      const dir = path.join(inst.dir, 'saves', world);
      const st = await local.worldStamp(dir, { force: true });
      if (!st) throw new CloudError('not_world', t('cloudsync.errNoWorld', { name: world }));
      if (st.size > local.MAX_WORLD || st.files > local.MAX_FILES) throw new CloudError('too_big', t('cloudsync.errWorldTooBig'));
      list = await local.listWorldFiles(dir);
      const info = (await instances.content(instanceId, 'saves').catch(() => [])).find((w) => w.folder === world);
      name = world;
      label = (info?.displayName || world).slice(0, 120);
      segment = local.worldKey(world);
      stamp = st.stamp;
      meta = {
        displayName: label,
        lastPlayed: Number(info?.lastPlayed) || null,
        mcVersion: info?.version || inst.mcVersion,
        gameMode: info?.gameMode || null,
        hardcore: Boolean(info?.hardcore),
        rawSize: st.size,
        files: st.files,
        instanceName: inst.name,
      };
    }
    const kind = isConfig ? 'config' : 'world';
    const remote = await findRow(session, kind, state.key, name);
    const base = isConfig ? state.config : state.worlds[name];
    if (!opts.force && remote) {
      const remoteChanged = !base || base.version !== remote.version || base.sha1 !== remote.sha1;
      const same = isConfig ? remote.meta?.stamp === stamp : sameWorld({ lastPlayed: meta.lastPlayed, size: meta.rawSize }, remote);
      if (remoteChanged && !same) return { conflict: true, remote: slimRemote(remote) };
    }
    const title = isConfig ? t('cloudsync.taskUploadConfig', { name: inst.name }) : t('cloudsync.taskUpload', { name: label });
    return tasks.run(
      title,
      async (task) => {
        const tmp = await local.tempDir('up');
        try {
          const total = list.reduce((a, f) => a + f.size, 0) || 1;
          let done = 0;
          task.update({ detail: t('cloudsync.stepZip'), progress: 0 });
          const z = await local.zipToParts(list, tmp, {
            signal: task.signal,
            onBytes: (n) => {
              done += n;
              task.update({ detail: t('cloudsync.stepZipBytes', { done: mb(done), total: mb(total) }), progress: 0.4 * Math.min(1, done / total) });
            },
          });
          const prefix = `${session.userId}/${state.key}/${segment}/${uid(10)}`;
          const uploaded = [];
          // true cuando la fila ya apunta a estas partes (o no se puede saber): desde ahi no se borran.
          let committed = false;
          let saved;
          try {
            let sent = 0;
            for (let i = 0; i < z.parts.length; i++) {
              const buf = await fsp.readFile(z.parts[i]);
              task.update({ detail: t('cloudsync.stepUpload', { part: i + 1, parts: z.parts.length, done: mb(sent), total: mb(z.size) }), progress: 0.4 + 0.55 * (sent / z.size) });
              const obj = `${prefix}/part-${pad(i)}`;
              await session.upload(obj, buf, { signal: task.signal });
              uploaded.push(obj);
              sent += buf.length;
            }
            task.update({ detail: t('cloudsync.stepCommit'), progress: 0.97 });
            const dev = await local.device();
            const row = { label, storage_prefix: prefix, sha1: z.sha1, size: z.size, parts: z.parts.length, device: dev.name, device_id: dev.id, meta, updated_at: new Date().toISOString() };
            try {
              if (remote) {
                const res = await session.rest('PATCH', `cloud_saves?id=eq.${enc(remote.id)}&version=eq.${remote.version}`, { body: { ...row, version: remote.version + 1 }, prefer: 'return=representation' });
                if (!Array.isArray(res) || !res.length) throw new CloudError('conflict', t('cloudsync.errRace'));
                saved = res[0];
              } else {
                const res = await session.rest('POST', 'cloud_saves', { body: { ...row, kind, instance_key: state.key, name, version: 1 }, prefer: 'return=representation' });
                saved = Array.isArray(res) ? res[0] : res;
              }
            } catch (err) {
              // Un error en la confirmacion no dice si la fila se guardo (la respuesta se pudo cortar despues):
              // se vuelve a leer. Si ya apunta a esta subida, salio bien; si no se puede leer, no se borra nada.
              let now;
              try {
                now = await findRow(session, kind, state.key, name);
              } catch {
                committed = true;
                throw err;
              }
              if (now?.storage_prefix !== prefix) throw err;
              saved = now;
            }
            committed = true;
          } catch (err) {
            if (uploaded.length && !committed) await session.remove(uploaded).catch(() => {});
            throw err;
          }
          // La subida anterior ya no hace falta
          if (remote) await session.remove(partPaths(session, remote)).catch((err) => console.warn('[cloudsync] limpieza:', err?.message || err));
          const fresh = await local.readState(inst);
          const entry = { version: saved.version, sha1: saved.sha1, stamp, syncedAt: Date.now() };
          if (fresh.key === state.key) {
            if (isConfig) fresh.config = entry;
            else fresh.worlds[name] = entry;
            await local.writeState(inst, fresh);
          }
          return { ok: true, version: saved.version, size: z.size, parts: z.parts.length };
        } finally {
          await rmrf(tmp).catch(() => {});
        }
      },
      { instanceId, kind: 'cloudsync:upload' },
    );
  });
}

// ---------- Bajar ----------

// Manda la copia anterior a la papelera; si no hay papelera, la deja en saves/ con un nombre visible.
async function moveAside(src, copyName, savesDir) {
  let shell = null;
  try {
    shell = require('electron').shell;
  } catch {
    shell = null;
  }
  if (shell?.trashItem) {
    try {
      await shell.trashItem(src);
      return null;
    } catch {
      /* sin papelera: se renombra */
    }
  }
  const baseName = sanitizeFileName(copyName);
  let dest = path.join(savesDir, baseName);
  let n = 2;
  while (await exists(dest)) dest = path.join(savesDir, `${baseName} (${n++})`);
  await fsp.rename(src, dest);
  return path.basename(dest);
}

async function download(instanceId, world, auth, opts = {}, notify) {
  return withLock(instanceId, async () => {
    if (gameRunning(instanceId)) throw new CloudError('running', t('cloudsync.errGameRunning'));
    const inst = await instances.get(instanceId);
    await recoverLeftovers(inst);
    const state = await local.readState(inst);
    const session = await Session.open(auth, notify);
    const isConfig = world === CONFIG;
    const name = isConfig ? 'config' : validWorld(world);
    const kind = isConfig ? 'config' : 'world';
    const remote = await findRow(session, kind, state.key, name);
    if (!remote) throw new CloudError('not_found', t('cloudsync.errNotInCloud'));
    const parts = partPaths(session, remote);
    if (!parts.length) throw new CloudError('corrupt', t('cloudsync.errCorrupt'));
    const base = isConfig ? state.config : state.worlds[name];
    const target = isConfig ? null : path.join(inst.dir, 'saves', name);
    if (!opts.force) {
      if (isConfig) {
        const cs = await local.configStamp(inst.dir);
        if (cs && (!base || base.stamp !== cs.stamp) && remote.meta?.stamp !== cs.stamp) return { conflict: true, remote: slimRemote(remote) };
      } else {
        const st = await local.worldStamp(target);
        if (st) {
          const info = (await instances.content(instanceId, 'saves').catch(() => [])).find((w) => w.folder === name);
          const same = sameWorld({ lastPlayed: info?.lastPlayed, size: st.size }, remote);
          if ((!base || base.stamp !== st.stamp) && !same) return { conflict: true, remote: slimRemote(remote) };
        }
      }
    }
    const title = isConfig ? t('cloudsync.taskDownloadConfig', { name: inst.name }) : t('cloudsync.taskDownload', { name: remote.label || name });
    return tasks.run(
      title,
      async (task) => {
        const tmp = await local.tempDir('down');
        const incoming = path.join(inst.dir, local.VENUS_DIR, `cloudsync-incoming-${uid(6)}`);
        try {
          const zipPath = path.join(tmp, 'archive.zip');
          const fh = await fsp.open(zipPath, 'w');
          const hash = crypto.createHash('sha1');
          let got = 0;
          try {
            for (let i = 0; i < parts.length; i++) {
              task.update({ detail: t('cloudsync.stepDownload', { part: i + 1, parts: parts.length, done: mb(got), total: mb(remote.size) }), progress: 0.55 * (got / (remote.size || 1)) });
              await session.download(
                parts[i],
                async (buf) => {
                  hash.update(buf);
                  got += buf.length;
                  let off = 0;
                  while (off < buf.length) off += (await fh.write(buf, off, buf.length - off)).bytesWritten;
                  if (got > Number(remote.size) + 1024) throw new CloudError('corrupt', t('cloudsync.errCorrupt'));
                  task.update({ progress: 0.55 * Math.min(1, got / (remote.size || 1)) });
                },
                { signal: task.signal },
              );
            }
          } finally {
            await fh.close();
          }
          if (got !== Number(remote.size) || hash.digest('hex') !== remote.sha1) throw new CloudError('corrupt', t('cloudsync.errCorrupt'));
          const rawTotal = Number(remote.meta?.rawSize) || remote.size;
          let written = 0;
          const onBytes = (n) => {
            written += n;
            task.update({ detail: t('cloudsync.stepExtract'), progress: 0.55 + 0.4 * Math.min(1, written / (rawTotal || 1)) });
          };
          let entry;
          if (isConfig) {
            await local.backupConfigs(inst.dir).catch((err) => console.warn('[cloudsync] copia de configs:', err?.message || err));
            const allowed = (segs) => segs[0] === 'config' || (segs.length === 1 && local.CONFIG_ROOT_FILES.includes(segs[0]));
            await extractZip(zipPath, incoming, { signal: task.signal, onBytes, filter: allowed, maxTotal: 64 * 1024 * 1024 });
            const files = [];
            await collect(incoming, '', files);
            for (const rel of files) {
              // Reglas compartidas (nunca venus-instance.json ni .venus/) y reemplazo por temporal +
              // renombrado: no se le escribe encima a ningun archivo existente.
              const dest = safety.resolveInside(inst.dir, rel);
              if (!dest) continue;
              await safety.copyFileAtomic(path.join(incoming, ...rel.split('/')), dest);
            }
            const cs = await local.configStamp(inst.dir);
            entry = { version: remote.version, sha1: remote.sha1, stamp: cs?.stamp || null, syncedAt: Date.now() };
          } else {
            await extractZip(zipPath, incoming, { signal: task.signal, onBytes });
            if (!(await exists(path.join(incoming, 'level.dat')))) throw new CloudError('corrupt', t('cloudsync.errCorrupt'));
            if (gameRunning(instanceId)) throw new CloudError('running', t('cloudsync.errGameRunning'));
            await fsp.mkdir(path.dirname(target), { recursive: true });
            // Intercambio seguro: el mundo actual se aparta primero y vuelve a su lugar si algo falla;
            // recién con el nuevo en su lugar se manda el viejo a la papelera.
            let movedTo = null;
            // (la carpeta conserva el nombre del mundo para reconocerla en la papelera)
            const holder = (await exists(target)) ? path.join(inst.dir, local.VENUS_DIR, `cloudsync-old-${uid(6)}`) : null;
            const old = holder ? path.join(holder, name) : null;
            if (old) {
              await fsp.mkdir(holder, { recursive: true });
              await fsp.rename(target, old);
            }
            try {
              await fsp.rename(incoming, target);
            } catch (err) {
              if (old) await fsp.rename(old, target).catch(() => {});
              // Si el mundo no pudo volver, la carpeta no se borra (adentro esta el mundo): se devuelve en la
              // proxima operacion de esta instancia.
              if (old && (await exists(old))) recovered.delete(inst.id);
              else if (holder) await rmrf(holder).catch(() => {});
              throw err;
            }
            if (old) {
              const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
              movedTo = await moveAside(old, t('cloudsync.localCopyName', { name, date: stamp }), path.dirname(target)).catch((err) => {
                console.warn('[cloudsync] copia local:', err?.message || err);
                return null;
              });
              if (!(await exists(old))) await rmrf(holder).catch(() => {});
              else recovered.delete(inst.id); // no se pudo apartar: se reintenta en la proxima operacion
            }
            local.forgetStamp(target);
            const st = await local.worldStamp(target, { force: true });
            entry = { version: remote.version, sha1: remote.sha1, stamp: st?.stamp || null, syncedAt: Date.now(), movedTo };
          }
          const fresh = await local.readState(inst);
          if (fresh.key === state.key) {
            const { movedTo: _m, ...clean } = entry;
            if (isConfig) fresh.config = clean;
            else fresh.worlds[name] = clean;
          }
          // la copia local que quedo aparte no se sube sola (es un respaldo, no una partida nueva)
          if (entry.movedTo) fresh.ignored = [...new Set([...(Array.isArray(fresh.ignored) ? fresh.ignored : []), entry.movedTo])].slice(-50);
          await local.writeState(inst, fresh);
          task.update({ progress: 1 });
          return { ok: true, version: remote.version, size: remote.size, movedTo: entry.movedTo || null };
        } finally {
          await rmrf(tmp).catch(() => {});
          await rmrf(incoming).catch(() => {});
        }
      },
      { instanceId, kind: 'cloudsync:download' },
    );
  });
}

async function collect(dir, rel, out) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await collect(path.join(dir, e.name), r, out);
    else if (e.isFile()) out.push(r);
  }
}

// ---------- Borrar de la nube ----------

async function remove(instanceId, world, auth, notify) {
  return withLock(instanceId, async () => {
    const inst = await instances.get(instanceId);
    await recoverLeftovers(inst);
    const state = await local.readState(inst);
    const session = await Session.open(auth, notify);
    const isConfig = world === CONFIG;
    const name = isConfig ? 'config' : validWorld(world);
    const row = await findRow(session, isConfig ? 'config' : 'world', state.key, name);
    if (!row) return { ok: true, removed: false };
    await session.rest('DELETE', `cloud_saves?id=eq.${enc(row.id)}`);
    await session.remove(partPaths(session, row)).catch((err) => console.warn('[cloudsync] borrar partes:', err?.message || err));
    const fresh = await local.readState(inst);
    if (isConfig) fresh.config = null;
    else delete fresh.worlds[name];
    await local.writeState(inst, fresh);
    return { ok: true, removed: true };
  });
}

// ---------- Automatico ----------

/**
 * direction: 'down' (al abrir el launcher), 'up' (al cerrar el juego) o 'both'.
 * Sube lo que cambio aca y baja lo que cambio en otra PC; los conflictos no se tocan (se informan).
 */
async function autoSync(instanceId, auth, opts = {}, notify) {
  const inst = await instances.get(instanceId);
  const state = await local.readState(inst);
  const result = { uploaded: [], downloaded: [], conflicts: [], errors: [] };
  if (!state.auto) return result;
  if (gameRunning(instanceId)) return result;
  const dir = ['up', 'down', 'both'].includes(opts.direction) ? opts.direction : 'both';
  const st = await status(instanceId, auth, notify);
  const since = Math.max(state.autoSince || 0, Number(opts.since) || 0);
  const ignored = new Set(Array.isArray(state.ignored) ? state.ignored : []);
  const run = async (fn, item, list) => {
    try {
      const r = await fn();
      if (r?.conflict) result.conflicts.push(item);
      else list.push(item);
    } catch (err) {
      result.errors.push({ ...item, error: err?.message || String(err) });
    }
  };
  for (const w of st.worlds) {
    const item = { folder: w.folder, name: w.displayName };
    if (w.state === 'conflict') result.conflicts.push(item);
    else if ((dir === 'down' || dir === 'both') && (w.state === 'remoteNewer' || w.state === 'remoteOnly')) await run(() => download(instanceId, w.folder, auth, {}, notify), item, result.downloaded);
    else if ((dir === 'up' || dir === 'both') && (w.state === 'localNewer' || (w.state === 'localOnly' && !ignored.has(w.folder) && (w.lastPlayed || 0) >= since))) await run(() => upload(instanceId, w.folder, auth, {}, notify), item, result.uploaded);
  }
  if (state.configs) {
    const item = { folder: CONFIG, name: t('cloudsync.configsName') };
    const cs = st.config.state;
    if (cs === 'conflict') result.conflicts.push(item);
    else if ((dir === 'down' || dir === 'both') && (cs === 'remoteNewer' || cs === 'remoteOnly')) await run(() => download(instanceId, CONFIG, auth, {}, notify), item, result.downloaded);
    else if ((dir === 'up' || dir === 'both') && (cs === 'localNewer' || cs === 'localOnly')) await run(() => upload(instanceId, CONFIG, auth, {}, notify), item, result.uploaded);
  }
  return result;
}

// ---------- Ajustes ----------

async function getSettings(instanceId, patch) {
  if (!instanceId) {
    const dev = await local.device();
    const list = [];
    for (const inst of await instances.list()) {
      await recoverIdle(inst);
      const s = await local.readState(inst);
      list.push({ id: inst.id, name: inst.name, auto: s.auto, key: s.key, configs: s.configs });
    }
    return { device: dev, instances: list };
  }
  const inst = await instances.get(instanceId);
  const s = await local.readState(inst);
  if (patch && typeof patch === 'object') {
    if (typeof patch.auto === 'boolean' && patch.auto !== s.auto) {
      s.auto = patch.auto;
      if (patch.auto) s.autoSince = Date.now();
    }
    if (typeof patch.configs === 'boolean') s.configs = patch.configs;
    if (patch.key !== undefined) {
      const key = patch.key === null ? local.defaultKey(inst.id) : String(patch.key);
      if (!local.KEY_RE.test(key)) throw new CloudError('bad_key', t('cloudsync.errBadKey'));
      if (key !== s.key) {
        s.key = key;
        s.worlds = {};
        s.config = null;
      }
    }
    await local.writeState(inst, s);
  }
  return { key: s.key, defaultKey: local.defaultKey(inst.id), auto: s.auto, autoSince: s.autoSince, configs: s.configs };
}

module.exports = { CONFIG, status, upload, download, remove, autoSync, getSettings, isBusy, classify };
