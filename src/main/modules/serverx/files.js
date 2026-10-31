'use strict';
// Editor de archivos de configuracion del servidor (paper-global.yml, bukkit.yml, velocity.toml,
// configs de mods...). Solo archivos de texto chicos, siempre dentro de la carpeta del servidor.
const fsp = require('fs/promises');
const path = require('path');
const servers = require('../../core/servers');
const { t } = require('../../core/i18n');

const EDITABLE = /\.(ya?ml|toml|properties|json5?|txt|cfg|conf|ini|snbt|mcmeta|secret)$/i;
const SKIP_DIRS = new Set(['libraries', 'logs', 'crash-reports', 'cache', 'versions', 'backups', 'bundler', 'debug', '.fabric', '.quilt', 'mods', 'world-backups', 'node_modules', '.git']);
const SKIP_FILES = new Set(['venus-server.json', 'usercache.json', 'version_history.json', 'commands.json']);
const MAX_SIZE = 1024 * 1024;

async function worldNames(id) {
  try {
    const p = await servers.readProperties(id);
    const level = String(p['level-name'] || 'world');
    return new Set([level, `${level}_nether`, `${level}_the_end`]);
  } catch {
    return new Set(['world']);
  }
}

async function list(id) {
  await servers.get(id);
  const root = servers.dir(id);
  const worlds = await worldNames(id);
  const out = [];
  const walk = async (rel, depth) => {
    let entries = [];
    try {
      entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth >= 3 || SKIP_DIRS.has(e.name) || (!rel && worlds.has(e.name))) continue;
        await walk(r, depth + 1);
      } else if (e.isFile() && EDITABLE.test(e.name) && !SKIP_FILES.has(e.name.toLowerCase())) {
        const st = await fsp.stat(path.join(root, r)).catch(() => null);
        if (st && st.size <= MAX_SIZE) out.push({ path: r, size: st.size, mtime: st.mtimeMs });
      }
      if (out.length >= 400) return;
    }
  };
  await walk('', 0);
  return out.sort((a, b) => (a.path.includes('/') === b.path.includes('/') ? a.path.localeCompare(b.path) : a.path.includes('/') ? 1 : -1));
}

// En Windows los nombres no distinguen mayusculas: VENUS-SERVER.JSON es venus-server.json.
function resolve(id, rel) {
  if (typeof rel !== 'string' || !rel || rel.length > 400 || !EDITABLE.test(rel) || SKIP_FILES.has(path.basename(rel).toLowerCase())) throw new Error(t('servers.errFile'));
  const root = path.resolve(servers.dir(id));
  const full = path.resolve(root, ...rel.split(/[\\/]+/));
  if (!full.startsWith(root + path.sep)) throw new Error(t('servers.errFile'));
  return full;
}

async function read(id, rel) {
  await servers.get(id);
  const full = resolve(id, rel);
  const st = await fsp.stat(full).catch(() => null);
  if (!st?.isFile()) throw new Error(t('servers.errFile'));
  if (st.size > MAX_SIZE) throw new Error(t('servers.errFileBig'));
  return { path: rel, text: await fsp.readFile(full, 'utf8'), mtime: st.mtimeMs };
}

async function write(id, rel, text) {
  await servers.get(id);
  const full = resolve(id, rel);
  const body = String(text ?? '');
  if (Buffer.byteLength(body) > MAX_SIZE) throw new Error(t('servers.errFileBig'));
  if (/\.json$/i.test(rel)) {
    try {
      JSON.parse(body);
    } catch (err) {
      throw new Error(t('servers.errJson', { error: err.message }));
    }
  }
  await fsp.copyFile(full, `${full}.venus-bak`).catch(() => {});
  const tmp = `${full}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, body, 'utf8');
  await fsp.rename(tmp, full);
  return { path: rel, mtime: Date.now() };
}

module.exports = { list, read, write };
