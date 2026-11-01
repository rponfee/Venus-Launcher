'use strict';
// Imagen del resumen (sin Electron en el nivel superior): valida el PNG que arma la interfaz en un <canvas>
// y lo copia al portapapeles o lo guarda. Lo de Electron (portapapeles, dialogo) llega por parametro, asi
// se prueba con Node puro. Los errores llevan err.code ('badImage' o 'tooBig'); recap.js los traduce.
const path = require('path');

const PREFIX = 'data:image/png;base64,';
const MAX_DATA_URL = 24 * 1024 * 1024; // caracteres (unos 18 MB de PNG); la tarjeta pesa unos pocos MB
const MAX_SIDE = 4096;
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

function codeError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

// data:image/png;base64,... -> { buffer, width, height } (lee el ancho y el alto de la cabecera IHDR)
function parsePngDataUrl(dataUrl, { maxChars = MAX_DATA_URL, maxSide = MAX_SIDE } = {}) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PREFIX)) throw codeError('badImage');
  if (dataUrl.length > maxChars) throw codeError('tooBig');
  const b64 = dataUrl.slice(PREFIX.length);
  if (!b64.length || b64.length % 4 !== 0 || !BASE64.test(b64)) throw codeError('badImage');
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(SIGNATURE) || buffer.toString('latin1', 12, 16) !== 'IHDR') throw codeError('badImage');
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height) throw codeError('badImage');
  if (width > maxSide || height > maxSide) throw codeError('tooBig');
  return { buffer, width, height };
}

// Nombre de archivo seguro (sin carpetas ni caracteres reservados de Windows), siempre .png
function pngFileName(suggested, fallback = 'venus') {
  const clean = (s) =>
    String(s ?? '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 80)
      .replace(/[.\s]+$/g, '');
  let base = clean(suggested).replace(/\.png$/i, '');
  if (!base || RESERVED.test(base)) base = clean(fallback) || 'venus';
  if (RESERVED.test(base)) base = 'venus';
  return `${base}.png`;
}

// Copia la imagen al portapapeles. dryRun: valida y arma la imagen sin tocar el portapapeles (capturas automaticas).
function copyPng(dataUrl, { clipboard, nativeImage, dryRun = false }) {
  const img = parsePngDataUrl(dataUrl);
  const native = nativeImage.createFromDataURL(dataUrl);
  if (!native || native.isEmpty()) throw codeError('badImage');
  if (!dryRun) clipboard.writeImage(native);
  return { width: img.width, height: img.height };
}

// Guarda la imagen donde elija el usuario (dialogo) o, con fixedDir, ahi mismo sin preguntar (capturas
// automaticas). writeFile tiene que ser atomico (temporal + renombrar). Devuelve null si se cancela.
async function savePng(dataUrl, suggested, { showSaveDialog, defaultDir, writeFile, title, filterName, fallbackName, fixedDir = null }) {
  const img = parsePngDataUrl(dataUrl);
  const name = pngFileName(suggested, fallbackName);
  let target;
  if (fixedDir) {
    target = path.join(fixedDir, name);
  } else {
    const r = await showSaveDialog({
      title,
      defaultPath: path.join(defaultDir, name),
      filters: [{ name: filterName, extensions: ['png'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (!r || r.canceled || !r.filePath) return null;
    target = /\.png$/i.test(r.filePath) ? r.filePath : `${r.filePath}.png`;
  }
  await writeFile(target, img.buffer);
  return { path: target, bytes: img.buffer.length, width: img.width, height: img.height };
}

module.exports = { parsePngDataUrl, pngFileName, copyPng, savePng, MAX_DATA_URL, MAX_SIDE };
