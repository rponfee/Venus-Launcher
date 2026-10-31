'use strict';
// Mundos: lista de todas las instancias, ficha de cada mundo, linea de tiempo (partidas, capturas, clips y
// logros por dia), capturas y clips con miniaturas, copias de seguridad, copiar a otra instancia o a un
// servidor local, renombrar y mandar a la papelera.
//
// Canales:
//   worlds:list({ instanceId? })          -> [mundo]  (tamanio en cache; los que faltan llegan por 'worlds:updated')
//   worlds:get(instanceId, folder)        -> mundo con detalles (data packs, jugadores, copias, creacion)
//   worlds:recent(limit)                  -> mundos jugados mas recientemente (para el Inicio)
//   worlds:timeline(instanceId, folder)   -> { world, days, totals, created, advancements }
//   worlds:screenshots({ instanceId?, world?, limit?, offset? }) -> [captura]
//   worlds:clips({ instanceId?, world?, limit? }) · worlds:media({ instanceId?, world?, kind? }) -> { items, counts }
//   worlds:thumbs([rutas]) -> { ruta: url } · worlds:stats(instanceId, folder) -> estadisticas del juego (respaldo)
//   worlds:backup(instanceId, folder) · worlds:backups(instanceId, folder?) · worlds:allBackups() · worlds:restoreBackup(instanceId, folder, ruta, { mode })
//   worlds:deleteBackup(ruta) · worlds:showBackup(ruta) · worlds:openBackups(instanceId?)
//   worlds:copyTargets(instanceId, folder) · worlds:copy(instanceId, folder, { instanceId | serverId, replace?, player? })
//   worlds:rename(instanceId, folder, nombre) · worlds:delete(instanceId, folder) · worlds:openFolder(instanceId, folder)
//   worlds:openMedia / showMedia / copyImage / deleteMedia / readMedia (ruta) · worlds:shared() · worlds:setShared(clave, datos|null)
// Evento: 'worlds:updated' ({ kind: 'sizes' | 'timeline' | 'list' | 'media', ... })
const fsp = require('fs/promises');
const path = require('path');
const instances = require('../core/instances');
const game = require('../core/game');
const tasks = require('../core/tasks');
const { t } = require('../core/i18n');
const { exists } = require('../core/util');
const level = require('./worlds/level');
const adv = require('./worlds/advancements');
const timeline = require('./worlds/timeline');
const media = require('./worlds/media');
const backups = require('./worlds/backups');
const transfer = require('./worlds/transfer');
const ingame = require('./worlds/ingame');

let ctx = null;
const send = (...a) => ctx?.send?.(...a);

// ---------- Utilidades ----------

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function checkIds(instanceId, folder) {
  if (!level.validSegment(instanceId) || (folder !== undefined && !level.validSegment(folder))) throw new Error(t('worlds.errInvalid'));
}

async function getInstance(id) {
  checkIds(id);
  try {
    return await instances.get(id);
  } catch {
    throw new Error(t('worlds.errInstance'));
  }
}

function guard(p) {
  return ctx?.safePath ? ctx.safePath(p) : path.resolve(p);
}

function worldDir(inst, folder) {
  checkIds(inst.id, folder);
  return guard(path.join(inst.dir, 'saves', folder));
}

async function requireWorld(inst, folder) {
  const dir = worldDir(inst, folder);
  if (!(await exists(path.join(dir, 'level.dat')))) throw new Error(t('worlds.errNotFound'));
  return dir;
}

// El mundo esta abierto en el juego (o no se sabe cual esta abierto en esa instancia)
function isOpen(instanceId, folder) {
  if (!game.status()[instanceId]) return false;
  const act = game.activity(instanceId);
  if (act?.type === 'singleplayer') return !act.world || act.world === folder;
  const live = timeline.liveWorld(instanceId);
  return Boolean(live && live.world === folder);
}

function playingNow(instanceId, folder) {
  if (!game.status()[instanceId]) return false;
  const act = game.activity(instanceId);
  return act?.type === 'singleplayer' && act.world === folder;
}

function trash(p) {
  return require('electron').shell.trashItem(p);
}

