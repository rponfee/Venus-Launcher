'use strict';
// Paquete de recursos "Venus Launcher" que el launcher activa en cada instancia antes de jugar (1.13 en adelante):
//   - pantalla de carga con el logo de Venus en lugar del de Mojang Studios (textures/gui/title/mojangstudios.png)
//   - "VENUS LAUNCHER" debajo del logo de Minecraft, donde dice "Java Edition" (textures/gui/title/edition.png)
//   - frases de Venus en el menu principal, sumadas a las del juego (texts/splashes.txt)
// Va con la prioridad mas baja entre los paquetes del jugador: si activa otro que cambia lo mismo, gana el suyo.
// Las imagenes se generan con scripts/make-ingame-assets.py.
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const packformat = require('../modtranslate/packformat');
const options = require('../modtranslate/options');
const { ZipReader } = require('../modtranslate/zip');

const PACK_DIR = 'venus-launcher';
const PACK_ID = `file/${PACK_DIR}`;
const ASSETS = path.join(__dirname, 'assets');
const STAMP = '.venus-pack';
const TEXTURES = [
  ['mojangstudios.png', 'assets/minecraft/textures/gui/title/mojangstudios.png'],
  ['edition.png', 'assets/minecraft/textures/gui/title/edition.png'],
];
const SPLASHES = 'assets/minecraft/texts/splashes.txt';
const VENUS_SHARE = 0.25; // parte de las frases del menu que son de Venus

const packDir = (instanceDir) => path.join(instanceDir, 'resourcepacks', PACK_DIR);

// Frases del juego que trae el jar (null si no se pueden leer).
async function vanillaSplashes(jarPath) {
  if (!jarPath) return null;
  let zip = null;
  try {
    zip = await ZipReader.open(jarPath);
    const entry = zip.get(SPLASHES);
    if (!entry) return null;
    return (await zip.read(entry)).toString('utf8');
  } catch {
    return null;
  } finally {
    if (zip) await zip.close().catch(() => {});
  }
}

// Frases del juego + las de Venus, repetidas para que salgan mas o menos una de cada cuatro veces.
function mergeSplashes(vanillaText, venusLines) {
  const own = (venusLines || []).map((l) => String(l).trim()).filter(Boolean);
  const base = String(vanillaText || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim());
  if (!own.length) return base.length ? `${base.join('\n')}\n` : null;
  const times = base.length ? Math.max(1, Math.round((base.length * VENUS_SHARE) / (own.length * (1 - VENUS_SHARE)))) : 1;
  const out = [...base];
  for (let i = 0; i < times; i++) out.push(...own);
  return `${out.join('\n')}\n`;
}

// Archivos del paquete: { 'ruta/relativa': Buffer }
async function buildFiles({ fmt, description, splashes, vanillaText }) {
  const files = {};
  files['pack.mcmeta'] = Buffer.from(`${JSON.stringify(packformat.buildMcmeta(fmt, description), null, 2)}\n`);
  files['pack.png'] = await fsp.readFile(path.join(ASSETS, 'pack.png'));
  for (const [src, dest] of TEXTURES) files[dest] = await fsp.readFile(path.join(ASSETS, src));
  // Sin las frases del juego (jar ilegible) no se pisan: el menu quedaria solo con las de Venus.
  const text = vanillaText ? mergeSplashes(vanillaText, splashes) : null;
  if (text) files[SPLASHES] = Buffer.from(text, 'utf8');
  return files;
}

function digest(files) {
  const h = crypto.createHash('sha1');
  for (const name of Object.keys(files).sort()) h.update(name).update('\0').update(files[name]).update('\0');
  return h.digest('hex');
}

async function readText(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function writeAtomic(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, content);
  await fsp.rename(tmp, file);
}

// Escribe el paquete solo si cambio algo (version del juego, idioma de las frases o imagenes nuevas).
async function writePack(dir, files) {
  const sum = digest(files);
  if ((await readText(path.join(dir, STAMP))) === sum) return false;
  await fsp.rm(dir, { recursive: true, force: true });
  for (const [name, buf] of Object.entries(files)) {
    const full = path.join(dir, ...name.split('/'));
    await fsp.mkdir(path.dirname(full), { recursive: true });
    await fsp.writeFile(full, buf);
  }
  await fsp.writeFile(path.join(dir, STAMP), sum);
  return true;
}

async function setEnabled(instanceDir, enable, { incompatible = false } = {}) {
  const file = path.join(instanceDir, 'options.txt');
  const text = await readText(file);
  const res = options.mergePack(text, { id: PACK_ID, enable, incompatible });
  if (res.changed) await writeAtomic(file, res.text);
  return res.changed;
}

/**
 * Deja el paquete listo y activo en la instancia, o lo quita si esta apagado.
 * opts: { instanceDir, mcVersion, jarPath, enabled, description, splashes: [frase...] }
 * Devuelve { state: 'applied'|'removed'|'unsupported'|'off', written? }.
 */
async function apply({ instanceDir, mcVersion, jarPath, enabled = true, description = 'Venus Launcher', splashes = [] }) {
  const dir = packDir(instanceDir);
  if (!enabled) {
    const had = await fsp.stat(dir).then(() => true, () => false);
    const changed = await setEnabled(instanceDir, false);
    if (had) await fsp.rm(dir, { recursive: true, force: true });
    return { state: had || changed ? 'removed' : 'off' };
  }
  // Los ids "file/..." en options.txt existen desde la 1.13; antes los paquetes tenian otro formato.
  if (packformat.langStyle(mcVersion) !== 'json') return { state: 'unsupported' };
  const fmt = await packformat.resolveFormat(mcVersion, jarPath);
  if (!fmt) return { state: 'unsupported' };
  const vanillaText = await vanillaSplashes(jarPath);
  const files = await buildFiles({ fmt, description, splashes, vanillaText });
  const written = await writePack(dir, files);
  await setEnabled(instanceDir, true, { incompatible: !fmt.certain });
  return { state: 'applied', written };
}

module.exports = { apply, mergeSplashes, buildFiles, packDir, PACK_ID, PACK_DIR };
