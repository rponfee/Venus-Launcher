'use strict';
// Configuracion de cada build: CurseForge y los identificadores publicos de YouTube y TikTok.
// Nunca imprime valores. Los identificadores de las aplicaciones no son tokens de cuentas ni secretos OAuth.
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'src', 'main', 'core', 'build-config.json');
const key = String(process.env.VENUS_CURSEFORGE_API_KEY || '').trim();
const out = {};
if (key) out.curseforgeApiKey = key;
for (const [field, name] of [['youtubeClientId', 'VENUS_YOUTUBE_CLIENT_ID'], ['tiktokClientKey', 'VENUS_TIKTOK_CLIENT_KEY']]) {
  const value = String(process.env[name] || '').trim();
  if (value) out[field] = value;
}

fs.rmSync(OUT, { force: true });
if (Object.keys(out).length) fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
if (key) {
  console.log('CurseForge: clave cargada en este build.');
} else {
  const text = 'CurseForge: sin clave. Este build sale sin el catálogo de CurseForge (falta el secreto VENUS_CURSEFORGE_API_KEY).';
  console.log(process.env.GITHUB_ACTIONS ? `::warning title=CurseForge::${text}` : text);
}
