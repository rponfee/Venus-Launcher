'use strict';
// Instancias: cada una es una carpeta de juego independiente (mods, mundos, config...)
// con su propio archivo venus-instance.json. Tambien prepara la instalacion para jugar con
// "arranque rapido": si la misma version ya se verifico hace poco, solo se comprueba que los archivos sigan ahi.
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const AdmZip = require('adm-zip');
const paths = require('./paths');
const minecraft = require('./minecraft');
const java = require('./java');
const fabric = require('./loaders/fabric');
const forge = require('./loaders/forge');
const optifine = require('./loaders/optifine');
const modrinth = require('./modrinth');
const nbt = require('./nbt');
const tasks = require('./tasks');
const { t } = require('./i18n');
const { readJson, writeJson, uid, exists, rmrf, sanitizeFileName, dirSize } = require('./util');
// Rutas seguras y copias que respetan los enlaces duros del almacen (compartido con modrinth y los modulos).
const safety = require('../modules/packs/safety');

const gunzip = promisify(zlib.gunzip);

const META_FILE = 'venus-instance.json';
const VENUS_DIR = '.venus';
const PREPARED_FILE = 'prepared.json';
const PREPARED_VERSION = 1;
const PREPARED_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // verificacion completa como minimo una vez por semana
const IRIS_ID = 'YL57xq9U';
const LOADER_KINDS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge', 'optifine', 'legacyfabric', 'babric'];
const LOADER_NAMES = {
  vanilla: 'Vanilla',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
  optifine: 'OptiFine',
  legacyfabric: 'Legacy Fabric',
  babric: 'Babric',
  iris: 'Iris',
};
// Carpetas de contenido que la interfaz puede listar/modificar (mas "saves/<mundo>/datapacks").
const CONTENT_FOLDERS = ['mods', 'resourcepacks', 'shaderpacks', 'screenshots', 'saves', 'logs', 'crash-reports', 'config'];
const WRITABLE_FOLDERS = ['mods', 'resourcepacks', 'shaderpacks', 'screenshots', 'saves'];
const GAME_MODES = ['survival', 'creative', 'adventure', 'spectator'];
const MOD_FILE = /\.(jar|zip|litemod)(\.disabled)?$/i;
const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;
const LOG_FILE = /\.(log|txt|log\.gz)$/i;
const LOG_TAIL = 512 * 1024;
// Carpetas internas de .venus/ que no pasan a una copia de la instancia (ver duplicate).
const DUPLICATE_SKIP = /^\.venus\/(assistant-undo|compat-staging|pack-staging|share-incoming-[^/]*|cloudsync-incoming-[^/]*|cloudsync-old-[^/]*)$/;
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

let trashFn = null;

function setTrash(fn) {
  trashFn = fn;
}

// Manda a la papelera. Si la papelera falla y `hard` es true se borra del todo (mods, packs);
// para mundos y capturas nunca se borra sin papelera.
async function trash(target, { hard = true } = {}) {
  if (trashFn) {
    try {
      await trashFn(target);
      return;
    } catch (err) {
      if (!hard) throw new Error(t('instances.errTrash', { name: path.basename(target) }));
    }
  }
  await rmrf(target);
}

// Un id de instancia (o nombre de archivo) es un solo segmento de ruta seguro.
function validSegment(s) {
  return (
    typeof s === 'string' &&
    s.length > 0 &&
    s.length <= 255 &&
    s !== '.' &&
    s !== '..' &&
    s.trim() === s &&
    !/[\\/\x00-\x1f<>:"|?*]/.test(s)
  );
}

function dir(id) {
  if (!validSegment(id)) throw new Error(t('instances.errNotFound'));
  return paths.instance(id);
}

function metaPath(id) {
  return path.join(dir(id), META_FILE);
}

// Escrituras de venus-instance.json en serie por instancia (evita pisarse entre el juego, la interfaz,
// prepare, installProject, perf y el catalogo). Nunca llamar a update() desde adentro de otra operacion
// con cerrojo de la misma instancia (se esperarian entre si).
const locks = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(id, tail);
  tail.then(() => {
    if (locks.get(id) === tail) locks.delete(id);
  });
  return run;
}

async function list() {
  let entries = [];
  try {
    entries = await fsp.readdir(paths.instances(), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && validSegment(e.name))
      .map(async (e) => {
        const meta = await readJson(path.join(paths.instance(e.name), META_FILE), null);
        return meta ? { ...meta, id: e.name, dir: paths.instance(e.name) } : null;
      }),
  );
  return out.filter(Boolean).sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || (b.created || 0) - (a.created || 0));
}

