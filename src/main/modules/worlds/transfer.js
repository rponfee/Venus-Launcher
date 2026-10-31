'use strict';
// Operaciones sobre la carpeta de un mundo: copiar a otra instancia o a un servidor local, renombrar
// (LevelName del level.dat con escritura NBT con tipos) y mandar a la papelera.
const fsp = require('fs/promises');
const path = require('path');
const nbt = require('../../core/nbt');
const { exists, sanitizeFileName, dirSize, offlineUUID, dashUUID } = require('../../core/util');
const { t } = require('../../core/i18n');
const { walk } = require('./zip');

const mb = (n) => (n / 1048576).toFixed(n >= 1048576 * 100 ? 0 : 1);

// Carpeta libre dentro de base: "Nombre", "Nombre (2)", "Nombre (3)"...
async function uniqueDir(base, name) {
  const clean = sanitizeFileName(name);
  let candidate = path.join(base, clean);
  let n = 2;
  while (await exists(candidate)) candidate = path.join(base, `${clean} (${n++})`);
  return candidate;
}

// Copia recursiva con progreso. Omite session.lock y archivos bloqueados.
async function copyTree(src, dest, { task, signal, exclude } = {}) {
  const files = await walk(src, { exclude: (rel, isDir) => /(^|\/)session\.lock$/i.test(rel) || (exclude ? exclude(rel, isDir) : false), signal });
  const total = files.reduce((a, f) => a + f.size, 0);
  let done = 0;
  let skipped = 0;
  let last = 0;
  await fsp.mkdir(dest, { recursive: true });
  for (const f of files) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    const target = path.join(dest, ...f.rel.split('/'));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
      await fsp.copyFile(f.abs, target);
    } catch (err) {
      if (['EBUSY', 'EPERM', 'EACCES', 'ENOENT'].includes(err.code)) {
        skipped++;
        continue;
      }
      throw err;
    }
    done += f.size;
    const now = Date.now();
    if (task && total && now - last > 200) {
      last = now;
      task.update({ detail: t('worlds.detailCopying', { done: mb(done), total: mb(total) }), progress: done / total });
    }
  }
  return { files: files.length - skipped, bytes: done, skipped };
}

// Cambia el LevelName (nombre visible del mundo) escribiendo el level.dat con tipos.
async function setLevelName(worldDir, name) {
  const file = path.join(worldDir, 'level.dat');
  const buf = await fsp.readFile(file);
  let root;
  try {
    root = nbt.readTyped(buf);
  } catch {
    throw new Error(t('worlds.errLevelDat'));
  }
  const data = root.value?.Data;
  if (!data || data.type !== nbt.TAG.Compound) throw new Error(t('worlds.errLevelDat'));
  data.value.LevelName = nbt.T.string(name);
  const gz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const out = nbt.write(root, { gzip: gz || !(buf[0] === 0x0a) });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, out);
  // El juego deja la version anterior en level.dat_old: se hace lo mismo
  await fsp.copyFile(file, `${file}_old`).catch(() => {});
  await fsp.rename(tmp, file);
}

// Datos del jugador del level.dat (mundo de un jugador) -> compuesto para playerdata/<uuid>.dat
async function hostPlayerTag(worldDir) {
  try {
    const root = nbt.readTyped(await fsp.readFile(path.join(worldDir, 'level.dat')));
    const player = root.value?.Data?.value?.Player;
    return player && player.type === nbt.TAG.Compound ? player : null;
  } catch {
    return null;
  }
}

/**
 * Copia un mundo a la carpeta saves de otra instancia (o de la misma, como duplicado).
 * Devuelve { folder } del mundo nuevo.
 */
async function toInstance(srcDir, targetInst, { name, task } = {}) {
  const saves = path.join(targetInst.dir, 'saves');
  await fsp.mkdir(saves, { recursive: true });
  const dest = await uniqueDir(saves, name || path.basename(srcDir));
  const res = await copyTree(srcDir, dest, { task, signal: task?.signal }).catch(async (err) => {
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
    throw err;
  });
  return { folder: path.basename(dest), skipped: res.skipped };
}

// Carpetas del mundo de un servidor (nivel principal + las del Nether y el End de Bukkit/Paper)
function serverWorldDirs(serverDir, level) {
  return [path.join(serverDir, level), path.join(serverDir, `${level}_nether`), path.join(serverDir, `${level}_the_end`)];
}

/**
 * Copia un mundo a un servidor local (como su mundo principal, segun level-name).
 * opts: { replace, trash, account: { name, uuid, type }, onlineMode, task }
 * Con la cuenta del jugador se escribe playerdata/<uuid>.dat con el inventario y la posicion del
 * mundo de un jugador (en un servidor el level.dat no guarda al jugador).
 */
async function toServer(srcDir, server, props, { replace = false, trash, account, task } = {}) {
  const level = String(props?.['level-name'] || 'world').trim() || 'world';
  if (/[\\/]|^\.\.?$/.test(level)) throw new Error(t('worlds.errServerLevel'));
  const dirs = serverWorldDirs(server.dir, level);
  const present = [];
  for (const d of dirs) if (await exists(d)) present.push(d);
  if (present.length && !replace) throw Object.assign(new Error(t('worlds.errServerExists')), { code: 'exists' });
  for (const d of present) {
    let moved = false;
    if (trash) {
      try {
        await trash(d);
        moved = true;
      } catch {
        moved = false;
      }
    }
    if (!moved) throw new Error(t('worlds.errTrash', { name: path.basename(d) }));
  }
  const dest = dirs[0];
  const res = await copyTree(srcDir, dest, { task, signal: task?.signal });
  let player = false;
  if (account?.name || account?.uuid) {
    const tag = await hostPlayerTag(srcDir);
    if (tag) {
      const online = String(props?.['online-mode'] ?? 'true') !== 'false';
      const raw = online && account.type === 'msa' && account.uuid ? account.uuid : offlineUUID(account.name || '');
      if (raw) {
        const file = path.join(dest, 'playerdata', `${dashUUID(String(raw).replace(/-/g, ''))}.dat`);
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, nbt.write({ name: '', value: tag.value }, { gzip: true }));
        player = true;
      }
    }
  }
  return { level, skipped: res.skipped, player };
}

module.exports = { uniqueDir, copyTree, setLevelName, hostPlayerTag, toInstance, toServer, serverWorldDirs, dirSize };
