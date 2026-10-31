'use strict';
// Indice de los mods de una instancia: lee los metadatos de cada .jar (Fabric, Quilt, Forge, NeoForge y
// Forge viejo) para saber ids, nombres, versiones, dependencias, configs de mixins y los paquetes de
// clases de cada archivo (asi un "at paquete.Clase" de un crash se puede atribuir a un mod).
// Sin Electron: se puede probar con Node puro.
const fsp = require('fs/promises');
const path = require('path');
const { openZipFile, openZipBuffer } = require('./zip');
const toml = require('./toml');

const CACHE_VERSION = 3;
// x.jar | x.jar.disabled | x.jar.bisect.disabled (renombre de respaldo de la busqueda del culpable)
const MOD_FILE = /^(.+\.(?:jar|zip|litemod))((?:\.bisect(?:-\d+)?)?\.disabled)?$/i;

// Ids que provee el entorno (juego, loader, Java): nunca son mods del usuario ni dependencias a resolver.
const ENV_IDS = new Set([
  'minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt-loader', 'quilted_fabric_loader',
  'forge', 'neoforge', 'fml', 'javafml', 'lowcodefml', 'mcp', 'minecraftforge', 'mixinextras', 'mixin', 'jdk',
]);

// Librerias conocidas (las usan muchos mods; se mantienen activas cuando hacen falta).
const KNOWN_LIBS = new Set([
  'fabric-api', 'fabric', 'fabric-language-kotlin', 'kotlinforforge', 'kotlinlangforge', 'cloth-config', 'cloth-config2',
  'cloth_config', 'architectury', 'geckolib', 'geckolib3', 'owo', 'owo-lib', 'yet_another_config_lib_v3', 'yacl',
  'forgeconfigapiport', 'puzzleslib', 'balm', 'iceberg', 'resourcefullib', 'terrablender', 'citadel', 'bookshelf',
  'collective', 'moonlight', 'playeranimator', 'player-animator', 'trinkets', 'curios', 'cardinal-components',
  'cardinal-components-base', 'lithostitched', 'ftblibrary', 'framework', 'creativecore', 'prism', 'libipn', 'azurelib',
  'blueprint', 'fzzy_config', 'supermartijn642corelib', 'supermartijn642configlib', 'cupboard', 'coroutil', 'zeta',
  'autoreglib', 'placebo', 'patchouli', 'midnightlib', 'jamlib', 'konkrete', 'melody', 'searchables', 'sinytra_connector',
  'connectormod', 'forgified-fabric-api', 'fabric_api', 'yungsapi', 'cristellib', 'libraryferret', 'fusion', 'monolib',
  'polymorph', 'kambrik', 'necronomicon', 'carbonconfig', 'shetiphiancore', 'cobalt', 'ctm', 'fabric-permissions-api-v0',
]);

// Paquetes del juego, del loader y de librerias comunes: un frame ahi no culpa a ningun mod.
const PLATFORM_PREFIXES = [
  'java.', 'javax.', 'jdk.', 'sun.', 'com.sun.', 'kotlin.', 'kotlinx.', 'scala.', 'groovy.', 'com.google.', 'org.apache.',
  'io.netty.', 'it.unimi.', 'org.lwjgl.', 'com.mojang.', 'net.minecraft.', 'net.minecraftforge.', 'net.neoforged.',
  'cpw.mods.', 'net.fabricmc.loader.', 'net.fabricmc.api.', 'net.fabricmc.mapping', 'net.fabricmc.tinyremapper.',
  'net.fabricmc.accesswidener.', 'org.quiltmc.loader.', 'org.spongepowered.', 'com.llamalad7.mixinextras.',
  'org.objectweb.asm.', 'org.slf4j.', 'org.joml.', 'com.electronwill.nightconfig.', 'org.jetbrains.', 'org.intellij.',
  'com.ibm.icu.', 'oshi.', 'org.openjdk.', 'com.github.benmanes.caffeine.', 'org.yaml.', 'com.fasterxml.',
  'org.checkerframework.', 'javassist.', 'net.jodah.', 'paulscode.', 'net.java.', 'io.github.classgraph.', 'org.antlr.',
  'com.typesafe.', 'org.codehaus.', 'org.json.', 'org.tukaani.', 'com.jcraft.', 'joptsimple.', 'org.mozilla.',
  'org.burningwave.', 'org.lzma.', 'net.sf.', 'org.ow2.', 'org.jline.', 'org.fusesource.', 'org.jctools.',
  'com.machinezoo.', 'org.reflections.', 'org.jspecify.', 'org.graalvm.', 'org.openzen.', 'manifold.',
];

