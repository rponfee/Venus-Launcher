'use strict';
// Diagnostico de crashes: explica en lenguaje humano por que se cerro el juego (base de reglas + IA
// opcional), ofrece arreglos de un clic y busca automaticamente el mod culpable desactivando mitades
// de los mods hasta encontrarlo (o el par de mods que chocan).
// Canales: crash:analyze, crash:reports, crash:explainAi, crash:fix, crash:bisectStart, crash:bisectStatus,
//          crash:bisectAnswer, crash:bisectCancel, crash:bisectRelaunch, crash:bisectDismiss
// Evento:  crash:bisect (instanceId, estado)
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { t, getLanguage } = require('../core/i18n');
const paths = require('../core/paths');
const settings = require('../core/settings');
const instances = require('../core/instances');
const game = require('../core/game');
const tasks = require('../core/tasks');
const { compareSemver } = require('../core/util');
const { analyze } = require('./crash/analyze');
const { scanMods } = require('./crash/mods');
const { estimateRounds } = require('./crash/bisect');
const runner = require('./crash/runner');
const { BisectSession } = require('./crash/session');

const MOD_LOADERS = ['fabric', 'quilt', 'forge', 'neoforge', 'legacyfabric'];
const CONFIG_EXT = /\.(json5?|toml|cfg|properties|ya?ml|txt|conf|snbt|ini)$/i;

const lastSession = new Map(); // instanceId -> { start, end, code, crashed, text }
const lastAnalysis = new Map(); // instanceId -> { at, result, input, ai }
const sessions = new Map(); // instanceId -> BisectSession
const finished = new Map(); // instanceId -> ultimo estado terminado
const recovered = new Map(); // instanceId -> { at, restored, failed }
let ctx = null;
let gpuCache = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function statOrNull(p) {
  return fsp.stat(p).catch(() => null);
}

async function readTail(file, max) {
  const fh = await fsp.open(file, 'r').catch(() => null);
  if (!fh) return '';
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    await fh.close().catch(() => {});
  }
}

async function readHead(file, max) {
  const fh = await fsp.open(file, 'r').catch(() => null);
  if (!fh) return '';
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, max);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return buf.toString('utf8');
  } finally {
    await fh.close().catch(() => {});
  }
}

async function newestIn(dir, test) {
  let best = null;
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!test(name)) continue;
    const st = await statOrNull(path.join(dir, name));
    if (st?.isFile() && (!best || st.mtimeMs > best.mtime)) best = { name, file: path.join(dir, name), mtime: st.mtimeMs, size: st.size };
  }
  return best;
}

function language() {
  return getLanguage() || 'es';
}

async function gpuName() {
  if (gpuCache !== null) return gpuCache;
  gpuCache = '';
  try {
    const info = await ctx?.app?.getGPUInfo?.('basic');
    const dev = (info?.gpuDevice || []).find((d) => d.active) || info?.gpuDevice?.[0];
    const vendors = { 0x10de: 'NVIDIA', 0x1002: 'AMD', 0x8086: 'Intel' };
    gpuCache = vendors[dev?.vendorId] || '';
  } catch {
    gpuCache = '';
  }
  return gpuCache;
}

// Solo para capturas de desarrollo (VENUS_DEVSHOT + VENUS_CRASH_FAKE_AI): respuesta de IA de ejemplo
const devFakeAi = () => Boolean(process.env.VENUS_DEVSHOT && process.env.VENUS_CRASH_FAKE_AI);

async function aiAvailable() {
  if (devFakeAi()) return true;
  try {
    return await require('./ai').available();
  } catch {
    return false;
  }
}

async function getInstance(instanceId) {
  if (typeof instanceId !== 'string' || !instanceId || instanceId !== path.basename(instanceId)) throw new Error(t('crash.errNoInstance'));
  try {
    const inst = await instances.get(instanceId);
    return { ...inst, dir: inst.dir || instances.dir(instanceId) };
  } catch {
    throw new Error(t('crash.errNoInstance'));
  }
}

