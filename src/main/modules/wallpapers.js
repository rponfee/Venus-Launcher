'use strict';
// Fondos animados a demanda: no vienen en el instalador (son 88 MiB de video). El que se elige se baja una vez a
// cache/wallpapers desde la página de fondos, con GitHub de respaldo, y se comprueba con el SHA-256 de wallpapers/videos.json
// (lo genera scripts/gen-wallpaper-videos.js). Sin empaquetar, usa el archivo del repositorio y no baja nada.
// Canales: wallpapers:status() -> { [id]: { size, path } }   (path null = todavía no está en esta PC)
//          wallpapers:ensure(id) -> { path }                 (avisa con el evento wallpapers:progress { id, percent })
const fsp = require('fs/promises');
const path = require('path');
const VIDEOS = require('./wallpapers/videos.json');

const SITE = 'https://venus-launcher-fondos.netlify.app/fondos/';
const MIRROR = 'https://raw.githubusercontent.com/rponfee/Venus-Launcher/v3.0.0/src/renderer/assets/wallpapers/';
const BUNDLED = path.join(__dirname, '..', '..', 'renderer', 'assets', 'wallpapers');
const PROGRESS_MS = 250;

const known = (id) => (Object.prototype.hasOwnProperty.call(VIDEOS, id) ? VIDEOS[id] : null);
const fileName = (id) => `${id}.mp4`;
const cached = (id) => require('../core/paths').cache('wallpapers', fileName(id));

async function sizeOf(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return -1;
  }
}

// El archivo listo para usar, si ya está en esta PC.
async function localPath(id) {
  const video = known(id);
  if (!video) return null;
  const bundled = path.join(BUNDLED, fileName(id));
  if ((await sizeOf(bundled)) === video.size) return bundled;
  const file = cached(id);
  return (await sizeOf(file)) === video.size ? file : null;
}

async function status() {
  const out = {};
  await Promise.all(
    Object.entries(VIDEOS).map(async ([id, video]) => {
      out[id] = { size: video.size, path: await localPath(id) };
    }),
  );
  return out;
}

const running = new Map(); // id -> Promise (una sola descarga por fondo)

function ensure(id, send) {
  const video = known(id);
  if (!video) return Promise.reject(new Error('Fondo desconocido'));
  if (running.has(id)) return running.get(id);
  const run = (async () => {
    const ready = await localPath(id);
    if (ready) return { path: ready };
    const file = cached(id);
    let bytes = 0;
    let last = 0;
    await require('../core/http').download(
      { urls: [`${SITE}${fileName(id)}`, `${MIRROR}${fileName(id)}`], path: file, size: video.size, sha256: video.sha256 },
      {
        onBytes: (delta) => {
          bytes += delta;
          const at = Date.now();
          if (at - last < PROGRESS_MS) return;
          last = at;
          send?.('wallpapers:progress', { id, percent: Math.min(100, Math.round((bytes / video.size) * 100)) });
        },
      },
    );
    return { path: file };
  })();
  running.set(id, run);
  const clear = () => running.delete(id);
  run.then(clear, clear);
  return run;
}

function register({ handle, send }) {
  handle('wallpapers:status', () => status());
  handle('wallpapers:ensure', (id) => ensure(String(id), send));
}

module.exports = { register, status, ensure, localPath };