async function get(id) {
  if (!validSegment(id)) throw new Error(t('instances.errNotFound'));
  const meta = await readJson(metaPath(id), null);
  if (!meta) throw new Error(t('instances.errNotFound'));
  return { ...meta, id, dir: dir(id) };
}

async function save(inst) {
  const { dir: _d, running: _r, ...data } = inst;
  await writeJson(metaPath(inst.id), data);
  return { ...data, dir: dir(inst.id) };
}

function cleanName(name) {
  return String(name ?? '')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

// Registros de proyectos instalados (modrinth.projects / curseforge.projects) y su carpeta por defecto.
const RECORD_SOURCES = ['modrinth', 'curseforge'];
const RECORD_FOLDERS = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' };

// ¿Sigue en la instancia el archivo de un registro (activo o desactivado)?
async function recordFilePresent(id, rec) {
  const raw = typeof rec?.file === 'string' ? rec.file.replace(/\\/g, '/') : '';
  const file = path.basename(raw).replace(/\.disabled$/, '');
  if (!validSegment(file)) return false;
  let base;
  try {
    base = contentDir(id, normFolder(rec.folder || RECORD_FOLDERS[rec.type] || 'mods'));
  } catch {
    return false;
  }
  return (await exists(path.join(base, file))) || (await exists(path.join(base, `${file}.disabled`)));
}

// Un parche armado con datos leidos ANTES de entrar en la cola (get + update) no borra los registros que
// otro agrego mientras tanto (por ejemplo, el catalogo instalando packs mientras prepare instala Iris):
// un registro que falta en el parche solo se quita si su archivo ya no esta en la instancia.
async function keepLiveRecords(id, before, after) {
  if (!before || typeof before !== 'object' || !after || typeof after !== 'object') return after;
  let out = after;
  for (const [pid, rec] of Object.entries(before)) {
    if (Object.prototype.hasOwnProperty.call(after, pid)) continue;
    if (await recordFilePresent(id, rec)) {
      if (out === after) out = { ...after };
      out[pid] = rec;
    }
  }
  return out;
}

/**
 * Cambia los datos de la instancia (en fila por instancia: nadie pisa lo que escribio otro).
 * patch: objeto (se mezcla con lo actual; memory, java y window campo por campo) o una funcion
 * (actual) => parche | null que corre DENTRO de la cola con los datos recien leidos: es la forma segura de
 * leer-modificar-escribir (registros de proyectos, contadores). Devolver null o nada no escribe.
 * Con un objeto, los registros de proyectos que falten en el parche se conservan si su archivo sigue
 * en la instancia (ver keepLiveRecords); con una funcion, el parche manda.
 */
function update(id, patch = {}) {
  return withLock(id, async () => {
    const cur = await get(id);
    const fromFn = typeof patch === 'function';
    let clean;
    if (fromFn) {
      const res = await patch(structuredClone(cur));
      if (!res || typeof res !== 'object') return cur;
      clean = { ...res };
    } else clean = { ...(patch || {}) };
    delete clean.id;
    delete clean.dir;
    delete clean.running;
    if ('name' in clean) {
      const name = cleanName(clean.name);
      if (name) clean.name = name;
      else delete clean.name;
    }
    const next = { ...cur, ...clean, id };
    if (clean.memory) next.memory = { ...cur.memory, ...clean.memory };
    if (clean.java) next.java = { ...cur.java, ...clean.java };
    if (clean.window) next.window = { ...cur.window, ...clean.window };
    if (!fromFn) {
      for (const key of RECORD_SOURCES) {
        const p = clean[key];
        if (!p || typeof p !== 'object') continue;
        if (!('projects' in p)) {
          // { modrinth: { pack } } cambia solo el pack: los registros quedan como estaban
          if (cur[key]?.projects) next[key] = { ...p, projects: cur[key].projects };
        } else if (p.projects && typeof p.projects === 'object') {
          const projects = await keepLiveRecords(id, cur[key]?.projects, p.projects);
          if (projects !== p.projects) next[key] = { ...p, projects };
        }
      }
    }
    return save(next);
  });
}

function defaultName(mcVersion, loader) {
  return `${LOADER_NAMES[loader] || loader} ${mcVersion}`;
}

function slugFor(name) {
  return (
    sanitizeFileName(name)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 40)
      .replace(/[-.]+$/g, '') || 'instancia'
  );
}