function modsCacheFile() {
  return paths.cache('crash', 'mods-index.json');
}

// ---------- Analisis ----------

async function analyzeInstance(instanceId, opts = {}) {
  const inst = await getInstance(instanceId);
  const dir = inst.dir;
  const s = await settings.get();
  const sess = lastSession.get(instanceId);
  const reportsDir = path.join(dir, 'crash-reports');

  // Crash report: el elegido, o el de esta sesion (si hay una sesion reciente), o el ultimo
  let report = null;
  if (opts.report) {
    const name = path.basename(String(opts.report));
    const st = /\.txt$/i.test(name) ? await statOrNull(path.join(reportsDir, name)) : null;
    if (st) report = { name, file: path.join(reportsDir, name), mtime: st.mtimeMs };
  } else if (!opts.latestOnly) {
    const newest = await newestIn(reportsDir, (n) => /\.txt$/i.test(n));
    if (newest && (!sess || newest.mtime >= sess.start - 3000)) report = newest;
  }
  const latestFile = path.join(dir, 'logs', 'latest.log');
  const latestSt = await statOrNull(latestFile);
  const anchor = report ? report.mtime : sess ? sess.end : latestSt ? latestSt.mtimeMs : Date.now();
  const sameSession = (mtime) => (sess && !opts.report ? mtime >= sess.start - 3000 : Math.abs(mtime - anchor) < 15 * 60 * 1000);
  const useLatest = latestSt && (opts.report ? sameSession(latestSt.mtimeMs) : !sess || latestSt.mtimeMs >= sess.start - 3000);
  const hs = await newestIn(dir, (n) => /^hs_err_pid\d+\.log$/i.test(n));
  const useHs = hs && sameSession(hs.mtime);

  const [reportText, latestText, hsText] = await Promise.all([
    report ? readHead(report.file, 400000) : '',
    useLatest ? readTail(latestFile, 700000) : '',
    useHs ? readHead(hs.file, 120000) : '',
  ]);
  const sessionText = sess && (!opts.report || (report && report.mtime >= sess.start - 3000)) ? sess.text : '';
  const tailText = Array.isArray(opts.logs) ? opts.logs.map((l) => String(l?.text ?? l ?? '')).join('\n') : '';

  const mods = await scanMods(path.join(dir, 'mods'), { cacheFile: modsCacheFile() }).catch(() => []);
  const memoryMb = inst.memory?.override ? inst.memory.max : s.memory?.max;
  const code = opts.code ?? sess?.code ?? null;
  const result = analyze(
    {
      report: reportText,
      log: sessionText,
      latest: latestText,
      tail: tailText,
      hsErr: hsText,
      code,
      instance: {
        id: instanceId,
        name: inst.name,
        mcVersion: inst.mcVersion,
        loader: inst.loader,
        loaderVersion: inst.loaderVersion,
        memoryMb,
        javaPath: inst.java?.path || '',
        jvmArgs: [s.jvmArgs, inst.java?.args].filter(Boolean).join(' '),
      },
      mods,
      system: { totalMemMb: Math.round(os.totalmem() / 1048576), gpu: await gpuName() },
    },
    { t, language: language() },
  );

  const enabled = mods.filter((m) => m.enabled);
  const supportsMods = MOD_LOADERS.includes(inst.loader);
  const logForDetails = sessionText || latestText || tailText;
  const out = {
    ...result,
    instance: { id: instanceId, name: inst.name, mcVersion: inst.mcVersion, loader: inst.loader, loaderVersion: inst.loaderVersion },
    code,
    at: Date.now(),
    sources: {
      report: report ? { name: report.name, mtime: report.mtime } : null,
      latest: Boolean(latestText),
      hsErr: useHs ? { name: hs.name, mtime: hs.mtime } : null,
      session: Boolean(sessionText),
    },
    mods: { total: mods.length, enabled: enabled.length },
    bisect: {
      possible: supportsMods && enabled.length > 0,
      reason: !supportsMods ? 'noLoader' : !enabled.length ? 'noMods' : null,
      estimate: estimateRounds(enabled.length),
      suggestedMode: result.progress.reachedMenu || result.progress.inGame ? 'manual' : 'crash',
      running: sessions.has(instanceId),
    },
    ai: { available: await aiAvailable() },
    details: {
      report: reportText.slice(0, 150000),
      log: logForDetails.split(/\r?\n/).slice(-220).join('\n'),
      hsErr: hsText.slice(0, 30000),
    },
  };
  const prev = lastAnalysis.get(instanceId);
  const sameInput = prev && prev.key === `${report?.name || ''}|${sess?.end || ''}|${code}`;
  lastAnalysis.set(instanceId, {
    at: Date.now(),
    key: `${report?.name || ''}|${sess?.end || ''}|${code}`,
    result: out,
    input: { reportText, logText: sessionText || latestText || tailText, hsText, mods, inst, memoryMb, code },
    ai: sameInput ? prev.ai : null,
  });
  return out;
}

