'use strict';
// Hilo de renderizado: recibe trabajos { id, file, dim, out } y escribe la tesela PNG de la region.
// Responde { id, ok, result: { empty, chunks, skipped, unsupported, errors, legacy, bytes, ms } } o { id, ok: false, error }.
const fs = require('fs');
const path = require('path');
const { parentPort, threadId } = require('worker_threads');
const anvil = require('./anvil');
const render = require('./render');
const png = require('./png');

const sleeper = new Int32Array(new SharedArrayBuffer(4));

// Escritura atomica; en Windows el archivo puede estar abierto un instante por la interfaz: se reintenta
function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${threadId}.tmp`;
  fs.writeFileSync(tmp, buf);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ya no existe */
        }
        throw err;
      }
      Atomics.wait(sleeper, 0, 0, 30 * (i + 1));
    }
  }
}

function run(job) {
  const t0 = Date.now();
  const region = anvil.openRegionSync(job.file);
  const res = render.renderRegion(region, job.dim);
  let bytes = 0;
  let pngBuf = null;
  if (!res.empty) {
    pngBuf = png.encode(res.rgba, render.SIZE, render.SIZE);
    bytes = pngBuf.length;
    if (job.out) writeAtomic(job.out, pngBuf);
  }
  return {
    result: {
      empty: res.empty,
      chunks: res.chunks,
      skipped: res.skipped,
      unsupported: res.unsupported,
      errors: res.errors,
      legacy: res.legacy,
      formats: res.formats,
      bytes,
      ms: Date.now() - t0,
    },
    png: job.returnPng && pngBuf ? pngBuf : null,
  };
}

if (parentPort) {
  parentPort.on('message', (job) => {
    try {
      const { result, png: data } = run(job);
      if (data) {
        const copy = new Uint8Array(data);
        parentPort.postMessage({ id: job.id, ok: true, result, png: copy }, [copy.buffer]);
      } else parentPort.postMessage({ id: job.id, ok: true, result });
    } catch (err) {
      parentPort.postMessage({ id: job.id, ok: false, error: err?.message || String(err), code: err?.code || null });
    }
  });
}

module.exports = { run };
