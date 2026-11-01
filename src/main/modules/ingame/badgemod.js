'use strict';
// Mod "Venus Badge" (mod/venus-badge): el planeta de Venus junto al nombre de los jugadores que activaron la insignia.
// El launcher lo copia en mods/ de las instancias Fabric (o Quilt, que carga mods de Fabric) de una version de
// Minecraft para la que hay compilacion, y lo quita al apagar la insignia o si la instancia deja de ser compatible.
// Vanilla, Forge, NeoForge y OptiFine no pueden cargarlo: ahi no se instala nada.
// Los .jar los compila .github/workflows/build.yml (mod/venus-badge) y van empaquetados en ingame/mods; sin
// compilarlos (desarrollo), la insignia no se instala y el resto del launcher sigue igual.
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// Una entrada por compilacion del mod. Para sumar una version: otra compilacion en mod/ y otra fila aca.
const BUILDS = [{ jar: 'venus-badge-mc1.21.1.jar', mc: ['1.21', '1.21.1'] }];
const LOADERS = new Set(['fabric', 'quilt']);
const MOD_FILE = 'venus-badge.jar';
const CONFIG_FILE = 'venus-badge.json';
const BUNDLED_DIR = path.join(__dirname, 'mods');

function buildFor(loader, mcVersion) {
  if (!LOADERS.has(loader)) return null;
  return BUILDS.find((b) => b.mc.includes(String(mcVersion))) || null;
}

// Versiones de Minecraft con mod, para explicarlo en la interfaz ("1.21 y 1.21.1").
function supportedVersions() {
  return BUILDS.flatMap((b) => b.mc);
}

const exists = (file) => fsp.stat(file).then(() => true, () => false);

async function readOrNull(file) {
  try {
    return await fsp.readFile(file);
  } catch {
    return null;
  }
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// Escribe solo si cambio (el jar se compara por contenido) y sin dejar un archivo a medias.
async function writeIfChanged(file, buf) {
  const cur = await readOrNull(file);
  if (cur && cur.length === buf.length && sha1(cur) === sha1(buf)) return false;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, file);
  return true;
}

async function removeMod(instanceDir) {
  const files = [path.join(instanceDir, 'mods', MOD_FILE), path.join(instanceDir, 'config', CONFIG_FILE)];
  let had = false;
  for (const f of files) {
    if (!(await exists(f))) continue;
    had = true;
    await fsp.rm(f, { force: true });
  }
  return had;
}

/**
 * Deja el mod instalado (y su config/venus-badge.json con el servidor) o lo quita.
 * opts: { instanceDir, loader, mcVersion, enabled, server: { url, anonKey }, bundledDir? }
 * Devuelve { state: 'installed'|'removed'|'off'|'unsupported'|'missing'|'userDisabled', written? }
 *   - unsupported: la instancia no puede cargarlo (loader o version); si estaba, se quito.
 *   - missing: este launcher no trae el jar (compilacion de desarrollo).
 *   - userDisabled: el jugador lo desactivo desde la lista de mods (venus-badge.jar.disabled): no se toca.
 */
async function apply({ instanceDir, loader, mcVersion, enabled, server, bundledDir = BUNDLED_DIR }) {
  const build = buildFor(loader, mcVersion);
  if (!enabled || !build) {
    const had = await removeMod(instanceDir);
    if (enabled) return { state: 'unsupported' };
    return { state: had ? 'removed' : 'off' };
  }
  const target = path.join(instanceDir, 'mods', MOD_FILE);
  if (await exists(`${target}.disabled`)) return { state: 'userDisabled' };
  const jar = await readOrNull(path.join(bundledDir, build.jar));
  if (!jar) return { state: 'missing' };
  let written = await writeIfChanged(target, jar);
  if (server?.url && server?.anonKey) {
    const cfg = Buffer.from(`${JSON.stringify({ url: server.url, anonKey: server.anonKey }, null, 2)}\n`);
    written = (await writeIfChanged(path.join(instanceDir, 'config', CONFIG_FILE), cfg)) || written;
  }
  return { state: 'installed', written };
}

// Hay al menos un jar empaquetado (para avisar en la interfaz si esta compilacion no lo trae).
async function bundled(bundledDir = BUNDLED_DIR) {
  for (const b of BUILDS) if (await exists(path.join(bundledDir, b.jar))) return true;
  return false;
}

module.exports = { apply, buildFor, supportedVersions, bundled, BUILDS, MOD_FILE, CONFIG_FILE };
