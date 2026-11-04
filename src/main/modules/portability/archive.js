'use strict';
// Exportar e importar un .venusbackup, sin Electron (pruebas en test/archive.test.js, con una carpeta de datos temporal).
//   buildPlan(seleccion, deps)      -> { files, manifest, sizes }: que entraria, sin escribir nada
//   writeBackup(plan, destino, ...) -> ZIP por streaming con ZIP64 (worlds/zip): un "todo" pasa facil de 4 GB
//   inspect(archivo, carpetaTemp)   -> { manifest, valid }: valida el manifiesto y cada ruta antes de tocar nada
//   importBackup(archivo, opciones) -> lo extrae a una carpeta temporal y recien al final lo mueve a su lugar
// Nunca pisa: lo que ya existe queda como esta y lo nuevo entra con otro nombre. Nunca ejecuta nada del archivo.
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const paths = require('../../core/paths');
const { exists, uid, writeJson, rmrf } = require('../../core/util');
const zip = require('../worlds/zip');
const media = require('../worlds/media');
const level = require('../worlds/level');
const filter = require('./filter');
const { BackupError, FORMAT, VERSION, MAX_MANIFEST, validateManifest, validateEntries } = require('./manifest');

const STAGING = () => path.join(paths.root(), 'portability');
const CATEGORIES = ['instances', 'worlds', 'servers', 'settings', 'media'];
const SAFETY_MARGIN = 1.02;

const asBuffer = (v) => Buffer.from(JSON.stringify(v, null, 2), 'utf8');
const sumOf = (list) => list.reduce((a, f) => a + f.size, 0);

function normalizeSelection(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const c of CATEGORIES) out[c] = r[c] === true;
  out.instanceIds = Array.isArray(r.instanceIds) ? r.instanceIds.filter((x) => typeof x === 'string') : null;
  out.serverIds = Array.isArray(r.serverIds) ? r.serverIds.filter((x) => typeof x === 'string') : null;
  return out;
}

// Lo que va a entrar. deps: { instances, servers, settings, appVersion, signal }
async function buildPlan(selection, { instances, servers, settings, appVersion = '', signal } = {}) {
  const sel = normalizeSelection(selection);
  const files = [];
  const add = (rel, f) => files.push({ ...f, rel });
  const manifest = { format: FORMAT, version: VERSION, createdAt: Date.now(), appVersion, categories: CATEGORIES.filter((c) => sel[c]), instances: [], servers: [], settings: false };
  const sizes = { instances: 0, worlds: 0, servers: 0, settings: 0, media: 0 };

  if (sel.instances || sel.worlds || sel.media) {
    let n = 0;
    for (const inst of await instances.list()) {
      if (sel.instanceIds && !sel.instanceIds.includes(inst.id)) continue;
      const key = `i${++n}`;
      const base = `instances/${key}`;
      const item = { key, originalId: inst.id, name: inst.name, mcVersion: inst.mcVersion, loader: inst.loader, content: { files: 0, bytes: 0 }, worlds: [], media: { files: 0, bytes: 0 } };
      if (sel.instances) {
        const list = await zip.walk(inst.dir, { exclude: (rel, isDir) => !filter.keepInstanceFile(rel, isDir), signal });
        for (const f of list) add(`${base}/files/${f.rel}`, f);
        item.content = { files: list.length, bytes: sumOf(list) };
        sizes.instances += item.content.bytes;
      }
      if (sel.worlds) {
        for (const folder of await level.folders(inst.dir).catch(() => [])) {
          const list = await zip.walk(path.join(inst.dir, 'saves', folder), { exclude: (rel, isDir) => !filter.keepWorldFile(rel, isDir), signal });
          if (!list.length) continue;
          for (const f of list) add(`${base}/saves/${folder}/${f.rel}`, f);
          const bytes = sumOf(list);
          item.worlds.push({ folder, files: list.length, bytes });
          sizes.worlds += bytes;
        }
      }
      if (sel.media) {
        const items = [...(await media.screenshots(inst).catch(() => [])), ...(await media.clips(inst).catch(() => []))];
        for (const it of items) add(`${base}/media/${it.rel}`, { abs: it.path, size: it.size, mtime: it.mtime });
        item.media = { files: items.length, bytes: items.reduce((a, b) => a + b.size, 0) };
        sizes.media += item.media.bytes;
      }
      if (!item.content.files && !item.worlds.length && !item.media.files) {
        n--;
        continue;
      }
      add(`${base}/meta.json`, { data: asBuffer(filter.instanceMeta(inst)) });
      manifest.instances.push(item);
    }
  }

  if (sel.servers) {
    let n = 0;
    for (const s of await servers.list()) {
      if (sel.serverIds && !sel.serverIds.includes(s.id)) continue;
      const key = `s${++n}`;
      const list = await zip.walk(s.dir, { exclude: (rel, isDir) => !filter.keepServerFile(rel, isDir), signal });
      for (const f of list) add(`servers/${key}/files/${f.rel}`, f);
      add(`servers/${key}/meta.json`, { data: asBuffer(filter.serverMeta(s)) });
      const bytes = sumOf(list);
      manifest.servers.push({ key, name: s.name, type: s.type, mcVersion: s.mcVersion, content: { files: list.length, bytes } });
      sizes.servers += bytes;
    }
  }

  if (sel.settings) {
    const data = asBuffer(filter.cleanSettings(await settings.get()));
    add('settings/settings.json', { data });
    manifest.settings = true;
    sizes.settings = data.length;
  }

  files.unshift({ rel: 'manifest.json', data: asBuffer(manifest) });
  return { files, manifest, sizes, total: Object.values(sizes).reduce((a, b) => a + b, 0) };
}