// Datos publicos de un mundo (sin rutas internas)
function publicWorld(w) {
  if (!w) return null;
  const { iconPath: _i, levelMtime: _m, ...rest } = w;
  return { ...rest, playing: playingNow(w.instanceId, w.folder) };
}

// ---------- Lista ----------

const sizeQueue = new Set();
let sizeRunning = false;

// Mide en segundo plano los mundos sin tamanio en cache y avisa a la interfaz en tandas.
function scheduleSizes(list) {
  for (const w of list) sizeQueue.add(JSON.stringify([w.instanceId, w.folder, w.levelMtime, w.dir]));
  if (sizeRunning) return;
  sizeRunning = true;
  (async () => {
    let batch = [];
    let last = Date.now();
    while (sizeQueue.size) {
      const key = sizeQueue.values().next().value;
      sizeQueue.delete(key);
      const [instanceId, folder, levelMtime, dir] = JSON.parse(key);
      try {
        const size = await level.measure(instanceId, folder, dir, levelMtime);
        batch.push({ instanceId, folder, size });
      } catch {
        /* el mundo se borro mientras tanto */
      }
      if (batch.length && (batch.length >= 8 || Date.now() - last > 700)) {
        send('worlds:updated', { kind: 'sizes', items: batch });
        batch = [];
        last = Date.now();
      }
    }
    if (batch.length) send('worlds:updated', { kind: 'sizes', items: batch });
  })()
    .catch((err) => console.warn('[worlds] tamanios:', err.message))
    .finally(() => {
      sizeRunning = false;
      if (sizeQueue.size) scheduleSizes([]);
    });
}

async function list(opts = {}) {
  const instanceId = opts && typeof opts === 'object' && opts.instanceId ? String(opts.instanceId) : null;
  const all = await instances.list().catch(() => []);
  const insts = instanceId ? all.filter((i) => i.id === instanceId) : all;
  if (instanceId && !insts.length) throw new Error(t('worlds.errInstance'));
  const known = await level.knownUuids();
  const out = [];
  const missing = [];
  await mapLimit(insts, 3, async (inst) => {
    const folders = await level.folders(inst.dir);
    await mapLimit(folders, 6, async (folder) => {
      try {
        const w = await level.describe(inst, folder, { known });
        if (!w) return;
        if (w.size === null) missing.push({ ...w, dir: path.join(inst.dir, 'saves', folder) });
        out.push(publicWorld(w));
      } catch (err) {
        console.warn('[worlds] no se pudo leer', inst.id, folder, err.message);
      }
    });
  });
  if (missing.length) scheduleSizes(missing);
  return out.sort((a, b) => b.lastPlayed - a.lastPlayed || a.name.localeCompare(b.name));
}

async function recent(limit = 6) {
  const n = Math.max(1, Math.min(50, Number(limit) || 6));
  const all = await list();
  return all.slice(0, n).map((w) => ({
    instanceId: w.instanceId,
    instanceName: w.instanceName,
    folder: w.folder,
    name: w.name,
    version: w.version || w.instanceVersion,
    lastPlayed: w.lastPlayed,
    icon: w.icon,
    gameMode: w.gameMode,
    hardcore: w.hardcore,
    playtime: w.playtime,
    playing: w.playing,
  }));
}

async function countDir(dir, filter) {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter(filter).length;
  } catch {
    return 0;
  }
}

async function get(instanceId, folder) {
  const inst = await getInstance(instanceId);
  const dir = await requireWorld(inst, folder);
  const known = await level.knownUuids();
  const w = await level.describe(inst, folder, { known, withSize: 'compute' });
  if (!w) throw new Error(t('worlds.errNotFound'));
  const [datapacks, players, bk, advs, trackedList] = await Promise.all([
    countDir(path.join(dir, 'datapacks'), (e) => e.isDirectory() || /\.zip(\.disabled)?$/i.test(e.name)),
    countDir(path.join(dir, 'playerdata'), (e) => e.isFile() && /\.dat$/i.test(e.name)),
    backups.list(inst.id, folder),
    adv.forWorld(dir, known),
    timeline.tracked(inst.id, folder),
  ]);
  return {
    ...publicWorld(w),
    datapacks,
    players: Math.max(players, w.hostPlayer ? 1 : 0),
    backups: { count: bk.length, last: bk[0]?.time || null, size: bk.reduce((a, b) => a + b.size, 0) },
    advancementsDone: [...advs.done.keys()].filter((id) => !id.includes(':recipes/')).length,
    created: timeline.createdOf({ birth: w.birth || 0, stamps: advs.stamps, trackedList: trackedList.filter((s) => !s.live) }),
    open: isOpen(inst.id, folder),
  };
}