async function listReports(instanceId) {
  const inst = await getInstance(instanceId);
  const out = [];
  const add = async (dir, test, kind) => {
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!test(name)) continue;
      const st = await statOrNull(path.join(dir, name));
      if (st?.isFile()) out.push({ name, kind, mtime: st.mtimeMs, size: st.size });
    }
  };
  await add(path.join(inst.dir, 'crash-reports'), (n) => /\.txt$/i.test(n), 'report');
  await add(inst.dir, (n) => /^hs_err_pid\d+\.log$/i.test(n), 'hsErr');
  out.sort((a, b) => b.mtime - a.mtime);
  const latest = await statOrNull(path.join(inst.dir, 'logs', 'latest.log'));
  return { reports: out.slice(0, 40), latest: latest ? { mtime: latest.mtimeMs, size: latest.size } : null, session: lastSession.has(instanceId) ? { end: lastSession.get(instanceId).end, crashed: lastSession.get(instanceId).crashed } : null };
}

// ---------- IA ----------

const LANG_NAMES = {
  es: 'Spanish as spoken in Argentina (rioplatense), always using voseo ("actualizá", "probá", "tenés")',
  en: 'English',
  pt: 'Brazilian Portuguese',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  nl: 'Dutch',
  pl: 'Polish',
  ru: 'Russian',
  uk: 'Ukrainian',
  tr: 'Turkish',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Simplified Chinese',
};

function trimLog(text, max = 140) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  const important = [];
  lines.forEach((l, i) => {
    if (/ERROR|FATAL|Exception|Error:|Caused by|Mixin|incompatible|requires|missing|crash/i.test(l)) important.push(i);
  });
  const keep = new Set();
  for (const i of important.slice(-60)) for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j);
  for (let j = Math.max(0, lines.length - 40); j < lines.length; j++) keep.add(j);
  const picked = [...keep].sort((a, b) => a - b).slice(-max).map((i) => lines[i].slice(0, 400));
  return picked.join('\n');
}

function trimReport(text) {
  const t0 = String(text || '');
  const walk = t0.indexOf('A detailed walkthrough of the error');
  const headPart = (walk > 0 ? t0.slice(0, walk) : t0).split(/\r?\n/).slice(0, 150).join('\n');
  const sys = t0.match(/-- System Details --[\s\S]{0,6000}/);
  const sus = t0.match(/Suspected Mods?:[\s\S]{0,1500}?(?=\r?\nStacktrace:|\r?\n\r?\n)/);
  return [headPart.slice(0, 12000), sus ? sus[0] : '', sys ? sys[0].split(/\r?\n/).filter((l) => !/^\t\t\S.*\|/.test(l)).slice(0, 60).join('\n') : ''].filter(Boolean).join('\n\n');
}

