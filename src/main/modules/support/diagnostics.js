'use strict';
// Diagnóstico opcional para adjuntar a una consulta. La persona elige qué partes manda y ve el texto EXACTO que se
// enviará: acá se arma ese texto (ya sin rutas ni datos personales) y la interfaz muestra lo mismo que después manda.
// Partes: app (launcher y sistema), java, instance (versión, loader, memoria y cantidad de mods), mods (nombres de los
// archivos) y log (últimas líneas del registro). Solo las tres primeras arrancan tildadas, y recién cuando la persona
// activa el diagnóstico; los nombres de mods y el registro se tildan a mano.
const { LIMITS } = require('./rules');
const { createSupportRedactor, countRedactions } = require('./redact');

const DEFAULT_ON = new Set(['app', 'java', 'instance']);
const ORDER = ['app', 'java', 'instance', 'mods', 'log'];
const LOG_CHOICES = [50, 100, 200];
const LINE_MAX = 300;
const MODS_MAX = 150;
const SIZE_FIELDS = (n) => (n >= 1024 ? `${(n / 1024).toFixed(n >= 10240 ? 0 : 1)} GB` : `${Math.round(n)} MB`);

const kv = (pairs) => pairs.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}: ${v}`).join('\n');

// raw viene de collectRaw() (o de las pruebas). Devuelve las partes con su texto ya anonimizado.
function buildSections(raw, redactor) {
  const r = raw || {};
  const a = r.app || {};
  const s = r.system || {};
  const j = r.java || {};
  const i = r.instance || null;
  const out = [];
  const add = (id, text) => { if (text) out.push({ id, text: redactor.text(text), on: DEFAULT_ON.has(id) }); };

  add('app', kv([
    ['launcher', a.version ? `${a.version}${a.portable ? ' (portable)' : a.packaged === false ? ' (dev)' : ''}` : ''],
    ['electron', a.electron],
    ['os', [a.osName, a.arch].filter(Boolean).join(' ')],
    ['ram', s.totalMemMb ? `${SIZE_FIELDS(s.totalMemMb)}${s.freeMemMb ? ` (free ${SIZE_FIELDS(s.freeMemMb)})` : ''}` : ''],
    ['cpu', s.cpu ? `${s.cpu}${s.cores ? ` (${s.cores} threads)` : ''}` : ''],
    ['gpu', s.gpu],
    ['language', a.language],
  ]));
  add('java', kv([
    ['java.required', j.requiredMajor],
    ['java.selected', j.selectedPath ? (j.selected ? `${j.selected.version}${j.selected.vendor ? ` (${j.selected.vendor})` : ''}` : 'unreadable') : 'auto'],
    ['java.path', j.selectedPath || ''],
    ['java.installed', Array.isArray(j.installed) && j.installed.length ? j.installed.join(', ') : ''],
    ['jvm.args', j.jvmArgs],
  ]));
  if (i) {
    add('instance', kv([
      ['minecraft', i.mcVersion],
      ['loader', [i.loader, i.loaderVersion].filter(Boolean).join(' ') || 'vanilla'],
      ['memory', i.memoryMb ? `${i.memoryMb} MB` : ''],
      ['mods', i.mods ? `${i.mods.total} (${i.mods.enabled} enabled)` : ''],
    ]));
    if (Array.isArray(i.modFiles) && i.modFiles.length) {
      const names = i.modFiles.slice(0, MODS_MAX).map((n) => String(n).slice(0, 80));
      add('mods', names.join('\n') + (i.modFiles.length > MODS_MAX ? `\n… +${i.modFiles.length - MODS_MAX}` : ''));
    }
  }
  if (r.log && Array.isArray(r.log.lines) && r.log.lines.length) {
    add('log', r.log.lines.map((l) => String(l).slice(0, LINE_MAX)).join('\n'));
  }
  return out.sort((x, y) => ORDER.indexOf(x.id) - ORDER.indexOf(y.id));
}

// Une las partes elegidas. Si no entra en el tope, primero se recorta el principio del registro (lo último importa más).
function assemble(sections, ids, max = LIMITS.diagnostic) {
  const want = new Set(ids);
  const chosen = sections.filter((x) => want.has(x.id)).map((x) => ({ ...x }));
  const render = () => chosen.map((x) => `[${x.id}]\n${x.text}`).join('\n\n');
  let text = render();
  let truncated = false;
  const log = chosen.find((x) => x.id === 'log');
  if (text.length > max && log) {
    const lines = log.text.split('\n');
    while (lines.length > 1 && text.length > max) {
      lines.shift();
      log.text = lines.join('\n');
      text = render();
      truncated = true;
    }
  }
  if (text.length > max) { text = `${text.slice(0, max - 2)}\n…`; truncated = true; }
  return { text, truncated, redactions: countRedactions(text) };
}

// Elecciones por omisión: lo tildado de entrada, sin lo que no existe.
const defaultIds = (sections) => sections.filter((x) => x.on).map((x) => x.id);

// Segunda pasada sobre lo que llega a enviarse: si por algún camino quedó algo sin tapar, se tapa acá. Es idempotente.
function finalize(diagnostic, redactor) {
  const clean = redactor.text(String(diagnostic ?? '')).trim();
  return clean.length > LIMITS.diagnostic ? `${clean.slice(0, LIMITS.diagnostic - 2)}\n…` : clean;
}

const pickLines = (value) => (LOG_CHOICES.includes(Number(value)) ? Number(value) : 100);

// ---------- Recolección (proceso principal) ----------
// deps: { app, os, fsp, path, java, instances, settings, accounts, paths }. Todo es opcional: lo que falla se omite.
async function readTail(deps, file, max) {
  const fh = await deps.fsp.open(file, 'r').catch(() => null);
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

function osName(os) {
  const rel = os.release();
  if (process.platform === 'win32') return `${(Number(rel.split('.')[2]) || 0) >= 22000 ? 'Windows 11' : 'Windows 10'} (${rel})`;
  if (process.platform === 'darwin') return `macOS (Darwin ${rel})`;
  return `Linux ${rel}`;
}

async function collectRaw(deps, { instanceId, logLines } = {}) {
  const { app, os, fsp, path } = deps;
  const safe = async (fn, fallback = null) => { try { return await fn(); } catch { return fallback; } };
  const cpus = os.cpus();
  const raw = {
    app: { version: app.version, electron: app.electron, packaged: app.packaged, portable: app.portable, osName: osName(os), arch: process.arch, language: app.language },
    system: { totalMemMb: Math.round(os.totalmem() / 1048576), freeMemMb: Math.round(os.freemem() / 1048576), cpu: (cpus[0]?.model || '').replace(/\(R\)|\(TM\)/gi, '').replace(/\s+/g, ' ').trim(), cores: cpus.length, gpu: await safe(() => deps.gpu?.(), '') },
    java: {},
    instance: null,
    log: null,
  };
  const inst = instanceId ? await safe(() => deps.instances.get(instanceId)) : null;
  const settings = await safe(() => deps.settings.get(), {});
  if (inst && deps.java) {
    raw.java.requiredMajor = await safe(() => deps.java.majorForMinecraft(inst.mcVersion), null);
    raw.java.selectedPath = inst.java?.path || '';
    raw.java.selected = raw.java.selectedPath ? await safe(() => deps.java.getJavaVersion(raw.java.selectedPath)) : null;
    raw.java.jvmArgs = [settings?.jvmArgs, inst.java?.args].filter(Boolean).join(' ');
    const runtimes = await safe(() => deps.java.listInstalledRuntimes(), []);
    raw.java.installed = [...new Set(runtimes.map((x) => x.major).filter(Boolean))].sort((x, y) => x - y);
  }
  if (inst) {
    const dir = inst.dir || deps.instances.dir?.(inst.id);
    const files = dir ? await safe(() => fsp.readdir(path.join(dir, 'mods')), []) : [];
    const modFiles = files.filter((n) => /\.jar(\.disabled)?$/i.test(n)).sort((x, y) => x.localeCompare(y));
    raw.instance = {
      mcVersion: inst.mcVersion, loader: inst.loader && inst.loader !== 'vanilla' ? inst.loader : '', loaderVersion: inst.loaderVersion,
      memoryMb: inst.memory?.override ? inst.memory.max : settings?.memory?.max,
      mods: { total: modFiles.length, enabled: modFiles.filter((n) => !/\.disabled$/i.test(n)).length }, modFiles,
    };
    if (dir) {
      const tail = await safe(() => readTail(deps, path.join(dir, 'logs', 'latest.log'), 200000), '');
      const lines = tail.split(/\r?\n/).filter((l) => l.trim());
      const keep = pickLines(logLines);
      if (lines.length) raw.log = { lines: lines.slice(-keep) };
    }
  }
  return raw;
}

async function playerNames(deps) {
  const list = await (async () => { try { return await deps.accounts.list(); } catch { return null; } })();
  return (list?.accounts || []).map((a) => a.name).filter(Boolean);
}

module.exports = { buildSections, assemble, defaultIds, finalize, collectRaw, playerNames, pickLines, LOG_CHOICES, DEFAULT_ON, createSupportRedactor, countRedactions };
