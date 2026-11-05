'use strict';
// Capturas de Soporte: se acepta lo que de verdad es una imagen PNG, JPEG o WebP (por sus primeros bytes, no por lo que
// diga el nombre o el tipo que manda la interfaz) y de hasta 4 MiB. Lo mismo exige el bucket support-attachments.
const { LIMITS, coded } = require('./rules');

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

function sniffImage(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

// Convierte lo que llega por IPC (Uint8Array, ArrayBuffer o Buffer) en Buffer, o null.
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

// -> { bytes, mime, ext } o tira attach_big / attach_bad.
function checkUpload(value) {
  const bytes = toBuffer(value);
  if (!bytes || !bytes.length) throw coded('attach_bad', 'La captura está vacía.');
  if (bytes.length > LIMITS.attachmentBytes) throw coded('attach_big', 'La captura pesa más de 4 MB.');
  const mime = sniffImage(bytes);
  if (!mime) throw coded('attach_bad', 'Solo se aceptan capturas PNG, JPEG o WebP.');
  return { bytes, mime, ext: EXT[mime] };
}

// Nombre para mostrar: sin carpetas, sin caracteres de control ni los que Windows no admite, hasta 80.
function safeName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop() || '';
  const clean = base.replace(/[\u0000-\u001f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.attachmentName);
  return clean || 'captura';
}

const OBJECT_PATH = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$/i;
const isObjectPath = (p) => typeof p === 'string' && OBJECT_PATH.test(p);

module.exports = { sniffImage, toBuffer, checkUpload, safeName, isObjectPath, EXT };