async function explainAi(instanceId) {
  if (devFakeAi()) {
    await sleep(900);
    return { text: require('./crash/test/dev-fakes').fakeAiText(language()), at: Date.now(), model: 'demo' };
  }
  const ai = require('./ai');
  if (!(await ai.available())) throw new Error(t('crash.errAiUnavailable'));
  let entry = lastAnalysis.get(instanceId);
  if (!entry) {
    await analyzeInstance(instanceId, {});
    entry = lastAnalysis.get(instanceId);
  }
  if (entry.ai) return entry.ai;
  const lang = (await settings.get()).language || language();
  const { input, result } = entry;
  const modList = input.mods
    .filter((m) => m.enabled)
    .slice(0, 350)
    .map((m) => `${m.name} ${m.version || ''}`.trim())
    .join('\n');
  const hints = result.findings.slice(0, 3).map((f) => `- ${f.title}: ${f.text}`).join('\n');
  const suspects = result.suspects.map((s) => `${s.name} ${s.version || ''} (score ${s.score})`).join(', ');
  const system = [
    'You are the crash assistant of Venus Launcher, a Minecraft: Java Edition launcher. Explain to a non-technical player why the game crashed and how to fix it.',
    `Answer in ${LANG_NAMES[lang] || LANG_NAMES.en}. Use plain, friendly words; if you must use a technical term, explain it briefly.`,
    'Format: first one short paragraph (2-3 sentences) saying what happened. Then a numbered list ("1.", "2.", ...) with 2 to 5 concrete steps, the most likely fix first. Use exact mod names and versions from the data.',
    'Rules: only mention mods that appear in the data. If the cause is uncertain, say so and suggest the launcher tool that finds the culprit mod automatically. Only recommend downloading mods from Modrinth or CurseForge. No headings, tables or code blocks. Keep it under 170 words.',
  ].join('\n');
  const prompt = [
    `Instance: Minecraft ${input.inst.mcVersion}, loader ${input.inst.loader} ${input.inst.loaderVersion || ''}, Java ${result.javaMajor || 'unknown'}, max RAM ${input.memoryMb || 'unknown'} MB, exit code ${input.code ?? 'unknown'}.`,
    hints ? `Automatic rule-based analysis (may be incomplete):\n${hints}` : '',
    suspects ? `Mods that appear in the stack trace: ${suspects}` : '',
    result.exception ? `Main exception: ${result.exception.cls}: ${result.exception.msg}${result.exception.root ? `\nRoot cause: ${result.exception.root.cls}: ${result.exception.root.msg}` : ''}` : '',
    input.reportText ? `Crash report (trimmed):\n${trimReport(input.reportText)}` : '',
    input.logText ? `Last relevant log lines:\n${trimLog(input.logText)}` : '',
    input.hsText ? `JVM fatal error file (trimmed):\n${input.hsText.split(/\r?\n/).slice(0, 40).join('\n')}` : '',
    `Installed mods (${input.mods.filter((m) => m.enabled).length}):\n${modList || '(none)'}`,
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 60000);
  // Haiku con esfuerzo medio (lo incluyen todos los planes); el modelo que se muestra es el que respondio
  const res = await ai.request({ task: 'text', system, prompt, model: 'haiku', effort: 'medium', maxTokens: 4000 });
  if (res.stop_reason === 'max_tokens') throw new Error(t('ai.errTooLong'));
  const text = ai.textOf(res.content);
  const model = typeof res.model === 'string' ? res.model : '';
  entry.ai = { text: String(text || '').trim(), at: Date.now(), model };
  return entry.ai;
}

// ---------- Arreglos de un clic ----------

function checkModFile(file) {
  const name = String(file || '');
  if (!name || name !== path.basename(name) || !/\.(jar|zip|litemod)(\.disabled)?$/i.test(name)) throw new Error(t('crash.errBadFile'));
  return name;
}

function checkRelative(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!clean || clean.includes('..') || path.isAbsolute(clean) || !CONFIG_EXT.test(clean)) throw new Error(t('crash.errBadFile'));
  if (!/^(config|defaultconfigs)\//.test(clean) && !/^options(of|shaders)?\.txt$/.test(clean)) throw new Error(t('crash.errBadFile'));
  return clean;
}

