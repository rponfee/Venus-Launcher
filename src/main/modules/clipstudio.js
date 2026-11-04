'use strict';
// Estudio de clips: Montaje de la semana y Timelapse de tu mundo. La interfaz elige y codifica (WebCodecs, en
// features/clipstudio/); aca se leen y se escriben los WebM (clipstudio/webmjoin.js y job.js) y se sacan las imagenes del
// timelapse (clipstudio/timelapse.js, con la captura de modules/capture.js: solo la ventana del juego, nunca la pantalla).
// Todo lo que sale va a <instancia>/clips/ y lo ve la galeria como cualquier clip. Guia: docs/wip/clips-33.md.
//
// Canales:
//   clipstudio:probe([rutas]) -> [{ path, ok, codec, width, height, audio, duration }]
//   clipstudio:montageOpen({ instanceId, segments: [{ path, start, length }], title }) -> { jobId, mode, width, height, codec, reason }
//   clipstudio:montageCopy(jobId) (unir sin recodificar; progreso por clipstudio:progress)
//   clipstudio:montageSegment(jobId, i) -> { codec, width, height, offset, length } · clipstudio:montageRead(jobId, max) -> { frames, done }
//   clipstudio:frames(jobId, [{ time, key, data }]) · clipstudio:finish(jobId) -> { path, name, duration } · clipstudio:cancel(jobId)
//   clipstudio:timelapseOpen({ instanceId, folder, width, height, codec }) -> { jobId }
//   clipstudio:timelapseConfig(instanceId, patch?) -> ajustes · clipstudio:timelapseList(instanceId) -> { config, used, folders }
//   clipstudio:timelapseFrames(instanceId, carpeta) -> [nombres] · clipstudio:timelapseRead(instanceId, carpeta, nombre) -> bytes
//   clipstudio:timelapseOpenFolder(instanceId, carpeta?) · clipstudio:timelapseDelete(instanceId, carpeta) (a la papelera)
//   clipstudio:timelapseStatus() -> { active, instanceId, folder, frames, used, capBytes, stopped }
// Eventos: clipstudio:progress { jobId, done, total }, clipstudio:timelapse (lo mismo que timelapseStatus)
const fsp = require('fs/promises');
const path = require('path');
const game = require('../core/game');
const instances = require('../core/instances');
const { t } = require('../core/i18n');
const { readJson, writeJson, exists, uid, dirSize } = require('../core/util');
const logic = require('./capture/logic');
const media = require('./worlds/media');
const join = require('./clipstudio/webmjoin');
const { VideoJob } = require('./clipstudio/job');
const tl = require('./clipstudio/timelapse-logic');
const { createTimelapse } = require('./clipstudio/timelapse');

const MAX_SEGMENTS = 40;
const MAX_FRAME_BATCH = 400;
const JOB_IDLE_MS = 5 * 60000; // una interfaz recargada a la mitad no deja el archivo abierto
const TIMELAPSE_JPEG = { mime: 'image/jpeg', quality: 0.85, maxHeight: 1080 };

let ctx = null;
const jobs = new Map();
let timelapse = null;
let watchdog = null;

const send = (...a) => ctx?.send?.(...a);

function coded(key, code, vars) {
  const err = new Error(t(`clipstudio.${key}`, vars));
  err.code = code;
  return err;
}

function capture() {
  return require('./capture');
}

async function instanceDir(instanceId) {
  try {
    await instances.get(String(instanceId || ''));
    const dir = instances.dir(String(instanceId));
    return ctx?.safePath ? ctx.safePath(dir) : path.resolve(dir);
  } catch {
    throw coded('errInstance', 'instance');
  }
}

// ---------- Videos que se estan armando ----------

function jobOf(id) {
  const job = jobs.get(String(id));
  if (!job) throw coded('errJob', 'job');
  return job;
}

function startWatchdog() {
  if (watchdog) return;
  watchdog = setInterval(() => {
    for (const [id, job] of jobs) {
      if (Date.now() - job.touched > JOB_IDLE_MS) dropJob(id);
    }
    if (!jobs.size) {
      clearInterval(watchdog);
      watchdog = null;
    }
  }, 30000);
  watchdog.unref?.();
}

