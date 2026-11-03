'use strict';
// Mod "Venus Badge" (mod/venus-badge): el planeta de Venus junto al nombre de los jugadores que activaron la insignia.
// El launcher copia en mods/ el .jar del loader y la version de Minecraft de la instancia (un .jar no carga en otro loader
// ni en otra version), y lo quita al apagar la insignia o si la instancia deja de ser compatible. Vanilla, OptiFine y las
// versiones sin compilacion no pueden cargarlo: ahi no se instala nada.
// Los .jar los compila .github/workflows/build.yml (mod/venus-badge) y van empaquetados en ingame/mods; sin
// compilarlos (desarrollo), la insignia no se instala y el resto del launcher sigue igual.
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { compareSemver } = require('../../core/util');

// Una entrada por compilacion del mod (Quilt carga los mods de Fabric). Para sumar una: docs/insignia.md.
// minLoader: los .jar de Fabric traen adentro el modulo de recursos de Fabric API y, con un loader mas viejo que el que ese
// modulo pide, el juego no arranca. Ahi no se instala: la insignia no puede romper una instancia que andaba.
const BUILDS = [
  { jar: 'venus-badge-mc1.21.1-fabric.jar', loaders: ['fabric', 'quilt'], minLoader: { fabric: '0.15.11', quilt: '0.26.0' }, mc: ['1.21', '1.21.1'] },
  { jar: 'venus-badge-mc1.20.1-fabric.jar', loaders: ['fabric', 'quilt'], minLoader: { fabric: '0.14.21', quilt: '0.19.0' }, mc: ['1.20.1'] },
  { jar: 'venus-badge-mc1.21.1-neoforge.jar', loaders: ['neoforge'], mc: ['1.21', '1.21.1'] },
  { jar: 'venus-badge-mc1.20.1-forge.jar', loaders: ['forge'], mc: ['1.20.1'] },
];
const MOD_FILE = 'venus-badge.jar';
const CONFIG_FILE = 'venus-badge.json';
const BUNDLED_DIR = path.join(__dirname, 'mods');

function buildFor(loader, mcVersion, loaderVersion) {
  const build = BUILDS.find((b) => b.loaders.includes(loader) && b.mc.includes(String(mcVersion)));
  const min = build?.minLoader?.[loader];
  // 'latest' o sin dato: la instancia usa el mas nuevo, que sirve.
  if (min && /^\d/.test(String(loaderVersion)) && compareSemver(loaderVersion, min) < 0) return null;
  return build || null;
}

// Versiones de Minecraft con mod en algun loader, sin repetir.
function supportedVersions() {
  return [...new Set(BUILDS.flatMap((b) => b.mc))].sort();
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
 * opts: { instanceDir, loader, loaderVersion?, mcVersion, enabled, server: { url, anonKey }, bundledDir? }
 * Devuelve { state: 'installed'|'removed'|'off'|'unsupported'|'missing'|'userDisabled', written? }
 *   - unsupported: la instancia no puede cargarlo (loader o version); si estaba, se quito.
 *   - missing: este launcher no trae el jar (compilacion de desarrollo).
 *   - userDisabled: el jugador lo desactivo desde la lista de mods (venus-badge.jar.disabled): no se toca.
 */
async function apply({ instanceDir, loader, loaderVersion, mcVersion, enabled, server, bundledDir = BUNDLED_DIR }) {
  const build = buildFor(loader, mcVersion, loaderVersion);
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
