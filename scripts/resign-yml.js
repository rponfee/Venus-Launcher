'use strict';
// Actualiza un latest.yml (o demo.yml) de una release ya publicada después de firmar sus ejecutables: firmar
// cambia cada archivo, así que su sha512 y su tamaño dejan de coincidir. Conserva la versión, los nombres y el
// resto del archivo; solo reescribe sha512 y size de los archivos que encuentra en <carpeta>.
// Uso: node scripts/resign-yml.js <latest.yml> <carpeta con los .exe firmados>
// Lo usa .github/workflows/resign-releases.yml. El .blockmap viejo ya no coincide: el workflow lo borra.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [ymlPath, dir] = process.argv.slice(2);
if (!ymlPath || !dir || !fs.existsSync(ymlPath) || !fs.existsSync(dir)) {
  console.error('Uso: node scripts/resign-yml.js <latest.yml> <carpeta>');
  process.exit(1);
}

// Las entradas pueden ser un nombre o una URL completa (demo.yml): se busca por el nombre del archivo.
const clean = (v) => decodeURIComponent(v.replace(/^['"]|['"]$/g, '').split('/').pop());
const info = new Map();
function hashOf(name) {
  if (!info.has(name)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) { info.set(name, null); return null; }
    const data = fs.readFileSync(file);
    info.set(name, { sha512: crypto.createHash('sha512').update(data).digest('base64'), size: data.length });
  }
  return info.get(name);
}

// Formato de electron-builder: una lista "files" con url/sha512/size y, arriba, path/sha512 del principal.
const lines = fs.readFileSync(ymlPath, 'utf8').split(/\r?\n/);
let current = null; // archivo de la entrada de "files" que se está leyendo
let main = null;    // archivo de "path:" (el sha512 de nivel superior es el suyo)
for (const l of lines) { const m = /^path:\s*(.+?)\s*$/.exec(l); if (m) main = clean(m[1]); }
let changed = 0;
const out = lines.map((l) => {
  let m = /^(\s*-\s*url:\s*)(.+?)\s*$/.exec(l);
  if (m) { current = clean(m[2]); return l; }
  if (/^\S/.test(l)) current = null; // terminó la lista "files"
  const name = current || (/^sha512:/.test(l) ? main : null);
  const h = name && hashOf(name);
  if (!h) return l;
  m = /^(\s*sha512:\s*).+$/.exec(l);
  if (m) { changed++; return m[1] + h.sha512; }
  m = /^(\s*size:\s*).+$/.exec(l);
  if (m) { changed++; return m[1] + h.size; }
  return l;
});
fs.writeFileSync(ymlPath, out.join('\n'));
console.log(`${path.basename(ymlPath)}: ${changed} valores actualizados`);