async function dropJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  await job.abort().catch((err) => console.warn('[clipstudio] cancelar:', err?.message || err));
}

// Ruta final en clips/: "<fecha>_montage.webm" o "<fecha>_timelapse.webm"
async function outputPath(instanceId, tag) {
  const dir = logic.folderFor(await instanceDir(instanceId), 'clip');
  await fsp.mkdir(dir, { recursive: true });
  const name = await logic.uniqueName(dir, `${logic.stamp()}_${tag}.webm`, exists);
  return path.join(dir, name);
}

async function addJob(job, instanceId) {
  try {
    await job.open();
  } catch (err) {
    console.warn('[clipstudio] no se pudo crear el archivo:', err?.message || err);
    throw coded(err?.code === 'ENOSPC' ? 'errNoSpace' : 'errWrite', 'write');
  }
  const jobId = uid();
  job.instanceId = instanceId;
  jobs.set(jobId, job);
  startWatchdog();
  return jobId;
}

function clipPath(p) {
  const m = media.checkMediaPath(p);
  if (!m || m.kind !== 'clip' || !/\.webm$/i.test(m.full)) throw coded('errClip', 'clip');
  return m.full;
}

async function probe(paths) {
  const list = Array.isArray(paths) ? paths.slice(0, 200) : [];
  const out = [];
  for (const p of list) {
    let full;
    try {
      full = clipPath(p);
    } catch {
      out.push({ path: String(p || ''), ok: false, reason: 'clip' });
      continue;
    }
    const r = await join.probeFile(full);
    out.push({ path: String(p), ok: r.ok, reason: r.reason, codec: r.codec, width: r.width, height: r.height, duration: r.duration, audio: Boolean(r.audio) });
  }
  return out;
}

// Inicio o largo de un tramo en segundos; null = sin recortar (Number(null) daria 0: un tramo vacio)
const segNumber = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

async function montageOpen(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const instanceId = String(o.instanceId || '');
  await instanceDir(instanceId);
  const raw = Array.isArray(o.segments) ? o.segments.slice(0, MAX_SEGMENTS) : [];
  if (!raw.length) throw coded('errNoClips', 'empty');
  const segments = [];
  for (const s of raw) {
    const file = clipPath(s?.path);
    const info = await join.probeFile(file);
    if (!info.ok) throw coded('errClipBad', 'badWebm', { name: path.basename(file) });
    segments.push({ path: file, start: segNumber(s.start) || 0, length: segNumber(s.length), probe: info });
  }
  const plan = join.planJoin(segments.map((s) => s.probe));
  const file = await outputPath(instanceId, 'montage');
  const header = plan.mode === 'copy' ? plan.template.header : join.encodedHeader({ width: plan.width, height: plan.height, codec: plan.codec, audioRaw: plan.template.audio?.raw || null });
  const tracks = plan.mode === 'copy' ? join.tracksOf(plan.template) : { video: 1, audio: plan.template.audio ? 2 : 0 };
  const job = new VideoJob({ file, header, tracks, segments, template: plan.template });
  const jobId = await addJob(job, instanceId);
  return { jobId, mode: plan.mode, width: plan.width, height: plan.height, codec: plan.codec, reason: plan.reason, segments: segments.length };
}

async function montageCopy(id) {
  const job = jobOf(id);
  let last = 0;
  try {
    await job.copyAll(({ done, total }) => {
      const now = Date.now();
      if (now - last < 150 && done < total) return;
      last = now;
      send('clipstudio:progress', { jobId: String(id), done, total });
    });
  } catch (err) {
    if (job.cancelled) return false;
    console.warn('[clipstudio] unir:', err?.message || err);
    await dropJob(String(id));
    throw coded(err?.code === 'ENOSPC' ? 'errNoSpace' : 'errWrite', 'write');
  }
  return !job.cancelled;
}

