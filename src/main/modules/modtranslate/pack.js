'use strict';
// Paquete de recursos con las traducciones: <instancia>/resourcepacks/venus-auto-translations/
//   pack.mcmeta (formato correcto para la version), pack.png, LEEME.txt y assets/<ns>/lang/<idioma>.json
//   (o .lang en 1.12 y anteriores). Tambien arma el .zip para compartir.
const fsp = require('fs/promises');
const path = require('path');
const { t } = require('../../core/i18n');
const lang = require('./lang');
const { legacyCode } = require('./locales');
const { buildMcmeta } = require('./packformat');
const { NS_OK } = require('./scanner');

const PACK_DIR = 'venus-auto-translations';
const README = 'README.txt';
const ICON = path.join(__dirname, '..', '..', '..', 'renderer', 'assets', 'logo-64.png');

function packDir(instanceDir) {
  return path.join(instanceDir, 'resourcepacks', PACK_DIR);
}

// Id del paquete en options.txt ("file/..." desde 1.13).
function packId(style) {
  return style === 'json' ? `file/${PACK_DIR}` : PACK_DIR;
}

function langFileName(locale, style) {
  if (style === 'json') return `${locale}.json`;
  if (style === 'lang') return `${locale}.lang`;
  return `${legacyCode(locale)}.lang`;
}

// Nunca escribir fuera de la carpeta del paquete (los namespaces vienen de archivos de terceros).
function inside(base, ...parts) {
  const root = path.resolve(base);
  const full = path.resolve(root, ...parts);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(t('modtranslate.errBadPath'));
  return full;
}

async function writeAtomic(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, content);
  await fsp.rename(tmp, file);
}

async function writeIfChanged(file, content) {
  const prev = await fsp.readFile(file, 'utf8').catch(() => null);
  if (prev === content) return false;
  await writeAtomic(file, content);
  return true;
}

// Archivos de idioma de un estado: Map(rutaRelativa -> contenido)
function langFiles(state, { style, allowEscapes = false }) {
  const out = new Map();
  const file = langFileName(state.locale, style);
  for (const [ns, keys] of Object.entries(state.entries || {})) {
    if (!NS_OK.test(ns)) continue;
    const entries = Object.entries(keys)
      .filter(([, e]) => typeof e?.t === 'string' && e.t.length)
      .map(([k, e]) => [k, e.t])
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (!entries.length) continue;
    const content = style === 'json' ? lang.serializeJson(entries) : lang.serializeLang(entries, { allowEscapes });
    out.set(`assets/${ns}/lang/${file}`, content);
  }
  return out;
}

function mcmetaText(fmt) {
  return `${JSON.stringify(buildMcmeta(fmt, t('modtranslate.packDescription')), null, 2)}\n`;
}

function readmeText() {
  return `${t('modtranslate.packReadme')}\n`;
}

// Escribe pack.mcmeta, el icono y el LEEME (sin tocar los archivos de idioma).
async function writeMeta(instanceDir, fmt) {
  const dir = packDir(instanceDir);
  await fsp.mkdir(dir, { recursive: true });
  const changed = await writeIfChanged(path.join(dir, 'pack.mcmeta'), mcmetaText(fmt));
  await writeIfChanged(path.join(dir, README), readmeText());
  const icon = path.join(dir, 'pack.png');
  if (!(await fsp.stat(icon).catch(() => null))) await fsp.copyFile(ICON, icon).catch(() => {});
  return changed;
}

// pack.mcmeta actual (para saber si hay que actualizarlo).
async function readMcmeta(instanceDir) {
  try {
    return await fsp.readFile(path.join(packDir(instanceDir), 'pack.mcmeta'), 'utf8');
  } catch {
    return null;
  }
}

async function exists(instanceDir) {
  return Boolean(await fsp.stat(path.join(packDir(instanceDir), 'pack.mcmeta')).catch(() => null));
}

// Reescribe los archivos de idioma de un idioma (y borra los que ya no tienen textos).
async function writeLocale(instanceDir, state, { fmt, allowEscapes = false }) {
  const dir = packDir(instanceDir);
  await writeMeta(instanceDir, fmt);
  const files = langFiles(state, { style: fmt.style, allowEscapes });
  for (const [rel, content] of files) await writeIfChanged(inside(dir, ...rel.split('/')), content);
  // Limpieza: archivos de este idioma que sobran
  const file = langFileName(state.locale, fmt.style);
  const assets = path.join(dir, 'assets');
  for (const ns of await fsp.readdir(assets).catch(() => [])) {
    const rel = `assets/${ns}/lang/${file}`;
    if (files.has(rel)) continue;
    const target = inside(dir, 'assets', ns, 'lang', file);
    if (await fsp.stat(target).catch(() => null)) await fsp.rm(target, { force: true });
    // Carpetas que quedaron vacias
    const langDir = path.dirname(target);
    if (!(await fsp.readdir(langDir).catch(() => ['x'])).length) await fsp.rmdir(langDir).catch(() => {});
    const nsDir = path.dirname(langDir);
    if (!(await fsp.readdir(nsDir).catch(() => ['x'])).length) await fsp.rmdir(nsDir).catch(() => {});
  }
  return files.size;
}

// ¿Quedan archivos de idioma en el paquete?
async function hasLangFiles(instanceDir) {
  const assets = path.join(packDir(instanceDir), 'assets');
  for (const ns of await fsp.readdir(assets).catch(() => [])) {
    if ((await fsp.readdir(path.join(assets, ns, 'lang')).catch(() => [])).length) return true;
  }
  return false;
}

// .zip listo para usar en cualquier launcher (para compartir).
function buildZip(states, { fmt, allowEscapes = false }) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('pack.mcmeta', Buffer.from(mcmetaText(fmt), 'utf8'));
  zip.addFile(README, Buffer.from(readmeText(), 'utf8'));
  try {
    zip.addFile('pack.png', require('fs').readFileSync(ICON));
  } catch {
    /* sin icono */
  }
  for (const state of states) {
    for (const [rel, content] of langFiles(state, { style: fmt.style, allowEscapes })) zip.addFile(rel, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

module.exports = { PACK_DIR, packDir, packId, langFileName, writeMeta, readMcmeta, writeLocale, hasLangFiles, exists, buildZip, mcmetaText, inside };
