'use strict';
// Rearma latest.yml (lo que lee la actualización automática) para un instalador ya firmado: firmar cambia el
// archivo, así que el sha512 y el tamaño que calculó electron-builder dejan de coincidir.
// Uso: node scripts/latest-yml.js <VenusLauncher-Setup-x.y.z.exe> [salida/latest.yml]
// El .blockmap original tampoco coincide: no se publica (electron-updater descarga el instalador completo).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [file, out] = process.argv.slice(2);
if (!file || !fs.existsSync(file)) {
  console.error('Uso: node scripts/latest-yml.js <instalador.exe> [latest.yml]');
  process.exit(1);
}
const { version } = require('../package.json');
const name = path.basename(file);
if (!name.includes(version)) {
  console.error(`El instalador ${name} no es de la versión ${version} de package.json.`);
  process.exit(1);
}
const data = fs.readFileSync(file);
const sha512 = crypto.createHash('sha512').update(data).digest('base64');
const yml = [
  `version: ${version}`,
  'files:',
  `  - url: ${name}`,
  `    sha512: ${sha512}`,
  `    size: ${data.length}`,
  `path: ${name}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n');
if (out) fs.writeFileSync(out, yml);
else process.stdout.write(yml);