async function finish(id) {
  const key = String(id);
  const job = jobOf(key);
  jobs.delete(key);
  let res;
  try {
    res = await job.finish();
  } catch (err) {
    await job.abort().catch(() => {});
    if (err?.code === 'empty') throw coded('errEmpty', 'empty');
    console.warn('[clipstudio] terminar:', err?.message || err);
    throw coded(err?.code === 'ENOSPC' ? 'errNoSpace' : 'errWrite', 'write');
  }
  await capture().savedElsewhere({ file: res.file, instanceId: job.instanceId, duration: res.duration });
  return { path: res.file, name: path.basename(res.file), duration: res.duration, instanceId: job.instanceId };
}

async function addFrames(id, frames) {
  const job = jobOf(id);
  const list = Array.isArray(frames) ? frames.slice(0, MAX_FRAME_BATCH) : [];
  try {
    await job.addEncoded(list);
  } catch (err) {
    console.warn('[clipstudio] escribir:', err?.message || err);
    await dropJob(String(id));
    throw coded(err?.code === 'ENOSPC' ? 'errNoSpace' : 'errWrite', 'write');
  }
  return true;
}

// ---------- Timelapse: carpetas ----------

const rootOf = async (instanceId) => path.join(await instanceDir(instanceId), tl.ROOT_DIR);
const configFile = async (instanceId) => path.join(await instanceDir(instanceId), '.venus', tl.CONFIG_FILE);

async function readConfig(instanceId) {
  return tl.normalizeConfig(await readJson(await configFile(instanceId), null));
}

async function setConfig(instanceId, patch) {
  const next = tl.normalizeConfig({ ...(await readConfig(instanceId)), ...(patch && typeof patch === 'object' ? patch : {}) });
  const file = await configFile(instanceId);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await writeJson(file, next);
  // Si esa instancia esta abierta, se prende o se apaga en el momento
  const st = game.status()[instanceId];
  if (st?.state === 'running' && !st.quiet) await timelapse.start(instanceId);
  return next;
}

async function folderPath(instanceId, folder) {
  if (!tl.validFolder(folder)) throw coded('errFolder', 'folder');
  return path.join(await rootOf(instanceId), folder);
}

async function listFolders(instanceId) {
  const root = await rootOf(instanceId);
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const folders = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const files = await fsp.readdir(path.join(root, e.name), { withFileTypes: true }).catch(() => []);
    const list = [];
    for (const f of files) {
      if (!f.isFile() || !tl.isFrameFile(f.name)) continue;
      const st = await fsp.stat(path.join(root, e.name, f.name)).catch(() => null);
      if (st) list.push({ name: f.name, size: st.size });
    }
    const sum = tl.summarize(e.name, list);
    if (sum.count) folders.push(sum);
  }
  folders.sort((a, b) => (a.last < b.last ? 1 : -1));
  return folders;
}

async function listFrames(instanceId, folder) {
  const dir = await folderPath(instanceId, folder);
  const names = await fsp.readdir(dir).catch(() => []);
  return names.filter(tl.isFrameFile).sort();
}

async function readFrame(instanceId, folder, name) {
  if (!tl.isFrameFile(name)) throw coded('errFolder', 'folder');
  return fsp.readFile(path.join(await folderPath(instanceId, folder), name));
}

async function deleteFolder(instanceId, folder) {
  const { shell } = require('electron');
  const dir = await folderPath(instanceId, folder);
  if (!(await exists(dir))) return true;
  try {
    await shell.trashItem(dir);
  } catch (err) {
    console.warn('[clipstudio] papelera:', err?.message || err);
    throw coded('errTrash', 'trash');
  }
  return true;
}

// ---------- Registro ----------