// ---------- Capturas y clips ----------

// Todos los medios de una instancia con el mundo al que pertenecen.
async function instanceMedia(inst) {
  const [shots, vids, folders] = await Promise.all([media.screenshots(inst), media.clips(inst), level.folders(inst.dir)]);
  const items = shots.concat(vids);
  if (!items.length) return [];
  const known = await level.knownUuids();
  const names = new Map();
  const worlds = await mapLimit(folders, 6, async (folder) => {
    const d = path.join(inst.dir, 'saves', folder);
    const [a, lv] = await Promise.all([adv.forWorld(d, known), level.readLevel(d)]);
    names.set(folder, lv?.levelName || folder);
    const stamps = a.stamps.slice();
    if (lv?.lastPlayed > 0) stamps.push(lv.lastPlayed);
    stamps.sort((x, y) => x - y);
    return { folder, stamps };
  });
  const trackedAll = await timeline.sessions({ instanceId: inst.id });
  const live = timeline.liveWorld(inst.id);
  if (live) trackedAll.push({ world: live.world, start: live.start, end: Date.now() });
  const attr = timeline.attribute(worlds, trackedAll, items);
  for (const it of items) {
    const a = attr.get(it);
    it.world = a?.world || null;
    it.how = a?.how || null;
    it.worldName = a?.world ? names.get(a.world) || a.world : null;
  }
  return items;
}

function publicMedia(it, inst) {
  return {
    id: `${it.instanceId}|${it.rel}`,
    kind: it.kind,
    instanceId: it.instanceId,
    instanceName: inst?.name || it.instanceId,
    file: it.file,
    rel: it.rel,
    path: it.path,
    url: level.fileUrl(it.path, it.mtime),
    thumb: null,
    date: it.time,
    time: it.time,
    mtime: it.mtime,
    size: it.size,
    mime: media.mimeOf(it.file),
    world: it.worldName || null,
    worldFolder: it.world || null,
    how: it.how || null,
    sharedKey: media.sharedKey(it),
  };
}

function mediaFilter(filter) {
  const f = filter && typeof filter === 'object' ? filter : {};
  const instanceId = f.instanceId ? String(f.instanceId) : null;
  const world = f.world ? String(f.world) : null;
  if ((instanceId && !level.validSegment(instanceId)) || (world && !level.validSegment(world))) throw new Error(t('worlds.errInvalid'));
  const limit = Number.isFinite(Number(f.limit)) && Number(f.limit) > 0 ? Math.min(5000, Math.floor(Number(f.limit))) : 0;
  const offset = Math.max(0, Math.floor(Number(f.offset) || 0));
  const kind = f.kind === 'screenshot' || f.kind === 'clip' ? f.kind : 'all';
  return { instanceId, world, limit, offset, kind };
}

async function collectMedia(f) {
  const all = await instances.list().catch(() => []);
  const insts = f.instanceId ? all.filter((i) => i.id === f.instanceId) : all;
  const out = [];
  await mapLimit(insts, 3, async (inst) => {
    for (const it of await instanceMedia(inst)) {
      if (f.world && it.world !== f.world) continue;
      out.push(publicMedia(it, inst));
    }
  });
  return out.sort((a, b) => b.time - a.time);
}

async function withThumbs(items, generate) {
  await mapLimit(
    items.filter((i) => i.kind === 'screenshot'),
    4,
    async (it) => {
      it.thumb = (await media.existingThumb(it.path)) || (generate ? await media.thumb(it.path) : null);
    },
  );
  return items;
}

