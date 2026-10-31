'use strict';
// Resumen corto de un crash para el modelo, recortado en el cliente: el crash report mas nuevo
// (descripcion, excepcion, cadena de "Caused by", primeras lineas del stack, mods sospechosos de Forge),
// las lineas relevantes de logs/latest.log, un hs_err_pid (crash nativo de Java) si lo hay y los mods
// instalados que aparecen mencionados. Se usa cuando el modulo de crashes (./crash) no esta disponible.
const fsp = require('fs/promises');
const path = require('path');
const AdmZip = require('adm-zip');

const BUDGET = 6000; // ~6 KB en total
const TAIL_BYTES = 384 * 1024;

async function newestFile(dir, re) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  let best = null;
  for (const e of entries) {
    if (!e.isFile() || !re.test(e.name)) continue;
    const st = await fsp.stat(path.join(dir, e.name)).catch(() => null);
    if (st && (!best || st.mtimeMs > best.mtimeMs)) best = { name: e.name, full: path.join(dir, e.name), mtimeMs: st.mtimeMs, size: st.size };
  }
  return best;
}

async function readHead(file, bytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function readTail(file, bytes) {
  const st = await fsp.stat(file);
  if (st.size <= bytes) return fsp.readFile(file, 'utf8');
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    await fh.read(buf, 0, bytes, st.size - bytes);
    const text = buf.toString('utf8');
    return text.slice(text.indexOf('\n') + 1);
  } finally {
    await fh.close();
  }
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------- Crash report ----------
function parseReport(text) {
  const lines = text.split(/\r?\n/);
  const out = { description: null, exception: null, causedBy: [], frames: [], suspected: [], mixin: [] };
  const descIdx = lines.findIndex((l) => /^Description:/.test(l));
  if (descIdx >= 0) {
    out.description = lines[descIdx].replace(/^Description:\s*/, '').trim();
    for (let i = descIdx + 1; i < Math.min(lines.length, descIdx + 8); i++) {
      const l = lines[i].trim();
      if (l && !l.startsWith('at ')) {
        out.exception = l;
        break;
      }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^Caused by:/.test(l) && out.causedBy.length < 6) out.causedBy.push(clip(l, 300));
    if (/^Suspected Mods?:/i.test(l)) {
      const rest = l.replace(/^Suspected Mods?:\s*/i, '');
      if (rest && !/^none$/i.test(rest)) out.suspected.push(clip(rest, 200));
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
        const m = lines[j].trim();
        if (!m || /:\s*$/.test(m) || /^--/.test(m)) break;
        if (/\(|\[/.test(m)) out.suspected.push(clip(m, 200));
      }
    }
    if (/[Mm]ixin.*(?:failed|error|apply)|InvalidInjectionException|MixinApplyError/.test(l) && out.mixin.length < 4) out.mixin.push(clip(l, 300));
  }
  // Primeras lineas del stack despues de la excepcion
  const start = out.exception ? lines.findIndex((l) => l.trim() === out.exception) : -1;
  if (start >= 0) {
    for (let i = start + 1; i < lines.length && out.frames.length < 10; i++) {
      const l = lines[i].trim();
      if (l.startsWith('at ')) out.frames.push(clip(l, 200));
      else if (out.frames.length) break;
    }
  }
  return out;
}

// ---------- latest.log ----------
const ERROR_LINE = /\/(ERROR|FATAL)\]|Exception|Error:|Caused by:|requires|is missing|Incompatible mod|Mixin apply failed|crash|could not|failed to/i;
const NOISE = /realms|telemetry|narrator|sound engine|Texture .* not found|Unable to load model|Missing model|missing texture|Failed to get system info|OpenAL/i;

function logInfo(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const relevant = [];
  const deps = [];
  for (const l of lines) {
    if (/requires (?:version|any version)|which is missing|Incompatible mods found|is incompatible with|Mod resolution failed|Missing or unsupported mandatory dependencies/i.test(l)) {
      if (deps.length < 12) deps.push(clip(l.trim(), 300));
    } else if (ERROR_LINE.test(l) && !NOISE.test(l)) relevant.push(clip(l.trim(), 260));
  }
  return { errors: relevant.slice(-18), dependencyIssues: deps, tail: lines.slice(-14).map((l) => clip(l.trim(), 220)) };
}

// ---------- Mods instalados (ids de fabric.mod.json / mods.toml) ----------
const idCache = new Map();
function modIdsOf(full, size, mtimeMs) {
  const key = `${full}|${size}|${mtimeMs}`;
  if (idCache.has(key)) return idCache.get(key);
  const ids = new Set();
  try {
    const zip = new AdmZip(full);
    for (const name of ['fabric.mod.json', 'quilt.mod.json']) {
      const e = zip.getEntry(name);
      if (!e) continue;
      try {
        const j = JSON.parse(e.getData().toString('utf8'));
        if (j.id) ids.add(String(j.id).toLowerCase());
        if (j.quilt_loader?.id) ids.add(String(j.quilt_loader.id).toLowerCase());
      } catch {
        /* json invalido */
      }
    }
    for (const name of ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
      const e = zip.getEntry(name);
      if (!e) continue;
      for (const m of e.getData().toString('utf8').matchAll(/modId\s*=\s*["']([\w-]+)["']/g)) ids.add(m[1].toLowerCase());
    }
  } catch {
    /* no es un zip valido */
  }
  const out = [...ids].filter((x) => !['minecraft', 'java', 'fabricloader', 'forge', 'neoforge', 'quilt_loader'].includes(x));
  if (idCache.size > 3000) idCache.clear();
  idCache.set(key, out);
  return out;
}

async function installedMods(instanceDir, records) {
  const dir = path.join(instanceDir, 'mods');
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !/\.(jar|zip)(\.disabled)?$/i.test(e.name)) continue;
    const full = path.join(dir, e.name);
    const st = await fsp.stat(full).catch(() => null);
    if (!st) continue;
    const base = e.name.replace(/\.disabled$/i, '');
    const rec = Object.values(records || {}).find((r) => r?.file === base);
    const nameKey = base.replace(/\.(jar|zip)$/i, '').split(/[-_+ ](?=\d|v\d|mc\d|fabric|forge|neoforge|quilt)/i)[0].toLowerCase();
    out.push({ file: e.name, enabled: !e.name.endsWith('.disabled'), ids: modIdsOf(full, st.size, st.mtimeMs), nameKey, title: rec?.title || null });
  }
  return out;
}

function suspects(mods, texts) {
  const hay = texts.join('\n').toLowerCase();
  const scored = [];
  for (const m of mods) {
    if (!m.enabled) continue;
    let score = 0;
    const reasons = [];
    for (const id of m.ids) {
      if (id.length < 3) continue;
      const re = new RegExp(`(?<![\\w-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g');
      const hits = (hay.match(re) || []).length;
      if (hits) {
        score += Math.min(hits, 6);
        reasons.push(`mod id "${id}" x${hits}`);
      }
    }
    if (!score && m.nameKey.length >= 4 && hay.includes(m.nameKey)) {
      score += 1;
      reasons.push(`name "${m.nameKey}"`);
    }
    if (score) scored.push({ file: m.file, title: m.title, score, reasons: reasons.slice(0, 3) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 6);
}

// Arma el resumen. Devuelve un objeto chico (el llamador lo anonimiza).
async function summarize(instance) {
  const dir = instance.dir;
  const report = await newestFile(path.join(dir, 'crash-reports'), /\.txt$/i);
  const latest = await newestFile(path.join(dir, 'logs'), /^latest\.log$/i);
  const hsErr = await newestFile(dir, /^hs_err_pid\d+\.log$/i);
  if (!report && !latest && !hsErr) return { found: false };

  const out = { found: true };
  const texts = [];
  let budget = BUDGET;
  const take = (arr, max) => {
    const res = [];
    for (const s of arr) {
      if (budget - s.length < 0 || res.length >= max) break;
      budget -= s.length;
      res.push(s);
    }
    return res;
  };

  if (report) {
    const text = await readHead(report.full, 200 * 1024);
    const r = parseReport(text);
    texts.push(text.slice(0, 60000));
    out.crash_report = {
      file: report.name,
      time: new Date(report.mtimeMs).toISOString(),
      description: r.description ? clip(r.description, 200) : null,
      exception: r.exception ? clip(r.exception, 400) : null,
      caused_by: take(r.causedBy, 6),
      top_frames: take(r.frames, 8),
      suspected_mods_reported: take(r.suspected, 6),
      mixin_errors: take(r.mixin, 4),
    };
    budget -= (out.crash_report.description || '').length + (out.crash_report.exception || '').length;
  }
  if (latest) {
    const text = await readTail(latest.full, TAIL_BYTES);
    texts.push(text);
    const l = logInfo(text);
    out.latest_log = {
      time: new Date(latest.mtimeMs).toISOString(),
      dependency_issues: take(l.dependencyIssues, 10),
      errors: take(l.errors.slice().reverse(), 14).reverse(),
      last_lines: take(l.tail.slice().reverse(), 10).reverse(),
    };
  }
  if (hsErr) {
    const text = await readHead(hsErr.full, 32 * 1024);
    const frame = text.match(/# Problematic frame:\s*\r?\n#\s*(.+)/);
    const kind = text.match(/#\s+(EXCEPTION_\w+|SIGSEGV|SIGBUS|SIGILL)[^\n]*/);
    out.jvm_crash = { file: hsErr.name, time: new Date(hsErr.mtimeMs).toISOString(), error: kind ? clip(kind[0].replace(/^#\s+/, ''), 200) : null, problematic_frame: frame ? clip(frame[1], 200) : null };
    texts.push(text);
  }
  try {
    const mods = await installedMods(dir, instance.modrinth?.projects);
    out.suspected_mods = suspects(mods, texts);
    out.mods_enabled = mods.filter((m) => m.enabled).length;
  } catch {
    out.suspected_mods = [];
  }
  out.note = 'Trimmed summary (~6 KB). Personal data was removed by the launcher.';
  return out;
}

module.exports = { summarize, parseReport, logInfo };
