'use strict';
// Rutas de datos del launcher. La raiz se define una sola vez al iniciar (main.js),
// lo que permite usar estos modulos tambien desde scripts de Node sin Electron.
const path = require('path');
const fs = require('fs');

let ROOT = null;

function setRoot(dir) {
  ROOT = path.resolve(dir);
  for (const d of ['versions', 'libraries', 'assets', 'runtime', 'instances', 'servers', 'cache', 'data', 'natives', 'logs']) {
    fs.mkdirSync(path.join(ROOT, d), { recursive: true });
  }
}

function root() {
  if (!ROOT) throw new Error('La carpeta de datos del launcher no fue inicializada');
  return ROOT;
}

module.exports = {
  setRoot,
  root,
  versions: () => path.join(root(), 'versions'),
  versionDir: (id) => path.join(root(), 'versions', id),
  versionJson: (id) => path.join(root(), 'versions', id, `${id}.json`),
  versionJar: (id) => path.join(root(), 'versions', id, `${id}.jar`),
  libraries: () => path.join(root(), 'libraries'),
  library: (rel) => path.join(root(), 'libraries', rel),
  assets: () => path.join(root(), 'assets'),
  runtime: () => path.join(root(), 'runtime'),
  instances: () => path.join(root(), 'instances'),
  instance: (id) => path.join(root(), 'instances', id),
  servers: () => path.join(root(), 'servers'),
  server: (id) => path.join(root(), 'servers', id),
  cache: (...p) => path.join(root(), 'cache', ...p),
  data: (name) => path.join(root(), 'data', name),
  natives: (id) => path.join(root(), 'natives', id),
  logs: () => path.join(root(), 'logs'),
};
