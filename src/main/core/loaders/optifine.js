'use strict';
// OptiFine: lista todas las versiones desde optifine.net, descarga el jar oficial
// y lo instala como version standalone (igual que su instalador) o como mod para Forge.
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const paths = require('../paths');
const http = require('../http');
const minecraft = require('../minecraft');
const java = require('../java');
const { t } = require('../i18n');
const { exists, mavenPath, writeJson, readJson } = require('../util');

const BASE = 'https://optifine.net';
const BROWSER_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VenusLauncher' };

// "1.8.0" (nombre de OptiFine) -> "1.8" (id de Minecraft)
function normalizeMc(v) {
  const p = v.split('.');
  return p.length === 3 && p[2] === '0' && p[0] === '1' ? `${p[0]}.${p[1]}` : v;
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim();
}

async function listVersions(force = false) {
  const cacheFile = paths.cache('optifine-versions.json');
  if (!force) {
    try {
      const st = await fsp.stat(cacheFile);
      if (Date.now() - st.mtimeMs < 60 * 60 * 1000) return await readJson(cacheFile);
    } catch {
      /* sin cache */
    }
  }
  let html;
  try {
    html = await http.getText(`${BASE}/downloads`, { headers: BROWSER_UA });
  } catch (err) {
    const cached = await readJson(cacheFile, null);
    if (cached) return cached;
    throw err;
  }
  const out = [];
  const sections = html.split(/<h2>Minecraft /).slice(1);
  for (const sec of sections) {
    const mcRaw = sec.slice(0, sec.indexOf('</h2>')).trim();
    const rows = sec.split(/<tr class=['"]downloadLine/).slice(1);
    for (const row of rows) {
      const file = (row.match(/adloadx\?f=([^"'&]+)/) || [])[1];
      if (!file) continue;
      const name = decode((row.match(/<td class=['"]colFile['"]>([\s\S]*?)<\/td>/) || [])[1] || file);
      const forge = decode((row.match(/<td class=['"]colForge['"]>([\s\S]*?)<\/td>/) || [])[1] || '');
      const date = decode((row.match(/<td class=['"]colDate['"]>([\s\S]*?)<\/td>/) || [])[1] || '');
      const preview = file.startsWith('preview_');
      const m = file.match(/OptiFine_(.+?)_(HD_.+)\.jar$/);
      if (!m) continue;
      if (out.some((o) => o.filename === file)) continue;
      out.push({
        mcVersion: normalizeMc(m[1]),
        mcFileVersion: m[1],
        edition: m[2],
        name,
        filename: file,
        preview,
        forge: forge.replace(/^Forge\s*/, ''),
        date,
        mcLabel: mcRaw,
      });
    }
  }
  if (!out.length) throw new Error(t('loaders.errOptifineList'));
  await writeJson(cacheFile, out).catch(() => {});
  return out;
}

async function downloadJar(entry, dest, task) {
  if (await exists(dest)) return dest;
  task?.update({ detail: t('loaders.downloadingFile', { name: entry.filename }), progress: null });
  try {
    const page = await http.getText(`${BASE}/adloadx?f=${encodeURIComponent(entry.filename)}`, { headers: BROWSER_UA });
    const link = (page.match(/href=['"](downloadx\?f=[^'"]+)['"]/) || [])[1];
    if (!link) throw new Error(t('loaders.errOptifineLink'));
    await http.download({ url: `${BASE}/${link.replace(/&amp;/g, '&')}`, path: dest }, { signal: task?.signal });
  } catch (err) {
    // Respaldo: mirror BMCLAPI (solo versiones estables)
    const m = entry.edition.match(/^(HD_U|HD)_(\w+)$/);
    if (entry.preview || !m) throw new Error(t('loaders.errOptifineDownload', { error: err.message }));
    await http.download(
      { url: `https://bmclapi2.bangbang93.com/optifine/${entry.mcFileVersion}/${m[1]}/${m[2]}`, path: dest },
      { signal: task?.signal },
    );
  }
  return dest;
}

function runPatcher(javaExe, ofJar, vanillaJar, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaExe, ['-cp', ofJar, 'optifine.Patcher', vanillaJar, ofJar, output], { windowsHide: true });
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(t('loaders.errOptifinePatch', { log: log.slice(-800) })))));
  });
}

async function findEntry(mcVersion, edition) {
  const list = await listVersions();
  const entry = list.find((e) => e.mcVersion === mcVersion && (!edition || edition === 'latest' || e.edition === edition));
  if (!entry) {
    if (edition && edition !== 'latest') throw new Error(t('loaders.errOptifineEdition', { edition: edition.replace(/_/g, ' '), mc: mcVersion }));
    throw new Error(t('loaders.errOptifineMissing', { mc: mcVersion }));
  }
  return entry;
}

// Instala OptiFine como version propia: "<mc>-OptiFine_<edicion>"
async function install(mcVersion, edition, task) {
  const entry = await findEntry(mcVersion, edition);
  task?.update({ detail: t('loaders.installingMinecraft', { mc: mcVersion }), progress: 0 });
  const vanilla = await minecraft.installVersion(mcVersion, task);
  const javaPath = await java.ensureRuntime(vanilla.javaVersion.component, vanilla.javaVersion.majorVersion, task);

  const ofJar = paths.cache('optifine', entry.filename);
  await downloadJar(entry, ofJar, task);

  const libName = `optifine:OptiFine:${entry.mcFileVersion}_${entry.edition}`;
  const libPath = paths.library(mavenPath(libName));
  await fsp.mkdir(path.dirname(libPath), { recursive: true });
  const zip = new AdmZip(ofJar);
  task?.update({ detail: t('loaders.patchingOptifine'), progress: null });
  if (zip.getEntry('optifine/Patcher.class')) {
    await runPatcher(java.toConsoleJava(javaPath), ofJar, minecraft.clientJarPath(vanilla), libPath);
  } else {
    await fsp.copyFile(ofJar, libPath);
  }

  const libraries = [{ name: libName }];
  const lwTxt = zip.getEntry('launchwrapper-of.txt');
  let hasWrapper = false;
  if (lwTxt) {
    const lwVer = zip.readAsText(lwTxt).trim();
    const lwEntry = zip.getEntry(`launchwrapper-of-${lwVer}.jar`);
    if (lwEntry) {
      const name = `optifine:launchwrapper-of:${lwVer}`;
      const dest = paths.library(mavenPath(name));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, lwEntry.getData());
      libraries.push({ name });
      hasWrapper = true;
    }
  }
  if (!hasWrapper && zip.getEntry('launchwrapper-2.0.jar')) {
    const name = 'optifine:launchwrapper:2.0';
    const dest = paths.library(mavenPath(name));
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, zip.getEntry('launchwrapper-2.0.jar').getData());
    libraries.push({ name });
    hasWrapper = true;
  }
  if (!hasWrapper) libraries.push({ name: 'net.minecraft:launchwrapper:1.12' });

  const root = await minecraft.getVersionJson(mcVersion);
  const now = new Date().toISOString();
  const id = `${mcVersion}-OptiFine_${entry.edition}`;
  const json = {
    id,
    inheritsFrom: mcVersion,
    time: now,
    releaseTime: now,
    type: 'release',
    libraries,
    mainClass: 'net.minecraft.launchwrapper.Launch',
  };
  if (root.arguments) json.arguments = { game: ['--tweakClass', 'optifine.OptiFineTweaker'] };
  else json.minecraftArguments = `${root.minecraftArguments} --tweakClass optifine.OptiFineTweaker`;
  await minecraft.saveVersionJson(json);
  return { versionId: id, loaderVersion: entry.edition };
}

// Para instancias Forge: OptiFine se usa como un mod mas.
async function installAsMod(mcVersion, edition, modsDir, task) {
  const entry = await findEntry(mcVersion, edition);
  const cached = paths.cache('optifine', entry.filename);
  await downloadJar(entry, cached, task);
  await fsp.mkdir(modsDir, { recursive: true });
  const dest = path.join(modsDir, entry.filename.replace(/^preview_/, ''));
  await fsp.copyFile(cached, dest);
  return { file: path.basename(dest), entry };
}

module.exports = { listVersions, install, installAsMod, normalizeMc };