function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function removeArg(args, option) {
  const norm = (s) => String(s).replace(/^-XX:[+-]/, '-XX:').split('=')[0];
  const target = norm(option);
  const tokens = splitArgs(args);
  const kept = tokens.filter((tok) => norm(tok) !== target);
  return { changed: kept.length !== tokens.length, args: kept.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(' ') };
}

const JAVA_COMPONENTS = [
  [8, 'jre-legacy'],
  [16, 'java-runtime-alpha'],
  [17, 'java-runtime-gamma'],
  [21, 'java-runtime-delta'],
  [25, 'java-runtime-epsilon'],
];

async function ensureJava(major) {
  const java = require('../core/java');
  const wanted = Math.max(8, Math.min(99, Number(major) || 17));
  const runtimes = await java.listInstalledRuntimes().catch(() => []);
  const exact = runtimes.find((r) => Number(r.major) === wanted);
  if (exact) return { path: exact.path, major: wanted };
  const [compMajor, component] = JAVA_COMPONENTS.find(([m]) => m >= wanted) || JAVA_COMPONENTS[JAVA_COMPONENTS.length - 1];
  const close = runtimes.filter((r) => Number(r.major) >= wanted && Number(r.major) <= compMajor).sort((a, b) => a.major - b.major)[0];
  if (close) return { path: close.path, major: Number(close.major) };
  const javaPath = await tasks.run(t('crash.taskJava', { major: compMajor }), (task) => java.ensureRuntime(component, compMajor, task));
  return { path: javaPath, major: compMajor };
}

