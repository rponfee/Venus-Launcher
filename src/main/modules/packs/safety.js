'use strict';
// Reglas compartidas para escribir archivos que vienen de afuera (modpacks .mrpack, zips de CurseForge y
// Prism/MultiMC, manifiestos compartidos, la nube, extensiones, copias de mundos) y para reemplazar
// archivos de contenido sin romper los enlaces duros. Las usan core/modrinth, core/instances y varios modulos.
// Sin Electron ni otros modulos del launcher (se puede probar con Node puro).
//
//  - safeRelPath(ruta): ruta relativa segura ('a/b/c') o null. Rechaza rutas absolutas, '..', unidades de
//    Windows (C:), rutas UNC (\\servidor\recurso), caracteres prohibidos, nombres de dispositivo (CON, NUL...)
//    y nombres que Windows recorta ('x.' o 'x '). Dentro de una instancia (opcion instance, por defecto)
//    tambien rechaza los archivos internos del launcher: venus-instance.json y .venus/ (y sus alias cortos 8.3
//    como VENUS-~1.JSO). Un pack malicioso podria cambiar java.path o el Java del arranque rapido y ejecutar
//    un programa al jugar.
//  - allowedPackUrls(urls): solo https y los dominios que permite el formato .mrpack de Modrinth.
//  - writeFileAtomic / copyFileAtomic / replaceFile / moveFile: nunca escriben encima de un archivo existente.
//    El modulo storage unifica los .jar/.zip repetidos con enlaces duros (y las instantaneas tambien los
//    enlazan): abrir el archivo existente y escribirle encima lo cambiaria en TODAS las instancias que lo
//    comparten. Se escribe un temporal en la misma carpeta y se renombra encima: el renombrado reemplaza solo
//    esta entrada y las demas copias quedan como estaban.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// Dominios desde los que un .mrpack puede bajar archivos (formato de Modrinth).
const PACK_HOSTS = Object.freeze(['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']);
const PACK_HOST_SET = new Set(PACK_HOSTS);
// Archivos internos del launcher en la raiz de una instancia (comparados en mayusculas, como hace NTFS).
const INSTANCE_RESERVED = new Set(['VENUS-INSTANCE.JSON', '.VENUS']);
const BAD_CHARS = /[\x00-\x1f\x7f<>:"|?*\\/]/;
const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
const SHORT_NAME = /~\d/; // alias 8.3 de Windows (VENUS~1, VENUS-~1.JSO)
const LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

// Un nombre de archivo o carpeta valido en cualquier sistema (sin separadores). Windows recorta los puntos
// y espacios del final ('venus-instance.json.' es venus-instance.json): esos nombres no se aceptan.
function validSegment(s) {
  return (
    typeof s === 'string' &&
    s.length > 0 &&
    s.length <= 255 &&
    s !== '.' &&
    s !== '..' &&
    !/[. ]$/.test(s) &&
    !BAD_CHARS.test(s) &&
    !DEVICE_NAME.test(s)
  );
}

// ¿Es (o puede ser un alias de) un archivo interno del launcher en la raiz de la instancia?
function isReservedTop(first) {
  if (typeof first !== 'string') return true;
  // toUpperCase cubre ademas los trucos que NTFS considera iguales ('ı' -> 'I', 'ſ' -> 'S').
  if (INSTANCE_RESERVED.has(first.toUpperCase())) return true;
  return SHORT_NAME.test(first);
}

/**
 * Ruta relativa segura ('mods/x.jar') o null. Acepta '\' como separador (zips hechos en Windows) y
 * descarta los './' del principio. opts: { instance: true (rechaza venus-instance.json y .venus/), maxLength, maxDepth }
 */
function safeRelPath(rel, { instance = true, maxLength = 1024, maxDepth = 64 } = {}) {
  if (typeof rel !== 'string' || !rel || rel.length > maxLength) return null;
  let r = rel.replace(/\\/g, '/');
  if (r.startsWith('/') || /^[a-zA-Z]:/.test(r)) return null; // absoluta, unidad o UNC (//servidor)
  r = r.replace(/^(?:\.\/)+/, '');
  if (!r) return null;
  const parts = r.split('/');
  if (parts.length > maxDepth || !parts.every(validSegment)) return null;
  if (instance && isReservedTop(parts[0])) return null;
  return parts.join('/');
}

function isInside(base, full) {
  return full.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

// Ruta absoluta dentro de baseDir para una ruta relativa que viene de afuera (o null si no es segura).
function resolveInside(baseDir, rel, opts) {
  const clean = safeRelPath(rel, opts);
  if (!clean) return null;
  const base = path.resolve(baseDir);
  const full = path.resolve(base, ...clean.split('/'));
  return isInside(base, full) ? full : null;
}

// ---------- Descargas de un .mrpack ----------

function isAllowedPackUrl(u) {
  if (typeof u !== 'string' || u.length > 2048) return false;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && PACK_HOST_SET.has(url.hostname.toLowerCase()) && !url.username && !url.password && (!url.port || url.port === '443');
  } catch {
    return false;
  }
}

// URLs permitidas de la lista (normalizadas). Las demas se descartan.
function allowedPackUrls(list) {
  const out = [];
  for (const u of Array.isArray(list) ? list : []) if (isAllowedPackUrl(u)) out.push(new URL(u).href);
  return out;
}

// Dominio de la primera URL legible (para avisos).
function firstHost(list) {
  for (const u of Array.isArray(list) ? list : []) {
    try {
      return new URL(u).hostname || '?';
    } catch {
      /* sigue */
    }
  }
  return '?';
}

// Hashes validos de un archivo del indice (los que no tienen el largo correcto se ignoran).
function packHashes(hashes) {
  const h = hashes && typeof hashes === 'object' ? hashes : {};
  const sha1 = typeof h.sha1 === 'string' && /^[0-9a-f]{40}$/i.test(h.sha1) ? h.sha1.toLowerCase() : null;
  const sha512 = typeof h.sha512 === 'string' && /^[0-9a-f]{128}$/i.test(h.sha512) ? h.sha512.toLowerCase() : null;
  return { sha1, sha512 };
}

// ---------- Escrituras que respetan los enlaces duros ----------

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Temporal en la misma carpeta (mismo disco: el renombrado es atomico). Termina en .tmp: los loaders,
// las instantaneas y la exportacion lo ignoran.
function tempPathFor(dest) {
  const base = path.basename(dest);
  const rand = crypto.randomBytes(4).toString('hex');
  return path.join(path.dirname(dest), base.length > 180 ? `.venus-${process.pid}-${rand}.tmp` : `${base}.${process.pid}-${rand}.tmp`);
}

/**
 * Pone tmp en el lugar de dest renombrando (nunca abre dest para escribir). En Windows un antivirus puede
 * tener el archivo abierto un instante: se reintenta. Ultimo recurso: se aparta el viejo con otro nombre y
 * se pone el nuevo (si el viejo esta abierto por el juego tampoco se puede y se devuelve el error).
 */
async function replaceFile(tmp, dest, { retries = 4 } = {}) {
  for (let i = 0; ; i++) {
    try {
      await fsp.rename(tmp, dest);
      return;
    } catch (err) {
      if (!LOCK_CODES.has(err.code)) throw err;
      if (i < retries) {
        await pause(50 * 2 ** i);
        continue;
      }
      const st = await fsp.lstat(dest).catch(() => null);
      if (!st || st.isDirectory()) throw err;
      const aside = `${tempPathFor(dest)}.old`;
      try {
        await fsp.rename(dest, aside);
      } catch {
        throw err;
      }
      try {
        await fsp.rename(tmp, dest);
      } catch (err2) {
        await fsp.rename(aside, dest).catch(() => {});
        throw err2;
      }
      await fsp.rm(aside, { force: true, maxRetries: 2, retryDelay: 100 }).catch(() => {});
      return;
    }
  }
}

// Escribe dest con un temporal + renombrado. options: como fs.writeFile (encoding, mode).
async function writeFileAtomic(dest, data, options) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = tempPathFor(dest);
  const opts = typeof options === 'string' ? { encoding: options } : { ...(options || {}) };
  try {
    await fsp.writeFile(tmp, data, { ...opts, flag: 'wx' });
    await replaceFile(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// Copia src a dest: si dest existe se reemplaza (no se le escribe encima).
async function copyFileAtomic(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = tempPathFor(dest);
  try {
    await fsp.copyFile(src, tmp, fs.constants.COPYFILE_EXCL);
    await replaceFile(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// Mueve src a dest (mismo disco: renombrado; otro disco: copia por temporal y despues borra el original).
async function moveFile(src, dest) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await replaceFile(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await copyFileAtomic(src, dest);
    await fsp.rm(src, { force: true });
  }
}

// ---------- Archivos bloqueados ----------

// Error de Windows al borrar, renombrar o reemplazar un archivo abierto por otro programa.
function isLockError(err) {
  return Boolean(err && LOCK_CODES.has(err.code));
}

// ¿El archivo tiene otros enlaces duros (almacen de storage o instantaneas)? Si esta abierto desde OTRA
// instancia que comparte el contenido, en esta tampoco se puede borrar ni renombrar.
async function isSharedFile(file) {
  const st = await fsp.stat(file).catch(() => null);
  return Boolean(st && st.isFile() && st.nlink > 1);
}

module.exports = {
  PACK_HOSTS,
  validSegment,
  isReservedTop,
  safeRelPath,
  resolveInside,
  isAllowedPackUrl,
  allowedPackUrls,
  firstHost,
  packHashes,
  tempPathFor,
  replaceFile,
  writeFileAtomic,
  copyFileAtomic,
  moveFile,
  isLockError,
  isSharedFile,
};
