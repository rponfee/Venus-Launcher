'use strict';
// e4mc (modrinth.com/mod/e4mc): abre un mundo en LAN a internet con un dominio público (*.e4mc.link),
// sin abrir puertos. Acá: buscar la versión compatible, detectar si ya está instalado y leer el log del juego.
//
// Lo que escribe el mod en el log (fuente: vgskye/e4mc-minecraft-architectury, QuiclimeSession.java):
//   LOGGER.info("Domain assigned: {}", domain)       -> "[..] [Netty .../INFO]: Domain assigned: abc.lax.e4mc.link"
//   chat "Local game hosted on domain [%s]"           -> "[..] [Render thread/INFO]: [System] [CHAT] Local game hosted on domain [abc...]"
//   LOGGER.error("error in e4mc", e)                  -> error al conectar con el relay
// Minecraft al abrir en LAN: "Started serving on <puerto>" (IntegratedServer.publishServer)
const fsp = require('fs/promises');
const path = require('path');

const PROJECT_ID = 'qANg5Jrr';
const SLUG = 'e4mc';
const SUPPORTED_LOADERS = ['fabric', 'quilt', 'forge', 'neoforge'];

const DOMAIN_RE = /Domain assigned:\s*([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,})/;
const E4MC_HOST_RE = /\b([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.e4mc\.link)\b/i;
const LAN_RE = /Started serving on (\d{2,5})\b/;
const ERROR_RE = /error in e4mc|An error occurred in e4mc/i;
const STOPPED_RE = /Local game no longer publicly hosted/i;

// Razon por la que una instancia no puede usar e4mc (null = soportada)
function unsupportedReason(inst) {
  if (!inst) return 'missing';
  if (inst.loader === 'vanilla' || inst.loader === 'optifine') return inst.loader;
  if (!SUPPORTED_LOADERS.includes(inst.loader)) return 'loader';
  return null;
}

// Lee una linea del log del juego y devuelve lo que encontro (o null)
function parseLine(text) {
  if (!text) return null;
  let m = DOMAIN_RE.exec(text);
  if (m) return { type: 'domain', domain: m[1].toLowerCase() };
  if (/\[CHAT\]/.test(text) || /e4mc/i.test(text)) {
    m = E4MC_HOST_RE.exec(text);
    if (m) return { type: 'domain', domain: m[1].toLowerCase() };
  }
  m = LAN_RE.exec(text);
  if (m) {
    const port = Number(m[1]);
    if (port > 0 && port < 65536) return { type: 'lan', port };
  }
  if (ERROR_RE.test(text)) return { type: 'error' };
  if (STOPPED_RE.test(text)) return { type: 'stopped' };
  return null;
}

// Archivo de e4mc en la carpeta mods (registrado por Venus o puesto a mano). { file, enabled } | null
async function installedFile(inst) {
  const modsDir = path.join(inst.dir, 'mods');
  const rec = inst.modrinth?.projects?.[PROJECT_ID];
  let files = [];
  try {
    files = await fsp.readdir(modsDir);
  } catch {
    return null;
  }
  if (rec?.file) {
    if (files.includes(rec.file)) return { file: rec.file, enabled: true, versionNumber: rec.versionNumber || null, tracked: true };
    if (files.includes(`${rec.file}.disabled`)) return { file: `${rec.file}.disabled`, enabled: false, versionNumber: rec.versionNumber || null, tracked: true };
  }
  const found = files.find((f) => /^e4mc[-_]/i.test(f) && /\.jar(\.disabled)?$/i.test(f));
  if (!found) return null;
  return { file: found, enabled: !found.endsWith('.disabled'), versionNumber: null, tracked: false };
}

// Version de e4mc compatible con la instancia (release primero). null si no hay.
async function findVersion(modrinth, inst) {
  const loaders = modrinth.modLoadersFor(inst);
  if (!loaders.length) return null;
  const list = await modrinth.getVersions(PROJECT_ID, { loaders, gameVersions: [inst.mcVersion] });
  if (!Array.isArray(list) || !list.length) return null;
  const v = list.find((x) => x.version_type === 'release') || list.find((x) => x.version_type === 'beta') || list[0];
  return { id: v.id, versionNumber: v.version_number, type: v.version_type, loaders: v.loaders, date: v.date_published };
}

module.exports = { PROJECT_ID, SLUG, SUPPORTED_LOADERS, unsupportedReason, parseLine, installedFile, findVersion };