async function screenshots(filter) {
  const f = mediaFilter(filter);
  const items = (await collectMedia(f)).filter((i) => i.kind === 'screenshot');
  const page = f.limit ? items.slice(f.offset, f.offset + f.limit) : items.slice(f.offset);
  return withThumbs(page, page.length <= 12);
}

async function clips(filter) {
  const f = mediaFilter(filter);
  const items = (await collectMedia(f)).filter((i) => i.kind === 'clip');
  return f.limit ? items.slice(f.offset, f.offset + f.limit) : items.slice(f.offset);
}

async function mediaAll(filter) {
  const f = mediaFilter(filter);
  const items = await collectMedia(f);
  const counts = { screenshots: items.filter((i) => i.kind === 'screenshot').length, clips: items.filter((i) => i.kind === 'clip').length };
  const shown = f.kind === 'all' ? items : items.filter((i) => i.kind === f.kind);
  const page = f.limit ? shown.slice(f.offset, f.offset + f.limit) : shown.slice(f.offset);
  return { items: await withThumbs(page, false), total: shown.length, counts };
}

async function thumbs(list) {
  const out = {};
  const arr = Array.isArray(list) ? list.slice(0, 60) : [];
  await mapLimit(arr, 2, async (p) => {
    const m = media.checkMediaPath(p);
    if (!m || m.kind !== 'screenshot') return;
    guard(m.full);
    out[p] = await media.thumb(m.full);
  });
  return out;
}

function mediaPath(p) {
  const m = media.checkMediaPath(p);
  if (!m) throw new Error(t('worlds.errMedia'));
  return { ...m, full: guard(m.full) };
}

// ---------- Linea de tiempo ----------

async function timelineOf(instanceId, folder) {
  const inst = await getInstance(instanceId);
  const dir = await requireWorld(inst, folder);
  const known = await level.knownUuids();
  const [w, lv, advs, trackedList, items] = await Promise.all([
    level.describe(inst, folder, { known }),
    level.readLevel(dir),
    adv.forWorld(dir, known),
    timeline.tracked(inst.id, folder),
    instanceMedia(inst),
  ]);
  if (!w) throw new Error(t('worlds.errNotFound'));
  const stamps = advs.stamps.slice();
  if (lv?.lastPlayed > 0) stamps.push(lv.lastPlayed);
  stamps.sort((a, b) => a - b);
  const advList = [...advs.done].filter(([, at]) => at).map(([id, at]) => ({ ...adv.info(id), at }));
  const mine = items.filter((it) => it.world === folder).map((it) => publicMedia(it, inst));
  const created = timeline.createdOf({ birth: w.birth || 0, stamps: advs.stamps, trackedList: trackedList.filter((s) => !s.live) });
  const tl = timeline.build({ tracked: trackedList, stamps, advancements: advList, media: mine, created });
  return {
    world: publicWorld(w),
    ...tl,
    advancements: adv.summary(advs.done, w.dataVersion),
  };
}

// ---------- Estadisticas del juego (respaldo propio) ----------

async function statsOf(instanceId, folder) {
  const inst = await getInstance(instanceId);
  const dir = await requireWorld(inst, folder);
  const known = await level.knownUuids();
  const [lv, data, advs] = await Promise.all([level.readLevel(dir), ingame.read(dir, known), adv.forWorld(dir, known)]);
  return { ingame: data, advancements: adv.summary(advs.done, lv?.dataVersion) };
}

// ---------- Copias de seguridad ----------

async function backupNow(instanceId, folder) {
  const inst = await getInstance(instanceId);
  await requireWorld(inst, folder);
  const w = await level.readLevel(worldDir(inst, folder));
  const name = w?.levelName || folder;
  const res = await tasks.run(t('worlds.taskBackup', { name }), (task) => backups.create(inst, folder, { task }), { instanceId });
  send('worlds:updated', { kind: 'backups', instanceId, world: folder });
  return res;
}

function backupPath(p, instanceId) {
  const b = backups.checkBackupPath(p);
  if (!b || (instanceId && b.instanceId !== instanceId)) throw new Error(t('worlds.errBackupNotFound'));
  return guard(b.file);
}