// opts: { name, mcVersion, loader, loaderVersion, preset, icon, group, pack }
async function create(opts = {}) {
  const mcVersion = typeof opts.mcVersion === 'string' ? opts.mcVersion.trim() : '';
  if (!mcVersion) throw new Error(t('instances.errNoVersion'));
  if (!minecraft.validVersionId(mcVersion)) throw new Error(t('instances.errBadVersion', { version: mcVersion }));
  const loader = opts.loader || 'vanilla';
  if (!LOADER_KINDS.includes(loader)) throw new Error(t('instances.errUnknownLoader', { loader: String(loader) }));
  const preset = typeof opts.preset === 'string' && opts.preset ? opts.preset : null;
  const name = cleanName(opts.name) || defaultName(mcVersion, preset === 'iris' ? 'iris' : loader);
  const base = slugFor(name);
  let id = base;
  while (await exists(paths.instance(id))) id = `${base}-${uid(4)}`;
  await fsp.mkdir(paths.instance(id), { recursive: true });
  const inst = {
    id,
    name,
    mcVersion,
    loader,
    loaderVersion: opts.loaderVersion || 'latest',
    preset,
    versionId: null,
    installed: false,
    icon: typeof opts.icon === 'string' && /^https?:\/\//.test(opts.icon) ? opts.icon : null,
    group: typeof opts.group === 'string' && opts.group.trim() ? opts.group.trim().slice(0, 40) : null,
    memory: { override: false, min: 1024, max: 4096 },
    java: { path: '', args: '' },
    window: { override: false, width: 0, height: 0, fullscreen: false },
    created: Date.now(),
    lastPlayed: 0,
    playtime: 0,
    launches: 0,
    modrinth: { projects: {}, pack: opts.pack || null },
  };
  return save(inst);
}

// Borra la instancia (a la papelera). Espera las escrituras de venus-instance.json en curso: una que
// terminara despues volveria a crear la carpeta con solo ese archivo (instancia fantasma).
async function remove(id) {
  const target = dir(id);
  await withLock(id, async () => {
    if (await exists(target)) await trash(target, { hard: !trashFn });
  });
  // Cache de mapas de la instancia (modulo mapviewer): se rehace sola, se borra del todo.
  await rmrf(paths.cache('maps', id)).catch(() => {});
}

// Copia recursiva (sin enlaces simbolicos). skip(rutaRelativa) permite omitir archivos o carpetas.
async function copyTree(src, dest, opts = {}, rel = '') {
  await fsp.mkdir(dest, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (opts.skip && opts.skip(r)) continue;
    if (opts.signal?.aborted) throw opts.signal.reason || new Error('aborted');
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyTree(s, d, opts, r);
    else if (e.isFile()) {
      await fsp.copyFile(s, d);
      if (opts.onFile) opts.onFile(r);
    }
  }
}

// worlds: false no copia saves/ (la copia queda sin mundos).
async function duplicate(id, { name, worlds = true } = {}) {
  const src = await get(id);
  const copy = await create({
    name: cleanName(name) || t('instances.copyName', { name: src.name }),
    mcVersion: src.mcVersion,
    loader: src.loader,
    loaderVersion: src.loaderVersion,
    preset: src.preset,
    icon: src.icon,
    group: src.group,
    pack: src.modrinth?.pack || null,
  });
  try {
    await tasks.run(
      t('instances.taskDuplicating', { name: src.name }),
      async (task) => {
        let count = 0;
        await copyTree(dir(id), dir(copy.id), {
          // session.lock lo bloquea el juego si la instancia esta abierta (y se vuelve a crear solo).
          // De .venus/ no se copian el arranque rapido, el Deshacer del asistente (es de la original) ni
          // las carpetas temporales de descargas a medio aplicar.
          skip: (rel) => rel === META_FILE || rel === 'logs' || rel === 'crash-reports' || rel === `${VENUS_DIR}/${PREPARED_FILE}` || rel.endsWith('/session.lock') || (worlds === false && rel === 'saves') || DUPLICATE_SKIP.test(rel),
          signal: task.signal,
          onFile: () => {
            count += 1;
            if (count % 25 === 0) task.update({ detail: t('instances.copiedFiles', { count }) });
          },
        });
        task.update({ detail: t('instances.copiedFiles', { count }) });
      },
      { instanceId: copy.id },
    );
  } catch (err) {
    await rmrf(dir(copy.id)).catch(() => {});
    throw err;
  }
  return update(copy.id, {
    versionId: src.versionId,
    installed: src.installed,
    loaderVersion: src.loaderVersion,
    memory: src.memory,
    java: src.java,
    window: src.window,
    modrinth: src.modrinth,
    icon: src.icon,
  });
}

// ---------- Arranque rapido (marcador <instancia>/.venus/prepared.json) ----------

function preparedPath(id) {
  return path.join(dir(id), VENUS_DIR, PREPARED_FILE);
}

