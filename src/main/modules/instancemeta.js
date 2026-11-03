'use strict';
// Caratulas de instancia: una imagen elegida por el usuario (png/jpg/webp, hasta 8 MB) o una captura de la
// misma instancia, recortada al centro en 16:9 y reducida a 640x360 con nativeImage, guardada como cover.png
// en la carpeta de la instancia. En venus-instance.json quedan `cover` (nombre del archivo) y `coverAt`
// (fecha, para que la interfaz no muestre una imagen vieja de la cache); los valida core/instances.update
// con ./instancemeta/meta.js, igual que tags, favorite y notes.
// Canales:
//   instancemeta:setCover(id, { file })        archivo elegido (ruta absoluta)
//   instancemeta:setCover(id, { screenshot })  captura de la instancia (dentro de <instancia>/screenshots)
//   instancemeta:setCover(id, { dataUrl })     imagen ya decodificada por la interfaz (data:image/png;base64,...)
//                                              -> instancia actualizada
//   instancemeta:removeCover(id)               -> instancia actualizada (vuelve a la caratula generada)
//   instancemeta:readImage(file)               -> { dataUrl } bytes de una imagen elegida (hasta 8 MB), para que la
//                                              interfaz decodifique WebP (nativeImage solo lee PNG y JPEG)
// Errores con err.code (la interfaz los traduce): badImage, tooBig, notScreenshot, writeFailed.
const fsp = require('fs/promises');
const path = require('path');
const instances = require('../core/instances');

const COVER_FILE = 'cover.png';
const MAX_BYTES = 8 * 1024 * 1024;
const WIDTH = 640;
const HEIGHT = 360;
const IMAGE = /\.(png|jpe?g|webp)$/i;
const DATA_URL = /^data:image\/(png|jpeg);base64,/i;

function codeError(code) {
  return Object.assign(new Error(code), { code });
}

// Recorte centrado 16:9 y reduccion a 640x360.
function fitCover(img) {
  const { width, height } = img.getSize();
  if (!width || !height) throw codeError('badImage');
  let cw = width;
  let ch = Math.round((width * HEIGHT) / WIDTH);
  if (ch > height) {
    ch = height;
    cw = Math.round((height * WIDTH) / HEIGHT);
  }
  let out = img;
  if (cw !== width || ch !== height) out = img.crop({ x: Math.max(0, Math.floor((width - cw) / 2)), y: Math.max(0, Math.floor((height - ch) / 2)), width: Math.max(1, cw), height: Math.max(1, ch) });
  return out.resize({ width: WIDTH, height: HEIGHT, quality: 'best' });
}

async function loadFromFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !IMAGE.test(file)) throw codeError('badImage');
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw codeError('badImage');
  if (st.size > MAX_BYTES) throw codeError('tooBig');
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromPath(file);
  if (img.isEmpty()) throw codeError('badImage');
  return img;
}

function loadFromDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !DATA_URL.test(dataUrl) || dataUrl.length > MAX_BYTES * 1.4) throw codeError('badImage');
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) throw codeError('badImage');
  return img;
}

// Una captura de esa instancia: dentro de <instancia>/screenshots y con nombre de imagen.
function screenshotPath(id, p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw codeError('notScreenshot');
  const base = path.resolve(instances.dir(id), 'screenshots');
  const full = path.resolve(p);
  if (path.dirname(full) !== base || !IMAGE.test(full)) throw codeError('notScreenshot');
  return full;
}

async function setCover(id, opts = {}) {
  const inst = await instances.get(id);
  let img;
  if (typeof opts.dataUrl === 'string') img = loadFromDataUrl(opts.dataUrl);
  else if (opts.screenshot !== undefined) img = await loadFromFile(screenshotPath(id, opts.screenshot));
  else img = await loadFromFile(opts.file);
  const small = fitCover(img);
  const dest = path.join(instances.dir(id), COVER_FILE);
  const tmp = `${dest}.part`;
  try {
    await fsp.writeFile(tmp, small.toPNG());
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw Object.assign(codeError('writeFailed'), { cause: err });
  }
  // Una caratula anterior con otro nombre (por ejemplo cover.webp) se descarta.
  if (inst.cover && inst.cover !== COVER_FILE) await fsp.rm(path.join(instances.dir(id), inst.cover), { force: true }).catch(() => {});
  return instances.update(id, { cover: COVER_FILE, coverAt: Date.now() });
}

async function removeCover(id) {
  const inst = await instances.get(id);
  if (inst.cover) await fsp.rm(path.join(instances.dir(id), inst.cover), { force: true }).catch(() => {});
  return instances.update(id, { cover: null, coverAt: null });
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

async function readImage(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !IMAGE.test(file)) throw codeError('badImage');
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw codeError('badImage');
  if (st.size > MAX_BYTES) throw codeError('tooBig');
  const mime = MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
  const buf = await fsp.readFile(file);
  return { dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
}

function register({ handle, send }) {
  handle('instancemeta:readImage', (file) => readImage(file));
  handle('instancemeta:setCover', async (id, opts) => {
    const next = await setCover(id, opts);
    send('instances:changed');
    return next;
  });
  handle('instancemeta:removeCover', async (id) => {
    const next = await removeCover(id);
    send('instances:changed');
    return next;
  });
}

module.exports = { register, setCover, removeCover, COVER_FILE, MAX_BYTES };
