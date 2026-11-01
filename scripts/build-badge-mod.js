'use strict';
// Compila el mod de la insignia de Venus (mod/venus-badge) y copia los .jar a src/main/modules/ingame/mods, donde
// los busca el launcher (modules/ingame/badgemod.js). En las releases lo hace .github/workflows/mod.yml.
// Necesita Java 21 o más nuevo. Uso:  node scripts/build-badge-mod.js
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MOD = path.join(ROOT, 'mod', 'venus-badge');
const OUT = path.join(ROOT, 'src', 'main', 'modules', 'ingame', 'mods');

// En Windows el .bat va por cmd con la ruta completa (cmd puede no buscar en la carpeta actual).
const r =
  process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/c', 'call', path.join(MOD, 'gradlew.bat'), 'build', '--console=plain'], { cwd: MOD, stdio: 'inherit' })
    : spawnSync('./gradlew', ['build', '--console=plain'], { cwd: MOD, stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status || 1);

fs.mkdirSync(OUT, { recursive: true });
const libs = path.join(MOD, 'build', 'libs');
let n = 0;
for (const f of fs.readdirSync(libs)) {
  const m = /^venus-badge-.+\+mc(.+)\.jar$/.exec(f);
  if (!m || f.endsWith('-sources.jar')) continue;
  const dest = path.join(OUT, `venus-badge-mc${m[1]}.jar`);
  fs.copyFileSync(path.join(libs, f), dest);
  console.log(`${f} -> ${path.relative(ROOT, dest)}`);
  n++;
}
if (!n) {
  console.error('No se encontró ningún .jar en mod/venus-badge/build/libs');
  process.exit(1);
}