async function setProperty(file, key, value) {
  let text = '';
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    text = '';
  }
  const re = new RegExp(`^${key}\\s*[=:].*$`, 'm');
  text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${key}=${value}\n`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
}

async function fix(instanceId, action = {}) {
  const type = String(action?.type || '');
  const p = action?.payload || {};
  if (game.status()[instanceId]) throw new Error(t('crash.errCloseGame'));
  if (sessions.has(instanceId)) throw new Error(t('crash.errBisectRunning'));
  const inst = await getInstance(instanceId);
  const dir = inst.dir;
  const fmtRam = (mb) => (mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`);
  switch (type) {
    case 'disableMod': {
      const file = checkModFile(p.file);
      if (file.endsWith('.disabled')) return { message: t('crash.fixAlready') };
      ctx.safePath(path.join(dir, 'mods', file));
      if (!(await statOrNull(path.join(dir, 'mods', file)))) throw new Error(t('crash.errModGone', { file }));
      await instances.toggleFile(instanceId, 'mods', file);
      return { message: t('crash.fixDisabled', { name: p.name || file }) };
    }
    case 'enableMod': {
      const file = checkModFile(p.file);
      if (!file.endsWith('.disabled')) return { message: t('crash.fixAlready') };
      ctx.safePath(path.join(dir, 'mods', file));
      if (!(await statOrNull(path.join(dir, 'mods', file)))) throw new Error(t('crash.errModGone', { file }));
      await instances.toggleFile(instanceId, 'mods', file);
      return { message: t('crash.fixEnabled', { name: p.name || file }) };
    }
    case 'raiseRam':
    case 'lowerRam': {
      const mb = Math.max(512, Math.min(Math.round(os.totalmem() / 1048576), Math.round(Number(p.mb) || 0)));
      if (!mb) throw new Error(t('crash.errBadValue'));
      const min = Math.min(inst.memory?.min || 1024, mb);
      await instances.update(instanceId, { memory: { override: true, min, max: mb } });
      return { message: t('crash.fixRam', { ram: fmtRam(mb) }) };
    }
    case 'fixRam': {
      const max = Math.max(1024, Math.round(Number(p.max) || 4096));
      await instances.update(instanceId, { memory: { override: true, min: Math.min(1024, max), max } });
      return { message: t('crash.fixRam', { ram: fmtRam(max) }) };
    }
    case 'useJava': {
      const res = await ensureJava(p.major);
      await instances.update(instanceId, { java: { path: res.path } });
      return { message: t('crash.fixJava', { major: res.major }) };
    }
    case 'resetJava': {
      await instances.update(instanceId, { java: { path: '' } });
      return { message: t('crash.fixJavaAuto') };
    }
    case 'removeJvmArg': {
      const option = String(p.option || '').trim();
      if (!/^-[\w:.+-]+$/.test(option.split('=')[0])) throw new Error(t('crash.errBadValue'));
      const res = removeArg(inst.java?.args || '', option);
      if (res.changed) {
        await instances.update(instanceId, { java: { args: res.args } });
        return { message: t('crash.fixArgRemoved', { option }) };
      }
      const s = await settings.get();
      if (removeArg(s.jvmArgs || '', option).changed) throw new Error(t('crash.errArgGlobal', { option }));
      return { message: t('crash.fixAlready') };
    }
    case 'resetConfig': {
      const rel = checkRelative(p.file);
      const src = ctx.safePath(path.join(dir, rel));
      if (!src.startsWith(path.resolve(dir) + path.sep)) throw new Error(t('crash.errBadFile'));
      if (!(await statOrNull(src))?.isFile()) throw new Error(t('crash.errConfigGone', { file: path.basename(rel) }));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dest = ctx.safePath(path.join(dir, '.venus', 'crash-backups', stamp, rel));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      try {
        await fsp.rename(src, dest);
      } catch {
        await fsp.copyFile(src, dest);
        await fsp.rm(src, { force: true });
      }
      return { message: t('crash.fixConfig', { file: path.basename(rel) }), backup: dest };
    }
    case 'updateLoader': {
      if (!MOD_LOADERS.includes(inst.loader)) throw new Error(t('crash.errNoModLoader'));
      await instances.update(instanceId, { loaderVersion: 'latest', versionId: null });
      return { message: t('crash.fixLoader') };
    }
    case 'disableShaders': {
      const changed = [];
      for (const name of ['iris.properties', 'oculus.properties']) {
        const file = path.join(dir, 'config', name);
        if (await statOrNull(file)) {
          await setProperty(file, 'enableShaders', 'false');
          changed.push(name);
        }
      }
      const of = path.join(dir, 'optionsshaders.txt');
      if (await statOrNull(of)) {
        await setProperty(of, 'shaderPack', 'OFF');
        changed.push('optionsshaders.txt');
      }
      if (!changed.length) {
        if (inst.loader === 'optifine') await setProperty(of, 'shaderPack', 'OFF');
        else await setProperty(path.join(dir, 'config', 'iris.properties'), 'enableShaders', 'false');
      }
      return { message: t('crash.fixShaders') };
    }
    default:
      throw new Error(t('crash.errUnknownAction'));
  }
}

// ---------- Busqueda del mod culpable ----------