// Carpetas de esta PC que no pueden quedar escritas en ninguna configuracion
const localRoots = () => [paths.root(), os.homedir()];

async function writeBackup(plan, dest, { signal, onProgress } = {}) {
  const roots = localRoots();
  return zip.zipFiles(plan.files, dest, {
    signal,
    onProgress,
    transform: (f, data) => (f.abs ? filter.redactSecrets(f.rel, filter.scrubText(f.rel, data, roots)) : data),
  });
}

// ---------- Importar ----------

async function readSmallEntry(file, entries, name, tempDir, maxBytes) {
  const e = entries.find((x) => x.name === name);
  if (!e) return null;
  if (e.size > maxBytes) throw new BackupError('tooBig', name);
  const dir = path.join(tempDir, uid(8));
  try {
    await zip.extract(file, dir, { entries: [e] });
    return JSON.parse(await fsp.readFile(path.join(dir, ...name.split('/')), 'utf8'));
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError('badManifest', err?.message);
  } finally {
    await rmrf(dir).catch(() => {});
  }
}

// Valida todo antes de escribir nada fuera de la carpeta temporal.
async function inspect(file, { tempDir = STAGING() } = {}) {
  let entries;
  try {
    entries = await zip.readEntries(file);
  } catch {
    throw new BackupError('badFile');
  }
  await fsp.mkdir(tempDir, { recursive: true });
  const raw = await readSmallEntry(file, entries, 'manifest.json', tempDir, MAX_MANIFEST);
  if (!raw) throw new BackupError('notBackup');
  const manifest = validateManifest(raw);
  const valid = validateEntries(entries, manifest);
  return { manifest, valid, entries };
}

const uniqueIn = async (dir, name) => {
  let target = name;
  let n = 2;
  while (await exists(path.join(dir, target))) target = `${name} (${n++})`;
  return target;
};

function uniqueName(name, taken) {
  const low = new Set([...taken].map((x) => String(x).toLowerCase()));
  const base = String(name || '').slice(0, 54) || 'Venus';
  let out = base;
  let n = 2;
  while (low.has(out.toLowerCase())) out = `${base} (${n++})`;
  return out;
}