async function restoreBackup(instanceId, folder, file, opts = {}) {
  const inst = await getInstance(instanceId);
  checkIds(instanceId, folder);
  const full = backupPath(file, instanceId);
  if (!(await exists(full))) throw new Error(t('worlds.errBackupNotFound'));
  const mode = opts?.mode === 'replace' ? 'replace' : 'copy';
  if (mode === 'replace' && isOpen(instanceId, folder)) throw new Error(t('worlds.errOpen'));
  const cur = await level.readLevel(path.join(inst.dir, 'saves', folder)).catch(() => null);
  const name = cur?.levelName || folder;
  const res = await tasks.run(
    t('worlds.taskRestore', { name }),
    (task) =>
      backups.restore(inst, folder, full, {
        mode,
        task,
        trash,
        renameLevel: async (dir) => {
          const lv = await level.readLevel(dir);
          await transfer.setLevelName(dir, t('worlds.restoredName', { name: lv?.levelName || name }));
        },
      }),
    { instanceId },
  );
  await level.forgetSize(instanceId, res.folder);
  if (mode !== 'replace' && res.folder !== folder) {
    // La historia del mundo hasta el momento de la copia tambien es la del mundo restaurado
    const until = backups.parseName(path.basename(full))?.time || (await fsp.stat(full).catch(() => null))?.mtimeMs || 0;
    await timeline.copySessions({ instanceId, world: folder }, { instanceId, world: res.folder }, { until }).catch(() => 0);
  }
  send('worlds:updated', { kind: 'list', instanceId, world: res.folder });
  return res;
}

// Copias de todas las instancias, con el estado del mundo de origen (para restaurar mundos borrados)
async function allBackups() {
  const [list, insts] = await Promise.all([backups.listAll(), instances.list().catch(() => [])]);
  const byId = new Map(insts.map((i) => [i.id, i]));
  return Promise.all(
    list.map(async (b) => {
      const inst = byId.get(b.instanceId) || null;
      const worldExists = Boolean(inst && b.folder && level.validSegment(b.folder) && (await exists(path.join(inst.dir, 'saves', b.folder, 'level.dat'))));
      return { ...b, instanceName: inst?.name || null, instanceExists: Boolean(inst), worldExists };
    }),
  );
}

// ---------- Copiar, renombrar, borrar ----------

async function copyTargets(instanceId, folder) {
  const inst = await getInstance(instanceId);
  await requireWorld(inst, folder);
  const st = game.status();
  const insts = (await instances.list().catch(() => [])).map((i) => ({
    id: i.id,
    name: i.name,
    mcVersion: i.mcVersion,
    loader: i.preset === 'iris' ? 'iris' : i.loader,
    icon: typeof i.icon === 'string' && /^https?:\/\//.test(i.icon) ? i.icon : null,
    same: i.id === instanceId,
    running: Boolean(st[i.id]),
  }));
  let srvs = [];
  try {
    const servers = require('../core/servers');
    const listed = await servers.list();
    srvs = await Promise.all(
      listed.map(async (s) => {
        const proxy = typeof servers.isProxy === 'function' ? servers.isProxy(s) : ['velocity', 'waterfall', 'bungeecord'].includes(s.type);
        let levelName = 'world';
        let hasWorld = false;
        if (!proxy) {
          const props = await servers.readProperties(s.id).catch(() => ({}));
          levelName = String(props['level-name'] || 'world').trim() || 'world';
          hasWorld = !/[\\/]/.test(levelName) && (await exists(path.join(s.dir, levelName, 'level.dat')));
        }
        return { id: s.id, name: s.name, type: s.type, mcVersion: s.mcVersion || null, state: s.state || 'offline', proxy, level: levelName, hasWorld };
      }),
    );
  } catch (err) {
    console.warn('[worlds] servidores:', err.message);
  }
  return { instances: insts, servers: srvs };
}

async function selectedAccount() {
  try {
    const r = await require('../core/accounts').list();
    return r.accounts.find((a) => a.id === r.selected) || r.accounts[0] || null;
  } catch {
    return null;
  }
}