async function readPrepared(id) {
  const m = await readJson(preparedPath(id), null);
  return m && m.v === PREPARED_VERSION ? m : null;
}

async function writePrepared(id, data) {
  await writeJson(preparedPath(id), { v: PREPARED_VERSION, ...data }).catch(() => {});
}

async function clearPrepared(id) {
  await fsp.rm(preparedPath(id), { force: true }).catch(() => {});
}

// El marcador vale si es de esta version, tiene menos de 7 dias y no viene "del futuro".
function preparedFresh(marker, versionId, now = Date.now()) {
  return Boolean(
    marker &&
      marker.v === PREPARED_VERSION &&
      marker.versionId === versionId &&
      typeof marker.hash === 'string' &&
      typeof marker.verifiedAt === 'number' &&
      marker.verifiedAt <= now + 60 * 1000 &&
      now - marker.verifiedAt < PREPARED_MAX_AGE,
  );
}

// Camino rapido: JSON de la version en disco con el mismo hash + chequeo barato de existencia de archivos.
async function fastResolve(versionId, marker) {
  if (!preparedFresh(marker, versionId)) return null;
  const local = await minecraft.resolveVersionLocal(versionId).catch(() => null);
  if (!local || local.hash !== marker.hash) return null;
  const check = await minecraft.quickVerify(local.resolved).catch(() => ({ ok: false }));
  return check.ok ? local : null;
}

async function installLoader(inst, task) {
  switch (inst.loader) {
    case 'vanilla':
      return { versionId: inst.mcVersion, loaderVersion: null };
    case 'fabric':
    case 'quilt':
    case 'legacyfabric':
    case 'babric':
      return fabric.install(inst.loader, inst.mcVersion, inst.loaderVersion, task);
    case 'forge':
    case 'neoforge':
      return forge.install(inst.loader, inst.mcVersion, inst.loaderVersion, task);
    case 'optifine':
      return optifine.install(inst.mcVersion, inst.loaderVersion, task);
    default:
      throw new Error(t('instances.errUnknownLoader', { loader: String(inst.loader) }));
  }
}

// Java: el elegido para la instancia, el que ya se uso con esta version (arranque rapido) o el runtime oficial.
async function resolveJava(inst, resolved, task, cached) {
  const custom = inst.java?.path;
  if (custom && (await exists(custom))) return { javaPath: custom, auto: false };
  const component = resolved.javaVersion?.component || 'jre-legacy';
  if (cached?.javaPath && cached.javaComponent === component && (await exists(cached.javaPath))) {
    return { javaPath: cached.javaPath, auto: true, component };
  }
  task?.update({ detail: t('instances.checkingJava'), progress: null });
  const javaPath = await java.ensureRuntime(component, resolved.javaVersion?.majorVersion, task);
  return { javaPath, auto: true, component };
}

// Instala el loader (si hace falta) y todos los archivos del juego. Devuelve lo necesario para lanzar.
// verify: 'size' (normal, permite el arranque rapido) | 'hash' (reparar: verificacion completa).
async function prepare(id, task, { verify = 'size' } = {}) {
  let inst = await get(id);
  const repair = verify === 'hash';
  const titleKey = repair ? 'instances.taskRepairing' : inst.installed ? 'instances.taskPreparing' : 'instances.taskInstalling';
  task?.update({ title: t(titleKey, { name: inst.name }) });
  if (repair) await clearPrepared(id);

  let versionId = inst.versionId;
  const needsLoader = !inst.installed || !versionId || !(await exists(paths.versionJson(versionId)));
  if (needsLoader) {
    task?.update({ detail: t('instances.installingLoader', { loader: LOADER_NAMES[inst.loader] || inst.loader, mc: inst.mcVersion }), progress: null });
    const res = await installLoader(inst, task);
    versionId = res.versionId;
    inst = await update(id, { versionId, loaderVersion: res.loaderVersion || inst.loaderVersion });
  }

  const marker = repair || needsLoader ? null : await readPrepared(id);
  let resolved = null;
  let hash = null;
  let quick = false;
  if (marker) {
    task?.update({ detail: t('instances.quickCheck'), progress: null });
    const local = await fastResolve(versionId, marker);
    if (local) {
      resolved = local.resolved;
      hash = local.hash;
      quick = true;
    }
  }
  if (!resolved) {
    resolved = await minecraft.installVersion(versionId, task, { verify });
    hash = (await minecraft.resolveVersionLocal(versionId).catch(() => null))?.hash || null;
  }

  const javaInfo = await resolveJava(inst, resolved, task, quick ? marker : null);
  if (!quick) {
    if (hash) {
      await writePrepared(id, {
        versionId,
        hash,
        verifiedAt: Date.now(),
        javaPath: javaInfo.auto ? javaInfo.javaPath : null,
        javaComponent: javaInfo.auto ? javaInfo.component : null,
      });
    }
  } else if (javaInfo.auto && javaInfo.javaPath !== marker.javaPath) {
    const { v: _v, ...rest } = marker;
    await writePrepared(id, { ...rest, javaPath: javaInfo.javaPath, javaComponent: javaInfo.component });
  }

  if (!inst.installed) {
    if (inst.preset === 'iris' && !inst.modrinth?.projects?.[IRIS_ID]) {
      task?.update({ detail: t('instances.installingIris'), progress: null });
      await installProject(id, IRIS_ID, null, { task });
    }
    inst = await update(id, { installed: true });
  }
  return { instance: inst, resolved, javaPath: javaInfo.javaPath, quick };
}