function focusWindow() {
  try {
    const w = ctx?.getWindow?.();
    if (!w || w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    if (!w.isVisible()) w.show();
    w.focus();
  } catch {
    /* sin ventana */
  }
}

// Solo para capturas de desarrollo (scripts/devshot.js con VENUS_CRASH_FAKE_GAME=1): un juego falso que
// no abre Minecraft, para ver la busqueda completa en la interfaz.
function devFakeGame() {
  if (!process.env.VENUS_DEVSHOT || !process.env.VENUS_CRASH_FAKE_GAME) return null;
  const { createFakeGame } = require('./crash/test/dev-fakes');
  return { game: createFakeGame({ dirFor: (id) => instances.dir(id) }), runnerOptions: { stableMs: 1500, tickMs: 250, failGraceMs: 600 } };
}

function progressDetail(st) {
  if (st.waiting && st.current) return t('crash.taskWaiting', { round: st.round, estimate: st.estimate });
  if (st.current) return t('crash.taskRound', { round: st.round, estimate: st.estimate, enabled: st.current.enabled.length, total: st.total });
  return t('crash.taskPreparing');
}

async function bisectStart(instanceId, opts = {}) {
  const mode = opts?.mode === 'manual' ? 'manual' : 'crash';
  if (sessions.has(instanceId)) throw new Error(t('crash.errBisectRunning'));
  if (game.status()[instanceId]) throw new Error(t('crash.errCloseGame'));
  const inst = await getInstance(instanceId);
  if (!MOD_LOADERS.includes(inst.loader)) throw new Error(t('crash.errNoModLoader'));
  const accounts = require('../core/accounts');
  await accounts.getLaunchAccount();
  const mods = (await scanMods(path.join(inst.dir, 'mods'), { cacheFile: modsCacheFile() })).filter((m) => m.enabled);
  if (!mods.length) throw new Error(t('crash.errNoMods'));

  // Los sospechosos del ultimo analisis se prueban primero
  const suspects = {};
  const prev = lastAnalysis.get(instanceId);
  if (prev && Date.now() - prev.at < 60 * 60 * 1000) {
    for (const s of prev.result.suspects || []) suspects[s.file] = s.score;
    for (const f of prev.result.findings || []) for (const m of f.mods || []) if (f.confidence !== 'low') suspects[m.file] = Math.max(suspects[m.file] || 0, f.confidence === 'high' ? 8 : 5);
  }
  const counters = { playtime: inst.playtime || 0, launches: inst.launches || 0, lastPlayed: inst.lastPlayed || 0 };
  let lastWindowState = null;
  const fake = devFakeGame();
  const session = new BisectSession({
    instanceId,
    instanceDir: inst.dir,
    instanceName: inst.name,
    mode,
    mods,
    suspects,
    game: fake?.game || game,
    runnerOptions: { ...(fake?.runnerOptions || {}), legacyForge: inst.loader === 'forge' && compareSemver(String(inst.mcVersion || '0'), '1.13') < 0 },
    t,
    getLaunch: async () => ({ account: await accounts.getLaunchAccount(), settings: await settings.get(), launcherVersion: ctx?.app?.getVersion?.() || '1.0.0' }),
  });
  // Otra tarea de la instancia (actualizar mods o el modpack, restaurar, aplicar un pack) puede mover mods
  // mientras la busqueda los desactiva: se espera a que termine. Sin await entre este chequeo y sessions.set,
  // asi nada empieza en el medio (los demas modulos preguntan con isBisecting/assertNotBisecting).
  if (sessions.has(instanceId)) throw new Error(t('crash.errBisectRunning'));
  if (tasks.list().some((x) => x.state === 'running' && x.meta?.instanceId === instanceId && x.meta.background !== true && x.meta.blocksPlay !== false)) throw new Error(t('crash.errInstanceBusy'));
  sessions.set(instanceId, session);
  finished.delete(instanceId);
  recovered.delete(instanceId);

  tasks
    .run(
      t('crash.taskBisect', { name: inst.name }),
      async (task) => {
        task.signal.addEventListener('abort', () => session.cancel(), { once: true });
        session.onUpdate = (st) => {
          ctx.send('crash:bisect', instanceId, st);
          task.update({ detail: progressDetail(st), progress: st.estimate ? Math.min(0.98, st.round / st.estimate) : null });
          // Volver al launcher cuando hace falta una respuesta o termino
          const key = `${st.status}|${st.waiting && st.current?.game === 'closed'}`;
          if (key !== lastWindowState) {
            lastWindowState = key;
            if (!st.active || (st.waiting && st.current?.game === 'closed')) focusWindow();
          }
        };
        const final = await session.run();
        if (final.status === 'cancelled') throw new Error(t('crash.cancelled'));
        if (final.status === 'error') throw new Error(final.error || t('crash.errBisect'));
        return final;
      },
      // Con instanceId: la interfaz muestra la instancia ocupada mientras los mods estan a medio desactivar.
      { instanceId, crashBisect: instanceId },
    )
    .catch(() => {})
    .finally(async () => {
      sessions.delete(instanceId);
      const snap = session.snapshot();
      finished.set(instanceId, snap);
      ctx.send('crash:bisect', instanceId, snap);
      // Las pruebas no cuentan como partidas jugadas
      await sleep(3000);
      try {
        if (!game.status()[instanceId]) await instances.update(instanceId, counters);
      } catch {
        /* la instancia pudo borrarse */
      }
    });
  return session.snapshot();
}

function bisectStatus(instanceId) {
  const s = sessions.get(instanceId);
  if (s) return s.snapshot();
  if (finished.has(instanceId)) return finished.get(instanceId);
  if (recovered.has(instanceId)) return { instanceId, status: 'recovered', active: false, ...recovered.get(instanceId) };
  return null;
}

// Para otros modulos: mientras se busca el culpable los mods estan a medio desactivar, asi que nada que
// cambie la carpeta mods (actualizar, restaurar, aplicar un pack) puede correr en esa instancia.
function isBisecting(instanceId) {
  return sessions.has(instanceId);
}

function assertNotBisecting(instanceId) {
  if (sessions.has(instanceId)) throw Object.assign(new Error(t('crash.errBisectRunning')), { code: 'bisect' });
}

// ---------- Registro ----------

function register(c) {
  ctx = c;

  // Guardar el registro completo de la ultima partida (incluye errores de Java que no van a latest.log)
  game.events.on('session', (s) => {
    if (!s?.instanceId) return;
    const lines = (s.logs || []).slice(-4000).map((l) => String(l?.text ?? ''));
    lastSession.set(s.instanceId, { start: s.start, end: s.end, code: s.code, crashed: Boolean(s.crashed), text: lines.join('\n') });
  });

  // Mientras se busca el culpable no se puede jugar esa instancia (los mods estan a medio desactivar)
  game.addBeforeLaunch(async ({ id }) => (sessions.has(id) ? { block: true, message: t('crash.errBisectRunning') } : null));

  c.handle('crash:analyze', (instanceId, opts) => analyzeInstance(instanceId, opts || {}));
  c.handle('crash:reports', (instanceId) => listReports(instanceId));
  c.handle('crash:explainAi', (instanceId) => explainAi(instanceId));
  c.handle('crash:fix', (instanceId, action) => fix(instanceId, action));
  c.handle('crash:bisectStart', (instanceId, opts) => bisectStart(instanceId, opts || {}));
  c.handle('crash:bisectStatus', (instanceId) => bisectStatus(instanceId));
  c.handle('crash:bisectAnswer', (instanceId, works) => {
    const s = sessions.get(instanceId);
    if (!s || !s.answer(Boolean(works))) throw new Error(t('crash.errNoQuestion'));
    return s.snapshot();
  });
  c.handle('crash:bisectCancel', (instanceId) => {
    const s = sessions.get(instanceId);
    if (!s) return bisectStatus(instanceId);
    s.cancel();
    return s.snapshot();
  });
  c.handle('crash:bisectRelaunch', async (instanceId) => {
    const s = sessions.get(instanceId);
    if (!s || s.mode !== 'manual') throw new Error(t('crash.errNoQuestion'));
    await s.relaunch();
    return s.snapshot();
  });
  c.handle('crash:bisectDismiss', (instanceId) => {
    finished.delete(instanceId);
    recovered.delete(instanceId);
    return true;
  });

  // Al cerrar el launcher: cortar la busqueda y devolver los mods a como estaban (rapido, sin esperar)
  c.onQuit(async () => {
    await Promise.all([...sessions.values()].map((s) => s.emergencyRestore().catch(() => {})));
  });

  // Si el launcher se cerro de golpe durante una busqueda, deshacer los cambios que hayan quedado
  return runner
    .recoverAll(paths.instances())
    .then((list) => {
      for (const r of list) {
        recovered.set(r.instanceId, { at: Date.now(), restored: r.restored, failed: r.failed });
        console.warn(`[crash] Se restauraron ${r.restored} mods de una búsqueda interrumpida en ${r.instanceId}`);
      }
    })
    .catch((err) => console.warn('[crash] recuperación', err?.message || err));
}

module.exports = { register, analyzeInstance, bisectStatus, isBisecting, assertNotBisecting };
