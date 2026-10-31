'use strict';
// Escritura atómica de JSON compacto (sin sangría) para las caches del análisis, que pueden tener
// miles de jars: con sangría ocuparían el doble.
const fsp = require('fs/promises');
const path = require('path');

async function writeCompactJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data));
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

module.exports = { writeCompactJson };