// Instala un proyecto de Modrinth (con dependencias) en la instancia.
async function installProject(id, projectId, versionId, { task, world, type, dependencies } = {}) {
  const inst = await get(id);
  const installed = inst.modrinth?.projects || {};
  const target = {
    gameVersion: inst.mcVersion,
    installed,
    loadersFor: (kind) => modrinth.loadersFor(kind, inst),
  };
  const { plan, warnings } = await modrinth.resolveInstall(target, projectId, versionId, { type, dependencies });
  const records = await modrinth.executePlan(dir(id), plan, { installed, world, task });
  // Los registros se suman sobre lo recien leido dentro de la cola (otra instalacion en paralelo no se pierde).
  await update(id, (fresh) => ({ modrinth: { ...(fresh.modrinth || {}), projects: { ...(fresh.modrinth?.projects || {}), ...records } } }));
  return { installed: Object.values(records).map((r) => r.title), warnings };
}

// ---------- Contenido ----------

// Resuelve una carpeta de contenido permitida dentro de la instancia (nunca sale de ella).
function contentDir(id, folder) {
  const parts = typeof folder === 'string' ? folder.replace(/\\/g, '/').split('/') : [];
  const ok =
    (parts.length === 1 && CONTENT_FOLDERS.includes(parts[0])) ||
    (parts.length === 3 && parts[0] === 'saves' && validSegment(parts[1]) && parts[2] === 'datapacks');
  if (!ok) throw new Error(t('instances.errFolder', { folder: String(folder) }));
  const base = path.resolve(dir(id));
  const full = path.resolve(base, ...parts);
  if (!full.startsWith(base + path.sep)) throw new Error(t('instances.errFolder', { folder: String(folder) }));
  return full;
}

function entryPath(base, file) {
  const name = typeof file === 'string' ? path.basename(file.replace(/\\/g, '/')) : '';
  if (!validSegment(name)) throw new Error(t('instances.errFileName'));
  return path.join(base, name);
}

function normFolder(f) {
  return String(f || '').replace(/\\/g, '/');
}

// Registro de Modrinth que corresponde a un archivo (sin ".disabled") de una carpeta.
function recordFor(projects, folder, file) {
  const base = file.replace(/\.disabled$/, '');
  for (const [pid, rec] of Object.entries(projects || {})) {
    if (rec?.file === base && (!rec.folder || normFolder(rec.folder) === folder)) return { ...rec, projectId: pid };
  }
  return null;
}

/**
 * Contenido de la instancia. folder:
 *   'mods' | 'resourcepacks' | 'shaderpacks' | 'saves/<mundo>/datapacks' -> archivos (con datos de Modrinth)
 *   'saves' -> mundos · 'screenshots' -> capturas · 'logs' -> registros y crash reports
 *   '@overview' -> tamanio y conteos · '@log:<logs|crash-reports>/<archivo>' -> texto de un registro
 */
async function content(id, folder) {
  if (folder === '@overview') return overview(id);
  if (typeof folder === 'string' && folder.startsWith('@log:')) return readLog(id, folder.slice(5));
  if (folder === 'saves') return listWorlds(id);
  if (folder === 'screenshots') return listScreenshots(id);
  if (folder === 'logs' || folder === 'crash-reports') return listLogs(id);
  const inst = await get(id);
  contentDir(id, folder);
  const norm = normFolder(folder);
  const files = await modrinth.listFolder(dir(id), norm);
  const projects = inst.modrinth?.projects || {};
  return files.map((f) => {
    const rec = recordFor(projects, norm, f.file);
    return { ...f, title: rec?.title || null, icon: rec?.icon || null, projectId: rec?.projectId || null, versionNumber: rec?.versionNumber || null };
  });
}