function makeTimelapse() {
  return createTimelapse({
    grab: (id) => capture().grabFrame(id, TIMELAPSE_JPEG),
    activityOf: (id) => game.activity(id),
    config: (id) => readConfig(id),
    usage: async (id) => dirSize(await rootOf(id)).catch(() => 0),
    freeBytes: async (id) => {
      const st = await fsp.statfs(await instanceDir(id));
      return st.bavail * st.bsize;
    },
    write: async (id, folder, stamp, data) => {
      const dir = await folderPath(id, folder);
      await fsp.mkdir(dir, { recursive: true });
      const name = await logic.uniqueName(dir, `${stamp}.jpg`, exists);
      await fsp.writeFile(path.join(dir, name), data);
    },
    stamp: () => logic.stamp(),
    notify: (key) => send('capture:notice', { level: 'info', message: t(`clipstudio.${key}`) }),
    emit: (view) => send('clipstudio:timelapse', view),
    warn: (err) => console.warn('[clipstudio] timelapse:', err?.message || err),
  });
}

function register(c) {
  ctx = c;
  const { handle, onQuit } = c;
  timelapse = makeTimelapse();

  game.events.on('state', (id, st) => {
    if (!st || st.quiet) return;
    if (st.state === 'running') timelapse.start(id).catch((err) => console.warn('[clipstudio] timelapse:', err?.message || err));
    else if (st.state === 'stopped' || st.state === 'crashed') timelapse.stop(id);
  });

  handle('clipstudio:probe', (paths) => probe(paths));
  handle('clipstudio:montageOpen', (opts) => montageOpen(opts));
  handle('clipstudio:montageCopy', (id) => montageCopy(id));
  handle('clipstudio:montageSegment', (id, i) => jobOf(id).openSegment(Number(i)));
  handle('clipstudio:montageRead', (id, max) => jobOf(id).readVideo(Math.min(120, Math.max(1, Number(max) || 24))));
  handle('clipstudio:frames', (id, frames) => addFrames(id, frames));
  handle('clipstudio:finish', (id) => finish(id));
  handle('clipstudio:cancel', (id) => dropJob(String(id)));

  handle('clipstudio:timelapseOpen', async (opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    const instanceId = String(o.instanceId || '');
    if (!tl.validFolder(o.folder)) throw coded('errFolder', 'folder');
    const width = Math.round(Number(o.width));
    const height = Math.round(Number(o.height));
    if (!(width >= 2 && height >= 2 && width <= 7680 && height <= 4320)) throw coded('errFolder', 'folder');
    const codec = o.codec === 'V_VP8' ? 'V_VP8' : 'V_VP9';
    const file = await outputPath(instanceId, 'timelapse');
    const job = new VideoJob({ file, header: join.encodedHeader({ width, height, codec }), tracks: { video: 1, audio: 0 }, frameDur: Math.round(Number(o.frameMs)) || join.FRAME_MS });
    return { jobId: await addJob(job, instanceId) };
  });
  handle('clipstudio:timelapseConfig', (instanceId, patch) => (patch === undefined ? readConfig(String(instanceId || '')) : setConfig(String(instanceId || ''), patch)));
  handle('clipstudio:timelapseList', async (instanceId) => {
    const id = String(instanceId || '');
    const folders = await listFolders(id);
    return { config: await readConfig(id), used: folders.reduce((n, f) => n + f.bytes, 0), folders };
  });
  handle('clipstudio:timelapseFrames', (instanceId, folder) => listFrames(String(instanceId || ''), folder));
  handle('clipstudio:timelapseRead', (instanceId, folder, name) => readFrame(String(instanceId || ''), folder, name));
  handle('clipstudio:timelapseOpenFolder', async (instanceId, folder) => {
    const { shell } = require('electron');
    const id = String(instanceId || '');
    const dir = folder ? await folderPath(id, folder) : await rootOf(id);
    await fsp.mkdir(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
    return true;
  });
  handle('clipstudio:timelapseDelete', (instanceId, folder) => deleteFolder(String(instanceId || ''), folder));
  handle('clipstudio:timelapseStatus', () => timelapse.view());

  onQuit(async () => {
    timelapse.stop();
    clearInterval(watchdog);
    await Promise.all([...jobs.keys()].map((id) => dropJob(id)));
  });
}

module.exports = { register };
