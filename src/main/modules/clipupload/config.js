'use strict';
// Identificadores de las aplicaciones de YouTube y TikTok. Sin ellos, el camino directo no se muestra y solo queda el que
// abre el navegador. Como la clave de CurseForge: en desarrollo salen de las variables de entorno y en el instalador, de
// core/build-config.json (lo escribe scripts/write-build-config.js al compilar). Pasos para el dueño: docs/wip/clips-33.md.
//   VENUS_YOUTUBE_CLIENT_ID (cliente OAuth de tipo "App de escritorio") · VENUS_YOUTUBE_CLIENT_SECRET (opcional: Google
//   lo marca como opcional y aclara que en escritorio no es confidencial) · VENUS_TIKTOK_CLIENT_KEY
const { devEnv } = require('../../core/app-config');

function injected() {
  try {
    return require('../../core/build-config.json');
  } catch {
    return {};
  }
}

const text = (v, max = 256) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function get() {
  const build = injected();
  const dev = devEnv();
  const pick = (name, value) => text((dev && text(process.env[name])) || value);
  return {
    youtubeClientId: pick('VENUS_YOUTUBE_CLIENT_ID', build.youtubeClientId),
    youtubeClientSecret: pick('VENUS_YOUTUBE_CLIENT_SECRET', build.youtubeClientSecret),
    tiktokClientKey: pick('VENUS_TIKTOK_CLIENT_KEY', build.tiktokClientKey),
  };
}

module.exports = { get };