async function listWorlds(id) {
  const savesDir = path.join(dir(id), 'saves');
  let entries = [];
  try {
    entries = await fsp.readdir(savesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && validSegment(e.name))
      .map(async (e) => {
        const wdir = path.join(savesDir, e.name);
        const level = path.join(wdir, 'level.dat');
        const st = await fsp.stat(level).catch(() => null);
        if (!st) return null;
        let data = null;
        try {
          data = (await nbt.readFile(level))?.value?.Data || null;
        } catch {
          data = null;
        }
        const iconFile = path.join(wdir, 'icon.png');
        const iconSt = await fsp.stat(iconFile).catch(() => null);
        const packs = await fsp.readdir(path.join(wdir, 'datapacks'), { withFileTypes: true }).catch(() => []);
        const lastPlayed = data?.LastPlayed !== undefined ? Number(data.LastPlayed) : 0;
        const mode = Number(data?.GameType);
        return {
          name: e.name,
          folder: e.name,
          displayName: typeof data?.LevelName === 'string' && data.LevelName.trim() ? data.LevelName.trim() : e.name,
          lastPlayed: lastPlayed > 0 ? lastPlayed : st.mtimeMs,
          icon: iconSt ? iconFile : null,
          iconTime: iconSt ? Math.round(iconSt.mtimeMs) : 0,
          gameMode: Number.isInteger(mode) ? GAME_MODES[mode] || null : null,
          hardcore: Boolean(Number(data?.hardcore || 0)),
          cheats: Boolean(Number(data?.allowCommands || 0)),
          version: typeof data?.Version?.Name === 'string' ? data.Version.Name : null,
          datapacks: packs.filter((p) => p.isDirectory() || /\.zip(\.disabled)?$/i.test(p.name)).length,
        };
      }),
  );
  return out.filter(Boolean).sort((a, b) => b.lastPlayed - a.lastPlayed);
}

