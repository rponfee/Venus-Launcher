'use strict';
// Deteccion del proyecto de plugin: herramienta de build (Gradle o Maven) y como ejecutarla, tareas
// tipicas (shadowJar, build, package...), jar de salida, version de Paper/Spigot contra la que compila,
// version de Java pedida y JDKs instalados. Node puro: se puede probar sin Electron.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const plugin = require('./pluginyml');

const WIN = process.platform === 'win32';
const SKIP_DIRS = new Set(['.git', '.gradle', '.idea', '.vscode', 'build', 'target', 'out', 'bin', 'node_modules', 'src', 'gradle', 'run', 'server', 'servers', 'logs', '.settings']);

async function stat(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}
const isFile = async (p) => Boolean((await stat(p))?.isFile());
const isDir = async (p) => Boolean((await stat(p))?.isDirectory());

async function readText(p, max = 1024 * 1024) {
  const st = await stat(p);
  if (!st || !st.isFile() || st.size > max) return '';
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return '';
  }
}

// Busca un ejecutable en el PATH sin lanzar procesos.
function which(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d.replace(/^"|"$/g, ''), n);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* no esta aca */
      }
    }
  }
  return null;
}

// Subcarpetas de primer nivel que parecen modulos (multi-proyecto Gradle o Maven).
async function moduleDirs(root, limit = 16) {
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const dir = path.join(root, e.name);
    if ((await isFile(path.join(dir, 'build.gradle'))) || (await isFile(path.join(dir, 'build.gradle.kts'))) || (await isFile(path.join(dir, 'pom.xml'))) || (await isDir(path.join(dir, 'src', 'main')))) {
      out.push(dir);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ---------- Versiones ----------

function mcTuple(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : [0, 0, 0];
}
function compareMc(a, b) {
  const x = mcTuple(a);
  const y = mcTuple(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// Version de Minecraft contra la que compila el proyecto (paper-api:1.21.4-R0.1-SNAPSHOT, paperDevBundle...).
function extractMcVersion(texts) {
  const found = [];
  const add = (v) => {
    if (v && /^\d+\.\d+(\.\d+)?$/.test(v) && mcTuple(v)[0] >= 1) found.push(v);
  };
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(/(\d+\.\d+(?:\.\d+)?)-R0\.1(?:-SNAPSHOT)?/g)) add(m[1]);
    for (const m of text.matchAll(/(?:paper-api|spigot-api|purpur-api|folia-api|paper-server|spigot):(\d+\.\d+(?:\.\d+)?)/g)) add(m[1]);
    for (const m of text.matchAll(/paperDevBundle\(\s*["'](\d+\.\d+(?:\.\d+)?)/g)) add(m[1]);
    for (const m of text.matchAll(/^\s*(?:minecraft_?version|mc_?version|minecraftVersion|mcVersion|paper_?version|paperVersion|server_?version)\s*[=:]\s*["']?(\d+\.\d+(?:\.\d+)?)/gim)) add(m[1]);
  }
  // Las versiones "1.x" no se mezclan con numeros de version de otras dependencias: se toma la mas alta.
  found.sort((a, b) => compareMc(b, a));
  return found[0] || null;
}

// Version de Java que pide el proyecto. toolchain=true si Gradle usa toolchains (compila con su propio JDK).
function extractJava(texts) {
  let major = null;
  let toolchain = false;
  const norm = (v) => {
    const s = String(v);
    const n = s.startsWith('1.') ? Number(s.slice(2)) : Number(s);
    return Number.isInteger(n) && n >= 6 && n <= 40 ? n : null;
  };
  for (const text of texts) {
    if (!text) continue;
    let m = text.match(/JavaLanguageVersion\.of\(\s*(\d+)\s*\)/);
    if (m) {
      major = norm(m[1]);
      toolchain = true;
      break;
    }
    m =
      text.match(/JavaVersion\.VERSION_(?:1_)?(\d+)/) ||
      text.match(/options\.release\.set\(\s*(\d+)\s*\)/) ||
      text.match(/options\.release\s*=\s*(\d+)/) ||
      text.match(/<maven\.compiler\.release>\s*(\d+)\s*</) ||
      text.match(/<release>\s*(\d+)\s*<\/release>/) ||
      text.match(/<maven\.compiler\.(?:target|source)>\s*(1\.\d+|\d+)\s*</) ||
      text.match(/<java\.version>\s*(1\.\d+|\d+)\s*</) ||
      text.match(/\bjvmTarget\s*(?:=|\.set\()\s*(?:JvmTarget\.JVM_)?["']?(?:1_)?(\d+)/);
    if (m && !major) major = norm(m[1]);
  }
  return { major, toolchain };
}

// Version de Gradle del wrapper (gradle-wrapper.properties).
function gradleVersionOf(text) {
  const m = String(text || '').match(/distributionUrl\s*=.*gradle-(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)-(?:bin|all)\.zip/);
  return m ? m[1] : null;
}

// Java mas nuevo con el que puede correr cada version de Gradle.
const GRADLE_JAVA = [
  ['9.1', 25],
  ['8.14', 24],
  ['8.10', 23],
  ['8.8', 22],
  ['8.5', 21],
  ['8.3', 20],
  ['7.6', 19],
  ['7.5', 18],
  ['7.3', 17],
  ['7.0', 16],
  ['6.7', 15],
  ['6.3', 14],
  ['6.0', 13],
  ['5.4', 12],
  ['5.0', 11],
];
function gradleMaxJava(version) {
  if (!version) return null;
  for (const [v, java] of GRADLE_JAVA) if (compareMc(version, v) >= 0) return java;
  return 10;
}

// ---------- Deteccion del proyecto ----------

async function detectProject(dir) {
  const root = path.resolve(dir);
  if (!(await isDir(root))) {
    const err = new Error('notDir');
    err.code = 'notDir';
    throw err;
  }
  const f = (name) => path.join(root, name);
  const buildGradle = (await isFile(f('build.gradle.kts'))) ? 'build.gradle.kts' : (await isFile(f('build.gradle'))) ? 'build.gradle' : null;
  const settingsGradle = (await isFile(f('settings.gradle.kts'))) ? 'settings.gradle.kts' : (await isFile(f('settings.gradle'))) ? 'settings.gradle' : null;
  const gradlew = (await isFile(f('gradlew.bat'))) || (await isFile(f('gradlew')));
  const pom = await isFile(f('pom.xml'));
  const modules = await moduleDirs(root);

  const tools = [];
  if (buildGradle || settingsGradle || gradlew) tools.push('gradle');
  if (pom) tools.push('maven');

  const gradleTexts = [];
  if (tools.includes('gradle')) {
    for (const n of [buildGradle, settingsGradle, 'gradle.properties', path.join('gradle', 'libs.versions.toml')]) if (n) gradleTexts.push(await readText(f(n)));
    for (const m of modules) {
      for (const n of ['build.gradle.kts', 'build.gradle', 'gradle.properties']) gradleTexts.push(await readText(path.join(m, n)));
    }
  }
  const mavenTexts = [];
  if (pom) {
    mavenTexts.push(await readText(f('pom.xml')));
    for (const m of modules) mavenTexts.push(await readText(path.join(m, 'pom.xml')));
  }
  const gradleAll = gradleTexts.join('\n');
  const mavenAll = mavenTexts.join('\n');

  const shadow = /com\.github\.johnrengelman\.shadow|com\.gradleup\.shadow|io\.github\.goooler\.shadow|\bshadowJar\b|id\s*\(?\s*["']shadow["']|libs\.plugins\.shadow/.test(gradleAll);
  const paperweight = /io\.papermc\.paperweight/.test(gradleAll);
  const shade = /maven-shade-plugin/.test(mavenAll);
  const gradleVersion = gradleVersionOf(await readText(f(path.join('gradle', 'wrapper', 'gradle-wrapper.properties'))));

  // Nombre del proyecto: rootProject.name, <name>/<artifactId> del pom o la carpeta.
  let name = null;
  const settingsText = settingsGradle ? await readText(f(settingsGradle)) : '';
  const rn = settingsText.match(/rootProject\.name\s*=\s*["']([^"']+)["']/);
  if (rn) name = rn[1];
  if (!name && mavenTexts[0]) {
    const noParent = mavenTexts[0].replace(/<parent>[\s\S]*?<\/parent>/, '').replace(/<dependencies>[\s\S]*<\/dependencies>/, '').replace(/<build>[\s\S]*<\/build>/, '');
    const nm = noParent.match(/<name>\s*([^<$]+?)\s*<\/name>/) || noParent.match(/<artifactId>\s*([^<$]+?)\s*<\/artifactId>/);
    if (nm) name = nm[1];
  }
  if (!name) name = path.basename(root);

  const gradleTasks = [shadow && 'shadowJar', 'build', 'assemble', 'jar', paperweight && 'reobfJar'].filter(Boolean);
  const mavenGoals = ['package', 'install', 'verify'];

  return {
    root,
    name: String(name).slice(0, 60),
    tools,
    tool: tools[0] || null,
    gradle: tools.includes('gradle')
      ? { buildFile: buildGradle, settingsFile: settingsGradle, wrapper: gradlew, version: gradleVersion, maxJava: gradleMaxJava(gradleVersion), shadow, paperweight, tasks: gradleTasks, defaultTask: shadow ? 'shadowJar' : 'build' }
      : null,
    maven: pom ? { wrapper: (await isFile(f('mvnw.cmd'))) || (await isFile(f('mvnw'))), shade, tasks: mavenGoals, defaultTask: 'package' } : null,
    modules: modules.map((m) => path.basename(m)),
    mcHint: extractMcVersion([...gradleTexts, ...mavenTexts]),
    java: extractJava([...gradleTexts, ...mavenTexts]),
    source: await plugin.readSources([root, ...modules]),
  };
}

// Como ejecutar el build: { exe, kind: 'wrapper' | 'system', display } o null si no hay forma.
function runnerFor(root, tool) {
  if (tool === 'gradle') {
    const wrapper = path.join(root, WIN ? 'gradlew.bat' : 'gradlew');
    if (fs.existsSync(wrapper)) return { exe: wrapper, kind: 'wrapper', display: WIN ? 'gradlew.bat' : './gradlew' };
    const sys = which(WIN ? ['gradle.bat', 'gradle.cmd', 'gradle.exe'] : ['gradle']);
    return sys ? { exe: sys, kind: 'system', display: 'gradle' } : null;
  }
  if (tool === 'maven') {
    const wrapper = path.join(root, WIN ? 'mvnw.cmd' : 'mvnw');
    if (fs.existsSync(wrapper)) return { exe: wrapper, kind: 'wrapper', display: WIN ? 'mvnw.cmd' : './mvnw' };
    const sys = which(WIN ? ['mvn.cmd', 'mvn.bat', 'mvn.exe'] : ['mvn']);
    return sys ? { exe: sys, kind: 'system', display: 'mvn' } : null;
  }
  return null;
}

// ---------- Jar de salida ----------

const IGNORE_JAR = /-(sources|javadoc|plain|tests?|test-fixtures)\.jar$|^original-/i;
const DEV_JAR = /-dev(-all)?\.jar$/i;

// Carpetas donde Gradle y Maven dejan los jars (raiz y modulos de primer nivel).
async function outputDirs(root) {
  const out = [];
  for (const base of [root, ...(await moduleDirs(root))]) {
    for (const rel of [path.join('build', 'libs'), 'target']) {
      const d = path.join(base, rel);
      if (await isDir(d)) out.push(d);
    }
  }
  return out;
}

// Posibles carpetas de salida aunque todavia no existan (para vigilar el jar).
async function expectedOutputDirs(root, tool) {
  const rel = tool === 'maven' ? ['target'] : tool === 'gradle' ? [path.join('build', 'libs')] : [path.join('build', 'libs'), 'target'];
  const out = [];
  for (const base of [root, ...(await moduleDirs(root))]) for (const r of rel) out.push(path.join(base, r));
  return out;
}

async function listJars(dirs) {
  const out = [];
  for (const d of dirs) {
    let names = [];
    try {
      names = await fsp.readdir(d);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/\.jar$/i.test(n) || IGNORE_JAR.test(n)) continue;
      const p = path.join(d, n);
      const st = await stat(p);
      if (st?.isFile() && st.size > 0) out.push({ path: p, file: n, size: st.size, mtime: Math.round(st.mtimeMs), dev: DEV_JAR.test(n) });
    }
  }
  return out;
}

const descCache = new Map(); // ruta -> { key, info }
async function describeJar(jar) {
  const key = `${jar.mtime}:${jar.size}`;
  const hit = descCache.get(jar.path);
  if (hit && hit.key === key) return hit.info;
  let info;
  try {
    info = await plugin.readJar(jar.path);
  } catch (err) {
    info = { kind: null, error: err.code || 'read' };
  }
  descCache.set(jar.path, { key, info });
  if (descCache.size > 200) descCache.delete(descCache.keys().next().value);
  return info;
}

// El jar mas nuevo que sea un plugin (se prefieren los que no son "-dev" de paperweight).
async function findOutputJar(root) {
  const jars = await listJars(await outputDirs(root));
  if (!jars.length) return null;
  jars.sort((a, b) => Number(a.dev) - Number(b.dev) || b.mtime - a.mtime || b.size - a.size);
  let fallback = null;
  for (const jar of jars.slice(0, 8)) {
    const info = await describeJar(jar);
    if (info.kind === 'plugin') return { ...jar, plugin: info };
    if (!fallback) fallback = { ...jar, plugin: info };
  }
  return fallback;
}

async function jarDetails(file) {
  const st = await stat(file);
  if (!st || !st.isFile()) return null;
  const jar = { path: file, file: path.basename(file), size: st.size, mtime: Math.round(st.mtimeMs) };
  return { ...jar, plugin: await describeJar(jar) };
}

// Fecha de la ultima modificacion de las fuentes (para saber si hace falta compilar).
async function latestSourceChange(root, limit = 20000) {
  let latest = 0;
  let seen = 0;
  const walk = async (dir, depth) => {
    if (seen > limit || depth > 24) return;
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen > limit) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'build' || e.name === 'target' || e.name === 'out' || e.name === 'node_modules') continue;
        await walk(p, depth + 1);
      } else if (e.isFile()) {
        seen++;
        const st = await stat(p);
        if (st && st.mtimeMs > latest) latest = st.mtimeMs;
      }
    }
  };
  const bases = [root, ...(await moduleDirs(root))];
  for (const b of bases) await walk(path.join(b, 'src'), 0);
  for (const n of ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties', 'pom.xml', path.join('gradle', 'libs.versions.toml')]) {
    const st = await stat(path.join(root, n));
    if (st && st.mtimeMs > latest) latest = st.mtimeMs;
  }
  return Math.round(latest);
}

// ---------- JDKs ----------

function javaHomeRoots() {
  const roots = [];
  const home = os.homedir();
  if (WIN) {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean)) {
      for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru', 'GraalVM', 'OpenJDK', 'RedHat', 'SapMachine']) roots.push(path.join(base, vendor));
    }
  } else if (process.platform === 'darwin') {
    roots.push('/Library/Java/JavaVirtualMachines', path.join(home, 'Library', 'Java', 'JavaVirtualMachines'));
  } else {
    roots.push('/usr/lib/jvm', '/usr/java', '/opt/java', '/opt/jdk');
  }
  roots.push(path.join(home, '.jdks'), path.join(home, '.gradle', 'jdks'), path.join(home, '.sdkman', 'candidates', 'java'));
  return roots;
}

async function jdkAt(home) {
  const bin = path.join(home, 'bin');
  const exe = WIN ? '.exe' : '';
  if (!(await isFile(path.join(bin, `javac${exe}`))) || !(await isFile(path.join(bin, `java${exe}`)))) return null;
  const release = await readText(path.join(home, 'release'), 64 * 1024);
  const ver = (release.match(/^JAVA_VERSION="?([^"\r\n]+)"?/m) || [])[1] || null;
  const vendor = (release.match(/^IMPLEMENTOR="?([^"\r\n]+)"?/m) || [])[1] || null;
  let major = null;
  if (ver) major = ver.startsWith('1.') ? Number(ver.split('.')[1]) : Number(ver.split(/[.+-]/)[0]);
  if (!major) {
    const m = path.basename(home).match(/(?:jdk|java|openjdk)[-_]?(1\.)?(\d+)/i);
    if (m) major = Number(m[2]);
  }
  return { home, version: ver, major: Number.isInteger(major) ? major : null, vendor };
}

// JDKs instalados (con javac): JAVA_HOME, carpetas habituales, los de IntelliJ (~/.jdks), los de Gradle y el PATH.
async function findJdks() {
  const candidates = [];
  for (const v of [process.env.JAVA_HOME, process.env.JDK_HOME]) if (v) candidates.push(v.replace(/^"|"$/g, ''));
  for (const root of javaHomeRoots()) {
    let entries = [];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      candidates.push(dir, path.join(dir, 'Contents', 'Home'));
      // ~/.gradle/jdks/<proveedor>/<jdk-x> tiene un nivel mas
      if (root.endsWith(path.join('.gradle', 'jdks'))) {
        try {
          for (const s of await fsp.readdir(dir, { withFileTypes: true })) if (s.isDirectory()) candidates.push(path.join(dir, s.name), path.join(dir, s.name, 'Contents', 'Home'));
        } catch {
          /* nada */
        }
      }
    }
  }
  const javac = which([WIN ? 'javac.exe' : 'javac']);
  if (javac) {
    let real = javac;
    try {
      real = fs.realpathSync(javac);
    } catch {
      /* sin enlace */
    }
    candidates.push(path.dirname(path.dirname(real)));
  }
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    let key = path.resolve(c);
    try {
      key = fs.realpathSync(key);
    } catch {
      continue;
    }
    const norm = WIN ? key.toLowerCase() : key;
    if (seen.has(norm)) continue;
    seen.add(norm);
    const jdk = await jdkAt(key);
    if (jdk) out.push(jdk);
  }
  return out.sort((a, b) => (b.major || 0) - (a.major || 0));
}

// Elige el JDK para compilar: con toolchains alcanza uno que pueda correr Gradle; sin toolchains tiene
// que ser >= al pedido. Sin pistas se prefiere 21 (Paper moderno), despues 17 y despues el mas nuevo.
function pickJdk(jdks, { want = null, toolchain = false, maxMajor = null } = {}) {
  const usable = jdks.filter((j) => j.major && (!maxMajor || j.major <= maxMajor));
  const pool = usable.length ? usable : jdks.filter((j) => j.major);
  if (!pool.length) return null;
  const asc = [...pool].sort((a, b) => a.major - b.major);
  if (want && !toolchain) {
    const exact = asc.find((j) => j.major === want);
    return exact || asc.find((j) => j.major > want) || asc[asc.length - 1];
  }
  if (want && toolchain) return asc.find((j) => j.major === want) || [...asc].reverse()[0];
  for (const pref of [21, 17]) {
    const hit = asc.find((j) => j.major === pref);
    if (hit) return hit;
  }
  return asc[asc.length - 1];
}

module.exports = {
  detectProject,
  runnerFor,
  findOutputJar,
  jarDetails,
  describeJar,
  outputDirs,
  expectedOutputDirs,
  latestSourceChange,
  moduleDirs,
  findJdks,
  jdkAt,
  pickJdk,
  extractMcVersion,
  extractJava,
  gradleVersionOf,
  gradleMaxJava,
  compareMc,
  which,
};