async function copy(instanceId, folder, target = {}) {
  const inst = await getInstance(instanceId);
  const src = await requireWorld(inst, folder);
  const lv = await level.readLevel(src);
  const name = lv?.levelName || folder;
  const tg = target && typeof target === 'object' ? target : {};
  if (tg.instanceId) {
    const dest = await getInstance(String(tg.instanceId));
    const same = dest.id === inst.id;
    const res = await tasks.run(
      t('worlds.taskCopy', { name, target: dest.name }),
      async (task) => {
        const r = await transfer.toInstance(src, dest, { name: same ? t('worlds.copyFolder', { folder }) : folder, task });
        if (same) await transfer.setLevelName(path.join(dest.dir, 'saves', r.folder), t('worlds.copyName', { name })).catch(() => {});
        return r;
      },
      { instanceId: dest.id },
    );
    send('worlds:updated', { kind: 'list', instanceId: dest.id, world: res.folder });
    return { kind: 'instance', instanceId: dest.id, instanceName: dest.name, folder: res.folder, skipped: res.skipped };
  }
  if (tg.serverId) {
    const servers = require('../core/servers');
    const s = await servers.get(String(tg.serverId)).catch(() => null);
    if (!s) throw new Error(t('worlds.errServer'));
    if ((typeof servers.isProxy === 'function' && servers.isProxy(s)) || ['velocity', 'waterfall'].includes(s.type)) throw new Error(t('worlds.errServerProxy'));
    if ((typeof servers.isRunning === 'function' && servers.isRunning(s.id)) || (s.state && s.state !== 'offline')) throw new Error(t('worlds.errServerRunning'));
    const props = await servers.readProperties(s.id).catch(() => ({}));
    const account = tg.player === false ? null : await selectedAccount();
    const res = await tasks.run(t('worlds.taskCopy', { name, target: s.name }), (task) => transfer.toServer(src, guardServer(s), props, { replace: Boolean(tg.replace), trash, account, task }), { serverId: s.id });
    send('servers:changed');
    return { kind: 'server', serverId: s.id, serverName: s.name, level: res.level, player: res.player, skipped: res.skipped };
  }
  throw new Error(t('worlds.errTarget'));
}

function guardServer(s) {
  return { ...s, dir: guard(s.dir) };
}

