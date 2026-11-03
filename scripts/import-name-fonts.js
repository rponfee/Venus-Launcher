'use strict';
// Copia las tipografias del nombre (features/profile-editor/fonts.js) desde paquetes de @fontsource ya extraidos y
// genera src/renderer/styles/features/profile-fonts.css. Solo hace falta correrlo si se agrega una fuente.
// Uso: npm pack @fontsource/<paquete>, extraerlo en <carpeta>/<paquete>/package y node scripts/import-name-fonts.js <carpeta>
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SUBSETS = ['latin', 'latin-ext', 'cyrillic'];

(async () => {
  const src = process.argv[2];
  if (!src) throw new Error('Falta la carpeta con los paquetes');
  const { EXTRA_FONTS, fontStack } = await import(pathToFileURL(path.join(ROOT, 'src/renderer/js/features/profile-editor/fonts.js')).href);
  const outFonts = path.join(ROOT, 'src/renderer/assets/fonts/names');
  const outLic = path.join(ROOT, 'src/renderer/assets/fonts/licenses');
  fs.mkdirSync(outFonts, { recursive: true });
  fs.mkdirSync(outLic, { recursive: true });
  const faces = [];
  const rules = [];
  let bytes = 0;
  for (const f of EXTRA_FONTS) {
    const dir = path.join(src, f.pkg, 'package');
    const css = fs.readFileSync(path.join(dir, `${f.weight}.css`), 'utf8');
    for (const subset of SUBSETS) {
      const name = `${f.pkg}-${subset}-${f.weight}-normal.woff2`;
      const file = path.join(dir, 'files', name);
      if (!fs.existsSync(file)) continue;
      const m = new RegExp(`/\\* ${f.pkg}-${subset}-${f.weight}-normal \\*/[\\s\\S]*?unicode-range:\\s*([^;]+);`).exec(css);
      if (!m) throw new Error(`Sin unicode-range: ${name}`);
      fs.copyFileSync(file, path.join(outFonts, name));
      bytes += fs.statSync(file).size;
      faces.push(`@font-face { font-family: '${f.family}'; font-style: normal; font-display: swap; font-weight: ${f.weight}; src: url('../../assets/fonts/names/${name}') format('woff2'); unicode-range: ${m[1].trim().replace(/\s+/g, ' ')}; }`);
    }
    fs.copyFileSync(path.join(dir, 'LICENSE'), path.join(outLic, `${f.pkg}.txt`));
    const scale = f.scale === 1 ? '' : ` font-size: ${f.scale}em;`;
    rules.push(`.pf-font-${f.id} .pf-name-text { font-family: ${fontStack(f)}; font-weight: ${f.weight};${scale} }`);
  }
  const head = '/* Generado por scripts/import-name-fonts.js: no editar a mano. Licencias en assets/fonts/licenses. */\n';
  fs.writeFileSync(path.join(ROOT, 'src/renderer/styles/features/profile-fonts.css'), `${head}${faces.join('\n')}\n\n${rules.join('\n')}\n`);
  console.log(`${EXTRA_FONTS.length} fuentes, ${faces.length} archivos, ${(bytes / 1024).toFixed(0)} KB`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
