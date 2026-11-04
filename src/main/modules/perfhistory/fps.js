// FPS que informa el mod Venus Badge: <carpeta del juego>/venus/perf.json = { fps, at } (at en ms). El mod lo reescribe
// cada 2 s mientras hay un mundo abierto; sin el mod, con el juego en pausa o con un dato viejo se devuelve null.
const fs = require('fs');
const path = require('path');

const MAX_AGE_MS = 10000;

function readFps(gameDir, now = Date.now()) {
  try {
    const { fps, at } = JSON.parse(fs.readFileSync(path.join(gameDir, 'venus', 'perf.json'), 'utf8'));
    if (!Number.isFinite(fps) || fps < 0 || fps > 100000 || !Number.isFinite(at) || now - at > MAX_AGE_MS) return null;
    return { fps: Math.round(fps), at };
  } catch {
    return null;
  }
}

module.exports = { readFps, MAX_AGE_MS };
