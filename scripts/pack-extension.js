'use strict';
// Arma un paquete .venusext con el contenido de una carpeta y lo valida con el mismo lector que usa el launcher.
// Uso: node scripts/pack-extension.js <carpeta> [salida.venusext]
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { readPackage } = require('../src/main/modules/extensions/package');

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile()) out.push({ full, rel: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

// Devuelve el paquete en memoria. Lanza un ExtensionError si el launcher lo rechazaría.
function packFolder(dir) {
  const zip = new AdmZip();
  for (const f of walk(dir)) zip.addFile(f.rel, fs.readFileSync(f.full));
  const buffer = zip.toBuffer();
  return { buffer, pkg: readPackage(buffer) };
}

if (require.main === module) {
  const [dir, out] = process.argv.slice(2);
  if (!dir) {
    console.error('Uso: node scripts/pack-extension.js <carpeta> [salida.venusext]');
    process.exit(2);
  }
  try {
    const { buffer, pkg } = packFolder(path.resolve(dir));
    const target = path.resolve(out || `${pkg.manifest.id}-${pkg.manifest.version}.venusext`);
    fs.writeFileSync(target, buffer);
    console.log(`${target}\n  ${pkg.manifest.name} ${pkg.manifest.version}: ${pkg.files.length} archivos, ${buffer.length} bytes\n  SHA-256 ${pkg.sha256}`);
  } catch (err) {
    console.error(`El launcher rechazaría este paquete: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { packFolder };
