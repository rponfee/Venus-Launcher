'use strict';
// Genera src/main/modules/wallpapers/videos.json (tamaño y SHA-256 de los fondos animados, que no van en el instalador).
// Con --verify, además baja cada video de los dos lugares de donde lo baja el launcher y comprueba que sea el mismo.
//   node scripts/gen-wallpaper-videos.js [--verify]
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'src', 'renderer', 'assets', 'wallpapers');
const OUT = path.join(ROOT, 'src', 'main', 'modules', 'wallpapers', 'videos.json');
const SOURCES = [
  'https://venus-launcher-fondos.netlify.app/fondos/',
  'https://raw.githubusercontent.com/rponfee/Venus-Launcher/v3.0.0/src/renderer/assets/wallpapers/',
];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function main() {
  const videos = {};
  for (const name of fs.readdirSync(DIR).filter((n) => n.endsWith('.mp4')).sort()) {
    const buf = fs.readFileSync(path.join(DIR, name));
    videos[name.slice(0, -4)] = { size: buf.length, sha256: sha256(buf) };
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(videos, null, 2)}\n`);
  console.log(`${Object.keys(videos).length} videos en ${path.relative(ROOT, OUT)}`);
  if (!process.argv.includes('--verify')) return;

  let bad = 0;
  for (const [id, video] of Object.entries(videos)) {
    for (const base of SOURCES) {
      const res = await fetch(`${base}${id}.mp4`);
      const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
      const same = res.ok && buf.length === video.size && sha256(buf) === video.sha256;
      if (!same) bad++;
      console.log(`${same ? 'ok ' : 'MAL'} ${id} ${new URL(base).host} (HTTP ${res.status}, ${buf.length} bytes)`);
    }
  }
  if (bad) {
    console.error(`${bad} copias no coinciden`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