// Mueve el contenido de una carpeta a otra. Nunca pisa: si ya existe, entra con otro nombre.
async function moveContents(from, to) {
  await fsp.mkdir(to, { recursive: true });
  for (const name of await fsp.readdir(from).catch(() => [])) {
    const src = path.join(from, name);
    const target = path.join(to, name);
    const st = await fsp.stat(src);
    if (st.isDirectory() && (await exists(target))) {
      await moveContents(src, target);
      continue;
    }
    if (await exists(target)) {
      const ext = path.extname(name);
      await fsp.rename(src, path.join(to, await uniqueFile(to, name.slice(0, name.length - ext.length), ext)));
    } else await fsp.rename(src, target);
  }
}

async function uniqueFile(dir, base, ext) {
  let n = 2;
  while (await exists(path.join(dir, `${base} (${n})${ext}`))) n++;
  return `${base} (${n})${ext}`;
}

function serverSlug(name) {
  const slug = String(name || 'servidor').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40);
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(slug) || !slug ? 'servidor' : slug;
}

// Que va a pasar con cada cosa en esta PC: nombres que se repiten y espacio.
function describe(manifest, { existingInstances = [], existingServers = [] } = {}) {
  const namesI = new Set(existingInstances.map((i) => i.name));
  const namesS = new Set(existingServers.map((s) => s.name));
  const instances = manifest.instances.map((i) => {
    const name = uniqueName(i.name, namesI);
    namesI.add(name);
    const match = existingInstances.find((e) => e.id === i.originalId && e.mcVersion === i.mcVersion) || existingInstances.find((e) => e.name === i.name && e.mcVersion === i.mcVersion) || null;
    return { ...i, finalName: name, renamed: name !== i.name, matchId: match?.id || null, matchName: match?.name || null };
  });
  const servers = manifest.servers.map((s) => {
    const name = uniqueName(s.name, namesS);
    namesS.add(name);
    return { ...s, finalName: name, renamed: name !== s.name };
  });
  return { instances, servers };
}

// Bytes de las entradas validadas que se extraerán, incluidos metadatos y ajustes. Los contadores del manifiesto
// son informativos: no alcanzan para comprobar el espacio disponible.
function neededBytes(manifest, options, list) {
  const areas = new Map();
  for (const i of manifest.instances) {
    const selected = new Set();
    if (options.instances && i.content.files > 0) selected.add('files');
    if (options.worlds && i.worlds.length > 0) selected.add('saves');
    if (options.media && i.media.files > 0) selected.add('media');
    if (selected.size) selected.add('meta');
    areas.set(`instance/${i.key}`, selected);
  }
  if (options.servers) for (const s of manifest.servers) areas.set(`server/${s.key}`, new Set(['meta', 'files']));
  return list.reduce((total, { entry, info }) => {
    const selected = info.area === 'settings' ? options.settings && manifest.settings : areas.get(`${info.kind}/${info.key}`)?.has(info.area);
    return total + (selected ? entry.size : 0);
  }, 0);
}

async function freeBytes(dir) {
  try {
    const st = await fsp.statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null; // sin el dato no se frena a nadie: se avisa al fallar
  }
}

/**
 * options: { instances, worlds, servers, settings, media }.
 * deps: { instances, servers, settings, game, signal, onProgress({ bytes, total }), onBeforeSettings(actuales) }
 */
