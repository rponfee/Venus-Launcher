'use strict';
// Escribe src/main/core/build-config.json con las claves que no van al repositorio (hoy, la API key de CurseForge, que
// sus términos prohíben compartir). Lo corre el workflow Build antes de compilar, con el secreto VENUS_CURSEFORGE_API_KEY
// de GitHub Actions. Sin el secreto no escribe nada y el catálogo de CurseForge queda apagado. Nunca imprime la clave.
// También sirve para compilar en la PC: VENUS_CURSEFORGE_API_KEY=... node scripts/write-build-config.js
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'src', 'main', 'core', 'build-config.json');
const key = String(process.env.VENUS_CURSEFORGE_API_KEY || '').trim();

fs.rmSync(OUT, { force: true });
if (key) {
  fs.writeFileSync(OUT, `${JSON.stringify({ curseforgeApiKey: key })}\n`);
  console.log('CurseForge: clave cargada en este build.');
} else {
  const text = 'CurseForge: sin clave. Este build sale sin el catálogo de CurseForge (falta el secreto VENUS_CURSEFORGE_API_KEY).';
  console.log(process.env.GITHUB_ACTIONS ? `::warning title=CurseForge::${text}` : text);
}