function isPlatformClass(cls) {
  const c = `${cls}`;
  return !c.includes('.') || PLATFORM_PREFIXES.some((p) => c.startsWith(p));
}

// ---------- Utilidades de formato ----------

// JSON tolerante: fabric.mod.json a veces trae comentarios, comas finales o saltos de linea en strings.
function lenientJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* sigue abajo */
  }
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      else if (c === '\n' || c === '\r') {
        out += '\\n';
        continue;
      } else if (c === '\t') {
        out += '\\t';
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// Atributos principales de META-INF/MANIFEST.MF (hasta la primera linea en blanco).
function parseManifest(text) {
  const out = {};
  if (!text) return out;
  let last = null;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) break;
    if (raw.startsWith(' ') && last) {
      out[last] += raw.slice(1);
      continue;
    }
    const m = raw.match(/^([A-Za-z0-9_-]+):\s?(.*)$/);
    if (m) {
      last = m[1];
      out[last] = m[2].trim();
    } else last = null;
  }
  return out;
}

const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

function cleanVersion(v, jarVersion) {
  let s = String(v ?? '').trim();
  if (!s || /^\$\{file\.jarVersion\}$/.test(s)) s = jarVersion || '';
  if (/^\$\{/.test(s)) s = jarVersion || '';
  return s;
}

// ---------- Lectores de metadatos ----------

function readFabric(text) {
  const j = lenientJson(text);
  if (!j || typeof j !== 'object' || !j.id) return null;
  const deps = (obj) =>
    Object.entries(obj && typeof obj === 'object' ? obj : {}).map(([id, v]) => ({
      id: String(id),
      range: Array.isArray(v) ? v.map(String).join(' || ') : String(v ?? '*'),
    }));
  const badges = asList(j.custom?.modmenu?.badges).map(String);
  return {
    loader: 'fabric',
    mods: [{ id: String(j.id), name: String(j.name || j.id), version: String(j.version ?? '') }],
    depends: deps(j.depends),
    breaks: deps(j.breaks),
    provides: asList(j.provides).filter((p) => typeof p === 'string'),
    mixins: asList(j.mixins).map((m) => (typeof m === 'string' ? m : m?.config)).filter(Boolean),
    environment: typeof j.environment === 'string' ? j.environment : '*',
    library: badges.includes('library') || Boolean(j.custom?.['fabric-loom:generated']),
    parent: typeof j.custom?.modmenu?.parent === 'string' ? j.custom.modmenu.parent : j.custom?.modmenu?.parent?.id || null,
  };
}

function readQuilt(text) {
  const j = lenientJson(text);
  const ql = j?.quilt_loader;
  if (!ql || !ql.id) return null;
  const deps = (list) =>
    asList(list)
      .map((d) => {
        if (typeof d === 'string') return { id: d.split('@')[0], range: '*' };
        if (Array.isArray(d)) return null; // "cualquiera de": no se puede resolver de forma estricta
        if (!d || !d.id || d.optional) return null;
        return { id: String(d.id).split(':').pop(), range: Array.isArray(d.versions) ? d.versions.join(' || ') : String(d.versions ?? '*') };
      })
      .filter(Boolean);
  const badges = asList(ql.metadata?.badges).map(String);
  return {
    loader: 'quilt',
    mods: [{ id: String(ql.id), name: String(ql.metadata?.name || ql.id), version: String(ql.version ?? '') }],
    depends: deps(ql.depends),
    breaks: deps(ql.breaks),
    provides: asList(ql.provides).map((p) => (typeof p === 'string' ? p : p?.id)).filter(Boolean),
    mixins: asList(j.mixin).filter((m) => typeof m === 'string'),
    environment: j.minecraft?.environment || '*',
    library: badges.includes('library'),
  };
}

function readModsToml(text, jarVersion, fileKind) {
  let doc;
  try {
    doc = toml.parse(text);
  } catch {
    return null;
  }
  const list = asList(doc.mods).filter((m) => m && typeof m === 'object' && m.modId);
  if (!list.length) return null;
  const depends = [];
  const breaks = [];
  let wantsNeo = fileKind === 'neoforge';
  let wantsForge = false;
  const table = doc.dependencies && typeof doc.dependencies === 'object' ? doc.dependencies : {};
  for (const [owner, raw] of Object.entries(table)) {
    for (const d of asList(raw)) {
      if (!d || typeof d !== 'object' || !d.modId) continue;
      const id = String(d.modId);
      if (id === 'neoforge') wantsNeo = true;
      if (id === 'forge') wantsForge = true;
      const range = String(d.versionRange ?? '*');
      const type = String(d.type ?? '').toLowerCase();
      if (type === 'incompatible' || type === 'discouraged') {
        breaks.push({ id, range, owner });
        continue;
      }
      const required = type ? type === 'required' : !(d.mandatory === false || String(d.mandatory).toLowerCase() === 'false');
      const side = String(d.side ?? 'BOTH').toUpperCase();
      if (!required || side === 'SERVER') continue;
      depends.push({ id, range, owner });
    }
  }
  const loader = wantsNeo ? 'neoforge' : 'forge';
  return {
    loader,
    wantsForge,
    mods: list.map((m) => ({ id: String(m.modId), name: String(m.displayName || m.modId), version: cleanVersion(m.version, jarVersion) })),
    depends,
    breaks,
    provides: [],
    mixins: asList(doc.mixins).map((m) => m?.config).filter(Boolean),
    modLoader: String(doc.modLoader || ''),
  };
}

function readMcmod(text) {
  const j = lenientJson(text);
  const list = Array.isArray(j) ? j : Array.isArray(j?.modList) ? j.modList : [];
  const mods = list.filter((m) => m && m.modid);
  if (!mods.length) return null;
  const depends = [];
  for (const m of mods) {
    for (const d of [...asList(m.requiredMods), ...asList(m.dependencies)]) {
      if (typeof d !== 'string') continue;
      const id = d.split('@')[0].trim().toLowerCase();
      if (id) depends.push({ id, range: d.includes('@') ? d.slice(d.indexOf('@') + 1) : '*' });
    }
  }
  return {
    loader: 'legacyforge',
    mods: mods.map((m) => ({ id: String(m.modid).toLowerCase(), name: String(m.name || m.modid), version: String(m.version ?? '') })),
    depends,
    breaks: [],
    provides: [],
    mixins: [],
  };
}

// Paquetes "raiz" de las clases de un jar (sin los que ya cubre un paquete padre del mismo jar).
function packageRoots(entries, limit = 300) {
  const pkgs = new Set();
  for (const e of entries) {
    let name = e.name;
    if (!name.endsWith('.class')) continue;
    name = name.replace(/^META-INF\/versions\/\d+\//, '');
    if (name.startsWith('META-INF/')) continue;
    const slash = name.lastIndexOf('/');
    if (slash <= 0) continue;
    const pkg = name.slice(0, slash).replace(/\//g, '.');
    if (isPlatformClass(`${pkg}.X`) || pkg.split('.').length < 2) continue;
    pkgs.add(pkg);
  }
  const sorted = [...pkgs].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const roots = new Set();
  for (const p of sorted) {
    let anc = p;
    let covered = false;
    while (anc.includes('.')) {
      anc = anc.slice(0, anc.lastIndexOf('.'));
      if (roots.has(anc)) {
        covered = true;
        break;
      }
    }
    if (!covered) roots.add(p);
    if (roots.size >= limit) break;
  }
  return [...roots];
}

// Describe un jar ya abierto (tambien sirve para jars anidados).
async function describeZip(zip, depth = 0) {
  const names = zip.entries.map((e) => e.name);
  const has = (n) => Boolean(zip.get(n));
  const [fmj, qmj, nmt, mt, mcmod, mf] = await Promise.all([
    has('fabric.mod.json') ? zip.readText('fabric.mod.json') : null,
    has('quilt.mod.json') ? zip.readText('quilt.mod.json') : null,
    has('META-INF/neoforge.mods.toml') ? zip.readText('META-INF/neoforge.mods.toml') : null,
    has('META-INF/mods.toml') ? zip.readText('META-INF/mods.toml') : null,
    has('mcmod.info') ? zip.readText('mcmod.info') : null,
    has('META-INF/MANIFEST.MF') ? zip.readText('META-INF/MANIFEST.MF') : null,
  ]);
  const manifest = parseManifest(mf);
  const jarVersion = manifest['Implementation-Version'] || manifest['Specification-Version'] || '';
  const info = {
    loaders: [],
    mods: [],
    depends: [],
    breaks: [],
    provides: [],
    mixins: [],
    environment: '*',
    library: false,
    wantsForge: false,
    packages: [],
    nestedPackages: [],
    nested: [],
  };
  const merge = (meta) => {
    if (!meta) return;
    if (!info.loaders.includes(meta.loader)) info.loaders.push(meta.loader);
    for (const m of meta.mods) if (!info.mods.some((x) => x.id === m.id)) info.mods.push(m);
    info.depends.push(...meta.depends);
    info.breaks.push(...meta.breaks);
    info.provides.push(...meta.provides);
    info.mixins.push(...meta.mixins);
    if (meta.library) info.library = true;
    if (meta.wantsForge) info.wantsForge = true;
    if (meta.environment && meta.environment !== '*') info.environment = meta.environment;
  };
  merge(fmj ? readFabric(fmj) : null);
  merge(qmj ? readQuilt(qmj) : null);
  merge(nmt ? readModsToml(nmt, jarVersion, 'neoforge') : null);
  merge(mt ? readModsToml(mt, jarVersion, 'forge') : null);
  merge(mcmod ? readMcmod(mcmod) : null);
  for (const c of String(manifest.MixinConfigs || '').split(',').map((s) => s.trim()).filter(Boolean)) info.mixins.push(c);
  if (!info.loaders.length && (manifest.FMLCorePlugin || manifest.TweakClass)) info.loaders.push('legacyforge');
  if (/^(GAME)?LIBRARY$/i.test(manifest.FMLModType || '')) info.library = true;
  if (info.mods.some((m) => KNOWN_LIBS.has(m.id))) info.library = true;
  if (!info.mods.length && manifest['Implementation-Title']) info.title = manifest['Implementation-Title'];
  info.jarVersion = jarVersion;
  info.packages = packageRoots(zip.entries);
  info.mixins = [...new Set(info.mixins)];

  // Jars anidados (jar-in-jar de Fabric y Forge): proveen ids y traen paquetes propios
  if (depth === 0) {
    let budget = 96 * 1024 * 1024;
    const nested = zip.entries.filter((e) => /^META-INF\/(jars|jarjar)\/.+\.jar$/i.test(e.name) && e.size < 24 * 1024 * 1024);
    for (const e of nested) {
      if (budget <= 0) break;
      budget -= e.size;
      try {
        const buf = await zip.read(e);
        const inner = await openZipBuffer(buf);
        try {
          const sub = await describeZip(inner, depth + 1);
          const ids = sub.mods.map((m) => m.id);
          info.nested.push({ file: path.posix.basename(e.name), ids, version: sub.mods[0]?.version || sub.jarVersion || '' });
          info.provides.push(...ids, ...sub.provides);
          info.nestedPackages.push(...sub.packages);
          info.mixins.push(...sub.mixins.map((m) => `nested:${m}`));
        } finally {
          await inner.close();
        }
      } catch {
        /* jar anidado ilegible: se ignora */
      }
    }
    info.nestedPackages = [...new Set(info.nestedPackages)].slice(0, 600);
  }
  void names;
  // No contar como dependencia lo que el propio jar provee
  const own = new Set([...info.mods.map((m) => m.id), ...info.provides]);
  const seen = new Set();
  info.depends = info.depends.filter((d) => {
    if (own.has(d.id) || ENV_IDS.has(d.id) || seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });
  info.provides = [...new Set(info.provides)].filter((p) => !info.mods.some((m) => m.id === p));
  return info;
}

async function readJar(file) {
  const zip = await openZipFile(file);
  try {
    return await describeZip(zip, 0);
  } finally {
    await zip.close();
  }
}

// ---------- Escaneo de la carpeta mods ----------

async function loadCache(cacheFile) {
  if (!cacheFile) return { v: CACHE_VERSION, entries: {} };
  try {
    const data = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
    if (data?.v === CACHE_VERSION && data.entries) return data;
  } catch {
    /* sin cache */
  }
  return { v: CACHE_VERSION, entries: {} };
}

async function saveCache(cacheFile, cache) {
  if (!cacheFile) return;
  const now = Date.now();
  const keys = Object.keys(cache.entries);
  // Podar entradas viejas para que el cache no crezca sin limite
  if (keys.length > 4000) {
    keys.sort((a, b) => (cache.entries[a].seen || 0) - (cache.entries[b].seen || 0));
    for (const k of keys.slice(0, keys.length - 3000)) delete cache.entries[k];
  }
  for (const [k, e] of Object.entries(cache.entries)) if (now - (e.seen || 0) > 90 * 86400000) delete cache.entries[k];
  try {
    await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(cache));
    await fsp.rename(tmp, cacheFile);
  } catch {
    /* el cache es opcional */
  }
}

/**
 * Lista los mods de una carpeta con sus metadatos.
 * Devuelve [{ file, base, enabled, size, mtime, ids, name, version, loaders, depends, breaks, provides,
 *             mixins, library, packages, nestedPackages, nested, corrupt }]
 */
async function scanMods(modsDir, { cacheFile } = {}) {
  let entries = [];
  try {
    entries = await fsp.readdir(modsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const cache = await loadCache(cacheFile);
  const out = [];
  let dirty = false;
  const files = entries.filter((e) => e.isFile() && MOD_FILE.test(e.name));
  const work = files.map((e) => async () => {
    const m = e.name.match(MOD_FILE);
    const full = path.join(modsDir, e.name);
    const st = await fsp.stat(full).catch(() => null);
    if (!st) return;
    const key = `${m[1].toLowerCase()}|${st.size}|${Math.round(st.mtimeMs)}`;
    let info = cache.entries[key];
    if (!info) {
      try {
        info = await readJar(full);
      } catch {
        info = { corrupt: true, loaders: [], mods: [], depends: [], breaks: [], provides: [], mixins: [], packages: [], nestedPackages: [], nested: [] };
      }
      cache.entries[key] = info;
      dirty = true;
    }
    info.seen = Date.now();
    out.push(toModRecord(e.name, m, st, info));
  });
  // Procesar en tandas para no abrir cientos de archivos a la vez
  for (let i = 0; i < work.length; i += 6) await Promise.all(work.slice(i, i + 6).map((fn) => fn()));
  if (dirty || out.length) await saveCache(cacheFile, cache);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

function prettyFromFile(base) {
  return base
    .replace(/\.(jar|zip|litemod)$/i, '')
    .replace(/[-_+]?(mc)?\d+(\.\d+)+.*$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim() || base;
}

function toModRecord(fileName, match, st, info) {
  const base = match[1];
  const first = info.mods?.[0];
  return {
    file: fileName,
    base,
    enabled: !match[2],
    size: st.size,
    mtime: st.mtimeMs,
    ids: (info.mods || []).map((m) => m.id),
    name: first?.name || info.title || prettyFromFile(base),
    version: first?.version || info.jarVersion || '',
    modsInJar: info.mods || [],
    loaders: info.loaders || [],
    wantsForge: Boolean(info.wantsForge),
    depends: info.depends || [],
    breaks: info.breaks || [],
    provides: info.provides || [],
    mixins: info.mixins || [],
    environment: info.environment || '*',
    library: Boolean(info.library),
    packages: info.packages || [],
    nestedPackages: info.nestedPackages || [],
    nested: info.nested || [],
    corrupt: Boolean(info.corrupt),
  };
}

// ---------- Indices de busqueda ----------

// Indice id de mod -> archivos que lo proveen (primero los que lo tienen como mod principal).
function buildIdIndex(mods) {
  const map = new Map();
  const add = (id, file, primary) => {
    if (!id) return;
    const k = String(id).toLowerCase();
    if (!map.has(k)) map.set(k, []);
    const list = map.get(k);
    if (!list.some((x) => x.file === file)) list.push({ file, primary });
  };
  for (const m of mods) {
    for (const id of m.ids) add(id, m.file, true);
    for (const id of m.provides) add(id, m.file, false);
  }
  for (const list of map.values()) list.sort((a, b) => Number(b.primary) - Number(a.primary));
  return {
    files: (id) => (map.get(String(id || '').toLowerCase()) || []).map((x) => x.file),
    primary: (id) => (map.get(String(id || '').toLowerCase()) || []).find((x) => x.primary)?.file || null,
    has: (id) => map.has(String(id || '').toLowerCase()),
  };
}

// Indice paquete -> archivo. lookup('a.b.c.Clase$Interna') busca el paquete mas largo que coincida.
function buildPackageIndex(mods) {
  const map = new Map();
  const add = (pkg, file, nested) => {
    if (!map.has(pkg)) map.set(pkg, []);
    map.get(pkg).push({ file, nested });
  };
  for (const m of mods) {
    for (const p of m.packages) add(p, m.file, false);
    for (const p of m.nestedPackages) add(p, m.file, true);
  }
  return {
    lookup(cls) {
      const c = String(cls || '');
      if (isPlatformClass(c)) return [];
      let pkg = c.slice(0, c.lastIndexOf('.'));
      while (pkg && pkg.split('.').length >= 2) {
        const owners = map.get(pkg);
        if (owners) {
          const top = owners.filter((o) => !o.nested);
          return [...new Set((top.length ? top : owners).map((o) => o.file))];
        }
        pkg = pkg.includes('.') ? pkg.slice(0, pkg.lastIndexOf('.')) : '';
      }
      return [];
    },
  };
}

// Indice config de mixins -> archivo ("sodium.mixins.json" -> sodium.jar).
function buildMixinIndex(mods) {
  const map = new Map();
  for (const m of mods) {
    for (const raw of m.mixins) {
      const nested = raw.startsWith('nested:');
      const name = (nested ? raw.slice(7) : raw).split('/').pop().toLowerCase();
      if (!map.has(name) || !nested) map.set(name, m.file);
    }
  }
  return { lookup: (config) => map.get(String(config || '').split('/').pop().toLowerCase()) || null };
}

module.exports = {
  scanMods,
  readJar,
  describeZip,
  buildIdIndex,
  buildPackageIndex,
  buildMixinIndex,
  isPlatformClass,
  lenientJson,
  parseManifest,
  readFabric,
  readQuilt,
  readModsToml,
  readMcmod,
  packageRoots,
  prettyFromFile,
  ENV_IDS,
  KNOWN_LIBS,
  MOD_FILE,
};
