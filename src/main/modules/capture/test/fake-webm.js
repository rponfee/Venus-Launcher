'use strict';
// WebM de prueba como el de MediaRecorder: Segment y Clusters de tamanio desconocido, Clusters cada ~1 s que NO
// coinciden con los cuadros clave (asi lo hace Chrome), video a 30 fps con un cuadro clave cada 2 s y audio cada 20 ms.
const { ID, element, uintEl, idBytes, UNKNOWN_SIZE, floatEl } = require('../webm');

function stringEl(id, s) {
  return element(id, Buffer.from(s, 'latin1'));
}

function ebmlHeader() {
  return element(ID.EBML, [uintEl(0x4286, 1), uintEl(0x42f7, 1), uintEl(0x42f2, 4), uintEl(0x42f3, 8), stringEl(0x4282, 'webm'), uintEl(0x4287, 4), uintEl(0x4285, 2)]);
}

function info({ duration = null } = {}) {
  const parts = [uintEl(ID.TimecodeScale, 1000000), stringEl(0x4d80, 'Chrome'), stringEl(0x5741, 'Chrome')];
  if (duration !== null) parts.push(floatEl(ID.Duration, duration));
  return element(ID.Info, parts);
}

function tracks({ width = 1280, height = 720, audio = true } = {}) {
  const video = element(ID.TrackEntry, [uintEl(ID.TrackNumber, 1), uintEl(0x73c5, 1), uintEl(ID.TrackType, 1), stringEl(ID.CodecID, 'V_VP9'), element(ID.Video, [uintEl(ID.PixelWidth, width), uintEl(ID.PixelHeight, height)])]);
  const list = [video];
  if (audio) list.push(element(ID.TrackEntry, [uintEl(ID.TrackNumber, 2), uintEl(0x73c5, 2), uintEl(ID.TrackType, 2), stringEl(ID.CodecID, 'A_OPUS'), element(0xe1, [floatEl(0xb5, 48000), uintEl(0x9f, 2)])]));
  return element(ID.Tracks, list);
}

// SimpleBlock: pista (vint de 1 byte), tiempo relativo int16, flags, datos
function simpleBlock(track, rel, key, payload) {
  const head = Buffer.alloc(4);
  head[0] = 0x80 | track;
  head.writeInt16BE(rel, 1);
  head[3] = key ? 0x80 : 0;
  return element(ID.SimpleBlock, [head, payload]);
}

// Cuadros: [{ track, time, key, size }] ordenados por tiempo
function makeFrames({ seconds = 10, fps = 30, keyMs = 2000, audio = true, size = 200 } = {}) {
  const frames = [];
  const end = seconds * 1000;
  let lastKey = -Infinity;
  for (let i = 0; ; i++) {
    const time = Math.round((i * 1000) / fps);
    if (time >= end) break;
    const key = time - lastKey >= keyMs;
    if (key) lastKey = time;
    frames.push({ track: 1, time, key, size: key ? size * 4 : size });
  }
  if (audio) for (let time = 0; time < end; time += 20) frames.push({ track: 2, time, key: true, size: 40 });
  frames.sort((a, b) => a.time - b.time || a.track - b.track);
  return frames;
}

/**
 * Flujo completo como Buffer. frames = makeFrames(); clusterMs = cada cuanto empieza un Cluster (sin mirar claves).
 */
function makeStream(opts = {}) {
  const frames = opts.frames || makeFrames(opts);
  const clusterMs = opts.clusterMs || 1000;
  const base = opts.base || 0; // tiempo absoluto del primer cuadro (para simular un flujo que no empieza en 0)
  const parts = [ebmlHeader(), idBytes(ID.Segment), UNKNOWN_SIZE, info(), tracks(opts)];
  let clusterStart = null;
  let n = 0;
  for (const f of frames) {
    const t = f.time + base;
    if (clusterStart === null || t - clusterStart >= clusterMs) {
      clusterStart = t;
      parts.push(idBytes(ID.Cluster), UNKNOWN_SIZE, uintEl(ID.Timecode, clusterStart));
    }
    const payload = Buffer.alloc(f.size, (n++ % 250) + 1);
    parts.push(simpleBlock(f.track, t - clusterStart, f.key, payload));
  }
  return Buffer.concat(parts);
}

// Parte un Buffer en pedazos de tamanio variable (como los de MediaRecorder)
function chunks(buf, sizes = [7, 1000, 3, 50000, 1, 9999]) {
  const out = [];
  let pos = 0;
  let i = 0;
  while (pos < buf.length) {
    const n = sizes[i++ % sizes.length];
    out.push(buf.subarray(pos, pos + n));
    pos += n;
  }
  return out;
}

module.exports = { makeFrames, makeStream, chunks, simpleBlock, ebmlHeader, info, tracks };