async function importBackup(file, rawOptions, deps) {
  const { instances, servers, settings, game, signal, onProgress } = deps;
  const options = normalizeSelection(rawOptions);
  const staging = path.join(STAGING(), `staging-${Date.now()}-${uid(6)}`);
  await fsp.mkdir(staging, { recursive: true });
  const result = { instances: [], worlds: [], servers: [], media: 0, settings: false, skipped: [] };
  try {
    const { manifest, valid, entries } = await inspect(file, { tempDir: staging });
    const free = await freeBytes(paths.root());
    const needed = neededBytes(manifest, options, valid.list);
    if (free !== null && needed * SAFETY_MARGIN > free) throw Object.assign(new BackupError('noSpace'), { needed, free });

    const byKey = new Map();
    for (const { entry, info } of valid.list) {
      if (!info.key) continue;
      const k = `${info.kind}/${info.key}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push({ entry, info });
    }

    // 1) Todo a la carpeta temporal: cancelar o fallar acá no deja nada a medias en la PC.
    let done = 0;
    const report = (bytes) => onProgress?.({ bytes: done + bytes, total: needed });
    const extractPart = async (kind, key, wants, into) => {
      const list = (byKey.get(`${kind}/${key}`) || []).filter((x) => wants(x.info));
      if (!list.length) return 0;
      const prefix = `${kind === 'instance' ? 'instances' : 'servers'}/${key}/`;
      const res = await zip.extract(file, into, { prefix, entries: list.map((x) => x.entry), signal, onProgress: ({ bytes }) => report(bytes) });
      done += res.bytes;
      return res.files;
    };

    const prepared = [];
    for (const item of manifest.instances) {
      const wantsFiles = options.instances && item.content.files > 0;
      const wantsWorlds = options.worlds && item.worlds.length > 0;
      const wantsMedia = options.media && item.media.files > 0;
      if (!wantsFiles && !wantsWorlds && !wantsMedia) continue;
      const dir = path.join(staging, item.key);
      await extractPart('instance', item.key, (i) => i.area === 'meta' || (i.area === 'files' && wantsFiles) || (i.area === 'saves' && wantsWorlds) || (i.area === 'media' && wantsMedia), dir);
      prepared.push({ item, dir, wantsFiles, wantsWorlds, wantsMedia });
    }
    const preparedServers = [];
    if (options.servers) {
      for (const item of manifest.servers) {
        const dir = path.join(staging, item.key);
        await extractPart('server', item.key, (i) => i.area === 'meta' || i.area === 'files', dir);
        preparedServers.push({ item, dir });
      }
    }
    let newSettings = null;
    if (options.settings && manifest.settings) newSettings = await readSmallEntry(file, entries, 'settings/settings.json', staging, 32 * 1024 * 1024);

    // 2) A su lugar: son renombres en el mismo disco.
    const allInstances = await instances.list();
    const placed = describe(manifest, { existingInstances: allInstances, existingServers: await servers.list() });
    for (const { item, dir, wantsFiles, wantsWorlds, wantsMedia } of prepared) {
      signal?.throwIfAborted?.();
      const meta = filter.instanceMeta(JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8').catch(() => '{}')));
      const info = placed.instances.find((x) => x.key === item.key);
      let target = null;
      if (!wantsFiles && info.matchId) target = allInstances.find((x) => x.id === info.matchId);
      let created = false;
      if (!target) {
        try {
          target = await instances.create({ name: info.finalName, mcVersion: meta.mcVersion, loader: meta.loader, loaderVersion: meta.loaderVersion, preset: meta.preset, icon: meta.icon, group: meta.group });
          created = true;
        } catch (err) {
          result.skipped.push({ name: item.name, reason: err?.message || String(err) });
          continue;
        }
      } else if (game?.status?.()[target.id]) {
        result.skipped.push({ name: item.name, reason: 'gameRunning' });
        continue;
      }
      try {
        const filesDir = path.join(dir, 'files');
        if (wantsFiles && (await exists(filesDir))) await moveContents(filesDir, target.dir);
        if (wantsWorlds) {
          const saves = path.join(target.dir, 'saves');
          await fsp.mkdir(saves, { recursive: true });
          for (const w of item.worlds) {
            const src = path.join(dir, 'saves', w.folder);
            if (!(await exists(src))) continue;
            const folder = await uniqueIn(saves, w.folder);
            await fsp.rename(src, path.join(saves, folder));
            result.worlds.push({ instanceId: target.id, folder, renamedFrom: folder !== w.folder ? w.folder : null });
          }
        }
        if (wantsMedia && (await exists(path.join(dir, 'media')))) {
          await moveContents(path.join(dir, 'media'), target.dir);
          result.media += item.media.files;
        }
        if (created) {
          const { name: _n, mcVersion: _m, loader: _l, loaderVersion: _lv, preset: _p, icon: _i, group: _g, ...rest } = meta;
          // Sin java.path ni argumentos: instanceMeta no los deja pasar. Queda sin instalar, como una instancia nueva.
          // Lo que no vino no se escribe como null: la instancia nueva se queda con su valor por defecto.
          const patch = wantsFiles ? rest : { created: rest.created, tags: rest.tags, notes: rest.notes, favorite: rest.favorite };
          await instances.update(target.id, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null)));
          result.instances.push({ id: target.id, name: info.finalName, renamedFrom: info.renamed ? item.name : null });
        }
      } catch (err) {
        // Una instancia nueva a medias no queda en la lista
        if (created) await instances.remove(target.id).catch(() => {});
        throw err;
      }
    }
    for (const { item, dir } of preparedServers) {
      signal?.throwIfAborted?.();
      const meta = filter.serverMeta(JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8').catch(() => '{}')));
      if (!meta.type || !meta.mcVersion || (servers.types && !servers.types().some((x) => x.id === meta.type))) {
        result.skipped.push({ name: item.name, reason: 'badServer' });
        continue;
      }
      const info = placed.servers.find((x) => x.key === item.key);
      const base = serverSlug(info.finalName);
      let id = base;
      while (await exists(paths.server(id))) id = `${base}-${uid(4)}`;
      const destDir = paths.server(id);
      await fsp.mkdir(destDir, { recursive: true });
      if (await exists(path.join(dir, 'files'))) await moveContents(path.join(dir, 'files'), destDir);
      const taken = (await servers.list()).map((s) => s.port);
      // Sin instalar: el launcher baja el .jar de su fuente la primera vez. Sin Java propio, flags ni automatizaciones.
      await writeJson(path.join(destDir, filter.META_SERVER), {
        id,
        name: info.finalName,
        type: meta.type,
        mcVersion: meta.mcVersion,
        loaderVersion: meta.loaderVersion,
        port: meta.port,
        memory: meta.memory || { min: 1024, max: 2048 },
        flags: 'aikar',
        java: { path: '', args: '' },
        automation: { autoRestart: false, autostart: false, restart: { mode: 'off', hours: 6, time: '05:00' }, backup: { mode: 'off', hours: 6, time: '04:00', keep: 5 } },
        created: meta.created || Date.now(),
        installed: false,
        launch: null,
        mirror: null,
        notes: meta.notes,
      });
      if (taken.includes(meta.port) && servers.suggestPort) await servers.update(id, { port: await servers.suggestPort(meta.type) }).catch(() => {});
      result.servers.push({ id, name: info.finalName, renamedFrom: info.renamed ? item.name : null });
    }

    if (newSettings) {
      // Lo de antes queda al lado, por si no era lo que se queria
      const clean = filter.cleanSettings(newSettings);
      await writeJson(paths.data(`settings-before-import-${Date.now()}.json`), await settings.get());
      await settings.set(clean);
      result.settings = true;
    }
    return result;
  } finally {
    await rmrf(staging).catch(() => {});
  }
}

// Temporales de una importacion que se corto de golpe
async function cleanStaging() {
  for (const name of await fsp.readdir(STAGING()).catch(() => [])) {
    if (name.startsWith('staging-')) await rmrf(path.join(STAGING(), name)).catch(() => {});
  }
}

module.exports = { CATEGORIES, normalizeSelection, buildPlan, writeBackup, inspect, describe, neededBytes, freeBytes, importBackup, cleanStaging, uniqueName, STAGING };