async function listScreenshots(id) {
  const base = path.join(dir(id), 'screenshots');
  let entries = [];
  try {
    entries = await fsp.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = await Promise.all(
    entries
      .filter((e) => e.isFile() && IMAGE_FILE.test(e.name))
      .map(async (e) => {
        const full = path.join(base, e.name);
        const st = await fsp.stat(full).catch(() => null);
        return st ? { file: e.name, path: full, size: st.size, mtime: st.mtimeMs } : null;
      }),
  );
  return out.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
}

async function listLogs(id) {
  const out = [];
  for (const folder of ['logs', 'crash-reports']) {
    const base = path.join(dir(id), folder);
    const entries = await fsp.readdir(base, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile() || !LOG_FILE.test(e.name)) continue;
      const st = await fsp.stat(path.join(base, e.name)).catch(() => null);
      if (!st) continue;
      out.push({ file: `${folder}/${e.name}`, name: e.name, folder, size: st.size, mtime: st.mtimeMs, crash: folder === 'crash-reports', gz: /\.gz$/i.test(e.name) });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Lee un registro (o crash report) mostrando como maximo los ultimos 512 KB.
async function readLog(id, rel) {
  const parts = normFolder(rel).split('/');
  if (parts.length !== 2 || !['logs', 'crash-reports'].includes(parts[0]) || !LOG_FILE.test(parts[1])) {
    throw new Error(t('instances.errNotLog'));
  }
  const full = entryPath(contentDir(id, parts[0]), parts[1]);
  const st = await fsp.stat(full).catch(() => null);
  if (!st || !st.isFile()) throw new Error(t('instances.errNotLog'));
  let buf;
  if (/\.gz$/i.test(full)) {
    buf = await gunzip(await fsp.readFile(full), { maxOutputLength: 64 * 1024 * 1024 });
  } else if (st.size > LOG_TAIL) {
    const fh = await fsp.open(full, 'r');
    try {
      buf = Buffer.alloc(LOG_TAIL);
      await fh.read(buf, 0, LOG_TAIL, st.size - LOG_TAIL);
    } finally {
      await fh.close();
    }
  } else {
    buf = await fsp.readFile(full);
  }
  let truncated = st.size > LOG_TAIL && !/\.gz$/i.test(full);
  if (buf.length > LOG_TAIL) {
    buf = buf.subarray(buf.length - LOG_TAIL);
    truncated = true;
  }
  let text = buf.toString('utf8');
  if (truncated) {
    const nl = text.indexOf('\n');
    if (nl >= 0 && nl < 4096) text = text.slice(nl + 1);
  }
  return { file: `${parts[0]}/${parts[1]}`, text, truncated, size: st.size, mtime: st.mtimeMs };
}

// Resumen para la pagina de la instancia: tamanio en disco (por carpeta) y cantidad de contenido.
async function overview(id) {
  const inst = await get(id);
  const base = dir(id);
  const sizes = { mods: 0, resourcepacks: 0, shaderpacks: 0, saves: 0, screenshots: 0, other: 0 };
  let total = 0;
  const top = await fsp.readdir(base, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    top.map(async (e) => {
      const p = path.join(base, e.name);
      let size = 0;
      if (e.isDirectory()) size = await dirSize(p);
      else if (e.isFile()) size = (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
      total += size;
      if (Object.prototype.hasOwnProperty.call(sizes, e.name)) sizes[e.name] += size;
      else sizes.other += size;
    }),
  );
  const read = (folder) => fsp.readdir(path.join(base, folder), { withFileTypes: true }).catch(() => []);
  const mods = await modrinth.listFolder(base, 'mods');
  const savesEntries = (await read('saves')).filter((e) => e.isDirectory());
  const worlds = (await Promise.all(savesEntries.map((e) => exists(path.join(base, 'saves', e.name, 'level.dat'))))).filter(Boolean).length;
  const packs = (entries) => entries.filter((e) => e.isDirectory() || /\.zip(\.disabled)?$/i.test(e.name)).length;
  const prepared = await readPrepared(id);
  return {
    size: total,
    sizes,
    counts: {
      mods: mods.length,
      modsDisabled: mods.filter((f) => !f.enabled).length,
      resourcepacks: packs(await read('resourcepacks')),
      shaderpacks: packs(await read('shaderpacks')),
      worlds,
      screenshots: (await read('screenshots')).filter((e) => e.isFile() && IMAGE_FILE.test(e.name)).length,
    },
    prepared: prepared
      ? { verifiedAt: prepared.verifiedAt, versionId: prepared.versionId, fresh: preparedFresh(prepared, inst.versionId) }
      : null,
    versionId: inst.versionId || null,
  };
}

// Windows no deja borrar, renombrar ni reemplazar un archivo abierto. Si el archivo tiene enlaces duros
// (el modulo storage unifica los .jar/.zip repetidos), puede estar abierto desde OTRA instancia que comparte
// el mismo contenido: el mensaje lo explica. Otros errores pasan tal cual.
async function lockedError(err, file) {
  if (!LOCK_CODES.has(err?.code)) return err;
  const shared = await safety.isSharedFile(file);
  const key = shared ? 'instances.errSharedBusy' : 'instances.errFileBusy';
  return Object.assign(new Error(t(key, { name: path.basename(file) })), { code: err.code, shared, cause: err });
}

async function toggleFile(id, folder, file) {
  const base = contentDir(id, folder);
  const from = entryPath(base, file);
  const name = path.basename(from);
  const to = name.endsWith('.disabled') ? path.join(base, name.slice(0, -9)) : `${from}.disabled`;
  if (!(await exists(from))) throw new Error(t('instances.errMissingFile', { name }));
  if (await exists(to)) throw new Error(t('instances.errExists', { name: path.basename(to) }));
  try {
    await fsp.rename(from, to);
  } catch (err) {
    throw await lockedError(err, from);
  }
  return path.basename(to);
}

async function deleteFile(id, folder, file) {
  const base = contentDir(id, folder);
  const target = entryPath(base, file);
  if (!(await exists(target))) return false;
  const norm = normFolder(folder);
  const precious = norm === 'saves' || norm === 'screenshots';
  try {
    await trash(target, { hard: !precious || !trashFn });
  } catch (err) {
    throw await lockedError(err, target);
  }
  if (norm !== 'saves' && norm !== 'screenshots' && norm !== 'logs' && norm !== 'crash-reports') {
    const name = path.basename(target).replace(/\.disabled$/, '');
    // Se olvida el registro de Modrinth o CurseForge que apuntaba a ese archivo.
    await update(id, (inst) => {
      const patch = {};
      for (const src of RECORD_SOURCES) {
        const projects = { ...(inst[src]?.projects || {}) };
        let changed = false;
        for (const [pid, rec] of Object.entries(projects)) {
          if (rec?.file === name && (!rec.folder || normFolder(rec.folder) === norm)) {
            delete projects[pid];
            changed = true;
          }
        }
        if (changed) patch[src] = { ...inst[src], projects };
      }
      return Object.keys(patch).length ? patch : null;
    });
  }
  return true;
}

// Ruta libre dentro de base: "Nombre", "Nombre (2)", "Nombre (3)"...
async function uniquePath(base, name) {
  const clean = sanitizeFileName(name);
  let candidate = path.join(base, clean);
  let n = 2;
  while (await exists(candidate)) candidate = path.join(base, `${clean} (${n++})`);
  return candidate;
}

// Importa un mundo (carpeta con level.dat o .zip que lo contenga) a saves/.
async function importWorld(savesDir, src, st) {
  const label = path.basename(src);
  if (st.isDirectory()) {
    if (!(await exists(path.join(src, 'level.dat')))) throw new Error(t('instances.errNotWorld', { name: label }));
    const dest = await uniquePath(savesDir, label);
    await copyTree(src, dest);
    return path.basename(dest);
  }
  if (!/\.zip$/i.test(src)) throw new Error(t('instances.errNotWorld', { name: label }));
  let zip;
  try {
    zip = new AdmZip(src);
  } catch {
    throw new Error(t('instances.errNotWorld', { name: label }));
  }
  const entries = zip.getEntries();
  const levels = entries
    .filter((e) => !e.isDirectory && /(^|\/)level\.dat$/.test(e.entryName.replace(/\\/g, '/')))
    .sort((a, b) => a.entryName.split('/').length - b.entryName.split('/').length);
  if (!levels.length) throw new Error(t('instances.errNotWorld', { name: label }));
  const prefix = levels[0].entryName.replace(/\\/g, '/').slice(0, -'level.dat'.length);
  const folderName = prefix ? prefix.replace(/\/$/, '').split('/').pop() : path.basename(src, path.extname(src));
  const dest = await uniquePath(savesDir, folderName);
  const root = path.resolve(dest);
  await fsp.mkdir(root, { recursive: true });
  for (const e of entries) {
    const name = e.entryName.replace(/\\/g, '/');
    if (e.isDirectory || !name.startsWith(prefix)) continue;
    // Rutas absolutas, con '..', unidades o nombres de dispositivo: se saltean (zip slip).
    const out = safety.resolveInside(root, name.slice(prefix.length), { instance: false });
    if (!out) continue;
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, e.getData()); // carpeta nueva (uniquePath): no hay archivos previos que pisar
  }
  return path.basename(dest);
}

// Agrega archivos locales (arrastrados o elegidos) a una carpeta de la instancia.
// En 'saves' importa mundos (carpetas o .zip). Devuelve los nombres agregados.
async function addFiles(id, folder, filePaths) {
  const base = contentDir(id, folder);
  const norm = normFolder(folder);
  if (!WRITABLE_FOLDERS.includes(norm) && !norm.endsWith('/datapacks')) throw new Error(t('instances.errReadOnly'));
  await fsp.mkdir(base, { recursive: true });
  const added = [];
  const errors = [];
  for (const src of Array.isArray(filePaths) ? filePaths : []) {
    if (typeof src !== 'string' || !path.isAbsolute(src)) continue;
    const full = path.resolve(src);
    if (base === full || base.startsWith(full + path.sep)) continue; // nunca copiar una carpeta dentro de si misma
    const name = path.basename(full);
    try {
      const st = await fsp.stat(full).catch(() => null);
      if (!st) throw new Error(t('instances.errMissingFile', { name }));
      if (norm === 'saves') {
        added.push(await importWorld(base, full, st));
        continue;
      }
      if (st.isDirectory()) {
        if (norm === 'mods') throw new Error(t('instances.errNotMod', { name }));
        if (norm === 'screenshots') throw new Error(t('instances.errNotImage', { name }));
        const dest = await uniquePath(base, name);
        await copyTree(full, dest);
        added.push(path.basename(dest));
      } else if (st.isFile()) {
        if (norm === 'mods' && !MOD_FILE.test(name)) throw new Error(t('instances.errNotMod', { name }));
        if (norm === 'screenshots' && !IMAGE_FILE.test(name)) throw new Error(t('instances.errNotImage', { name }));
        if (path.dirname(full) === base) continue;
        // Si ya hay un archivo con ese nombre se reemplaza (temporal + renombrado), nunca se le escribe
        // encima: puede ser un enlace duro del almacen compartido con otras instancias.
        const dest = path.join(base, name);
        try {
          await safety.copyFileAtomic(full, dest);
        } catch (err) {
          throw await lockedError(err, dest);
        }
        added.push(name);
      }
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length) {
    throw new Error(errors.length === 1 ? errors[0].message : t('instances.errSomeFiles', { count: errors.length, error: errors[0].message }));
  }
  return added;
}

module.exports = {
  setTrash,
  list,
  get,
  create,
  update,
  remove,
  duplicate,
  prepare,
  installProject,
  content,
  toggleFile,
  deleteFile,
  addFiles,
  dir,
  contentDir,
  readPrepared,
  clearPrepared,
  preparedFresh,
  IRIS_ID,
  LOADER_KINDS,
  LOADER_NAMES,
  PREPARED_MAX_AGE,
};