function cleanName(name) {
  return String(name ?? '')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function rename(instanceId, folder, name) {
  const inst = await getInstance(instanceId);
  const dir = await requireWorld(inst, folder);
  const clean = cleanName(name);
  if (!clean || clean.length > 64) throw new Error(t('worlds.errName'));
  if (isOpen(instanceId, folder)) throw new Error(t('worlds.errOpen'));
  await transfer.setLevelName(dir, clean);
  send('worlds:updated', { kind: 'list', instanceId, world: folder });
  return { name: clean };
}

async function remove(instanceId, folder) {
  const inst = await getInstance(instanceId);
  const dir = await requireWorld(inst, folder);
  if (isOpen(instanceId, folder)) throw new Error(t('worlds.errOpen'));
  try {
    await trash(dir);
  } catch {
    // Un mundo nunca se borra sin papelera
    throw new Error(t('worlds.errTrash', { name: folder }));
  }
  await level.forgetSize(instanceId, folder);
  send('worlds:updated', { kind: 'list', instanceId, world: folder, removed: true });
  return true;
}

// ---------- Registro ----------

function register(c) {
  ctx = c;
  const { handle, onQuit } = c;
  const { shell, clipboard, nativeImage } = require('electron');

  timeline.configure({ instanceDir: (id) => instances.dir(id) });
  timeline.start(game.events);
  timeline.events.on('changed', (e) => send('worlds:updated', { kind: 'timeline', ...e }));

  handle('worlds:list', (opts) => list(opts));
  handle('worlds:get', (instanceId, folder) => get(instanceId, folder));
  handle('worlds:recent', (limit) => recent(limit));
  handle('worlds:timeline', (instanceId, folder) => timelineOf(instanceId, folder));
  handle('worlds:screenshots', (filter) => screenshots(filter));
  handle('worlds:clips', (filter) => clips(filter));
  handle('worlds:media', (filter) => mediaAll(filter));
  handle('worlds:thumbs', (paths) => thumbs(paths));
  handle('worlds:stats', (instanceId, folder) => statsOf(instanceId, folder));

  handle('worlds:backup', (instanceId, folder) => backupNow(instanceId, folder));
  handle('worlds:backups', async (instanceId, folder) => {
    checkIds(instanceId, folder || undefined);
    return backups.list(instanceId, folder || null);
  });
  handle('worlds:allBackups', () => allBackups());
  handle('worlds:restoreBackup', (instanceId, folder, file, opts) => restoreBackup(instanceId, folder, file, opts));
  handle('worlds:deleteBackup', async (file) => {
    const full = backupPath(file);
    await backups.remove(full, { trash });
    send('worlds:updated', { kind: 'backups' });
    return true;
  });
  handle('worlds:showBackup', (file) => {
    shell.showItemInFolder(backupPath(file));
    return true;
  });
  handle('worlds:openBackups', async (instanceId) => {
    if (instanceId) checkIds(instanceId);
    const dir = guard(instanceId ? backups.dirFor(instanceId) : backups.root());
    await fsp.mkdir(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
    return true;
  });

  handle('worlds:copyTargets', (instanceId, folder) => copyTargets(instanceId, folder));
  handle('worlds:copy', (instanceId, folder, target) => copy(instanceId, folder, target));
  handle('worlds:rename', (instanceId, folder, name) => rename(instanceId, folder, name));
  handle('worlds:delete', (instanceId, folder) => remove(instanceId, folder));
  handle('worlds:openFolder', async (instanceId, folder) => {
    const inst = await getInstance(instanceId);
    const dir = await requireWorld(inst, folder);
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
    return true;
  });

  // Acciones sobre capturas y clips (solo archivos de las carpetas de medios de una instancia)
  handle('worlds:openMedia', async (p) => {
    const m = mediaPath(p);
    if (!(await exists(m.full))) throw new Error(t('worlds.errMediaMissing'));
    const err = await shell.openPath(m.full);
    if (err) throw new Error(err);
    return true;
  });
  handle('worlds:showMedia', (p) => {
    shell.showItemInFolder(mediaPath(p).full);
    return true;
  });
  handle('worlds:copyImage', async (p) => {
    const m = mediaPath(p);
    if (m.kind !== 'screenshot') throw new Error(t('worlds.errMedia'));
    const img = nativeImage.createFromPath(m.full);
    if (img.isEmpty()) throw new Error(t('worlds.errImage'));
    clipboard.writeImage(img);
    return true;
  });
  handle('worlds:deleteMedia', async (p) => {
    const m = mediaPath(p);
    if (!(await exists(m.full))) return true;
    try {
      await trash(m.full);
    } catch {
      throw new Error(t('worlds.errTrash', { name: path.basename(m.full) }));
    }
    send('worlds:updated', { kind: 'media', instanceId: m.instanceId });
    return true;
  });
  handle('worlds:readMedia', async (p) => {
    const m = mediaPath(p);
    const st = await fsp.stat(m.full).catch(() => null);
    if (!st) throw new Error(t('worlds.errMediaMissing'));
    if (st.size > 200 * 1024 * 1024) throw new Error(t('worlds.errTooBig', { size: '200 MB' }));
    const data = await fsp.readFile(m.full);
    const dims = m.kind === 'screenshot' ? await media.pngSize(m.full) : null;
    return { data, mime: media.mimeOf(m.full), size: st.size, name: path.basename(m.full), width: dims?.width || null, height: dims?.height || null };
  });
  handle('worlds:shared', () => media.sharedList());
  handle('worlds:setShared', (key, info) => media.setShared(key, info));

  // Limpieza de miniaturas viejas un rato despues de abrir
  setTimeout(() => media.pruneThumbs().catch(() => 0), 60000).unref?.();

  onQuit(async () => {
    await timeline.flush();
    await level.flushSizes();
  });
}

module.exports = { register, list, get, recent, timeline: timelineOf, screenshots, clips, isOpen };
