'use strict';
// Comparación de versiones de mods: semver tolerante, predicados de Fabric/Quilt ("~1.21", ">=0.15 <0.17",
// "1.21.x"), rangos Maven de Forge/NeoForge ("[47,)") y extracción de la versión "real" de un mod
// a partir del número de versión de Modrinth ("mc1.21.1-0.8.13-fabric" -> "0.8.13").

function parse(v) {
  let s = String(v ?? '').trim().replace(/^v(?=\d)/i, '');
  const plus = s.indexOf('+');
  if (plus >= 0) s = s.slice(0, plus);
  const dash = s.indexOf('-');
  const main = dash >= 0 ? s.slice(0, dash) : s;
  const pre = dash >= 0 ? s.slice(dash + 1) : '';
  const nums = main.split('.').filter((x) => x !== '').map((x) => (/^\d+$/.test(x) ? Number(x) : x.toLowerCase()));
  return { nums, pre: pre ? pre.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x.toLowerCase())) : [] };
}

function cmpPart(a, b) {
  const na = typeof a === 'number';
  const nb = typeof b === 'number';
  if (na && nb) return a === b ? 0 : a < b ? -1 : 1;
  if (na) return 1; // numero > texto (1.0 > 1.a)
  if (nb) return -1;
  return a === b ? 0 : a < b ? -1 : 1;
}

// -1, 0, 1. Las partes que faltan valen 0 (1.21 == 1.21.0). Una pre-release es menor que la final.
function compare(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const c = cmpPart(pa.nums[i] ?? 0, pb.nums[i] ?? 0);
    if (c) return c;
  }
  if (!pa.pre.length && pb.pre.length) return 1;
  if (pa.pre.length && !pb.pre.length) return -1;
  const plen = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < plen; i++) {
    if (pa.pre[i] === undefined) return -1;
    if (pb.pre[i] === undefined) return 1;
    // en pre-releases los numeros son menores que los textos (semver)
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (typeof x === 'number' && typeof y !== 'number') return -1;
    if (typeof x !== 'number' && typeof y === 'number') return 1;
    const c = cmpPart(x, y);
    if (c) return c;
  }
  return 0;
}

function isWildcard(s) {
  return /(^|\.)[xX*](\.|$)/.test(s);
}

function matchOne(version, part) {
  const m = /^(>=|<=|>|<|=|~|\^)?\s*(.+)$/.exec(part);
  if (!m) return true;
  const op = m[1] || '';
  const target = m[2];
  if (isWildcard(target)) {
    const fixed = [];
    for (const p of target.split('.')) {
      if (/^[xX*]$/.test(p)) break;
      fixed.push(p);
    }
    const nums = parse(version).nums;
    const ok = fixed.every((p, i) => cmpPart(nums[i] ?? 0, /^\d+$/.test(p) ? Number(p) : p.toLowerCase()) === 0);
    if (op === '>=' || op === '>') return ok || compare(version, fixed.join('.') || '0') > 0;
    if (op === '<=' || op === '<') return ok || compare(version, fixed.join('.') || '0') < 0;
    return ok;
  }
  const c = compare(version, target);
  switch (op) {
    case '>=':
      return c >= 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '<':
      return c < 0;
    case '~': {
      const t = parse(target).nums;
      const upper = [Number(t[0]) || 0, (Number(t[1]) || 0) + 1].join('.');
      return c >= 0 && compare(version, upper) < 0;
    }
    case '^': {
      const t = parse(target).nums;
      return c >= 0 && compare(version, String((Number(t[0]) || 0) + 1)) < 0;
    }
    default:
      return c === 0;
  }
}

// Predicado de Fabric/Quilt: texto ("*", ">=1.0 <2.0", "~1.21") o lista de alternativas (OR).
function matchPredicate(version, pred) {
  if (pred === undefined || pred === null) return true;
  if (version === undefined || version === null || version === '') return true; // sin datos: no acusar
  if (Array.isArray(pred)) return pred.length === 0 || pred.some((p) => matchPredicate(version, p));
  if (typeof pred === 'object') {
    if (Array.isArray(pred.any)) return pred.any.some((p) => matchPredicate(version, p));
    if (Array.isArray(pred.all)) return pred.all.every((p) => matchPredicate(version, p));
    return true;
  }
  const s = String(pred).trim();
  if (!s || s === '*') return true;
  return s.split(/\s+/).every((part) => matchOne(version, part));
}

function isAnyPredicate(pred) {
  if (pred === undefined || pred === null) return true;
  if (Array.isArray(pred)) return pred.length === 0 || pred.some(isAnyPredicate);
  if (typeof pred === 'object') return false;
  const s = String(pred).trim();
  return !s || s === '*';
}

// Rango Maven (Forge/NeoForge): "[1.0,2.0)", "[47,)", "(,1.2]", "[1.0]", varios separados por coma.
function inMavenRange(version, spec) {
  if (version === undefined || version === null || version === '') return true;
  const s = String(spec ?? '').replace(/\s+/g, '');
  if (!s || s === '*') return true;
  const ranges = s.match(/[[(][^\])]*[\])]/g);
  if (!ranges) return true; // una version suelta es "recomendada": acepta cualquiera
  return ranges.some((r) => {
    const lo = r[0];
    const hi = r[r.length - 1];
    const inner = r.slice(1, -1);
    if (!inner.includes(',')) return compare(version, inner) === 0;
    const [a, b] = inner.split(',');
    if (a) {
      const c = compare(version, a);
      if (lo === '[' ? c < 0 : c <= 0) return false;
    }
    if (b) {
      const c = compare(version, b);
      if (hi === ']' ? c > 0 : c >= 0) return false;
    }
    return true;
  });
}

function isAnyRange(spec) {
  const s = String(spec ?? '').replace(/\s+/g, '');
  return !s || s === '*' || s === '[0,)' || !/[[(]/.test(s);
}

// Parece una version de Minecraft (1.21.1, mc1.20, 26.1.2): se usa solo para desempatar.
function mcLike(tok) {
  return /^(mc)?1\.([7-9]|1\d|2\d)(\.\d{1,2})?$/.test(tok) || /^(mc)?2\d\.\d{1,2}(\.\d{1,2})?$/.test(tok);
}

// "mc1.21.1-0.8.13-fabric" -> "0.8.13"; "1.8.14-beta.1+1.21.1-fabric" -> "1.8.14"
function versionCore(versionNumber, gameVersions = []) {
  const games = new Set((gameVersions || []).map((g) => String(g).toLowerCase()));
  const tokens = String(versionNumber || '').toLowerCase().split(/[-+_\s]+/).filter(Boolean);
  const candidates = [];
  for (const tok of tokens) {
    const bare = tok.replace(/^mc/, '');
    if (games.has(bare) || games.has(tok)) continue;
    if (!/^v?\d/.test(bare)) continue;
    candidates.push({ tok: bare.replace(/^v/, ''), mc: mcLike(tok) });
  }
  const pick = candidates.find((c) => !c.mc) || candidates[0];
  return pick ? pick.tok : null;
}

// true si "to" es un salto mayor respecto de "from" (1.x -> 2.x, o 0.5 -> 0.6 en versiones 0.x)
function isMajorBump(from, to) {
  if (!from || !to) return false;
  const a = parse(from).nums.map((n) => (typeof n === 'number' ? n : NaN));
  const b = parse(to).nums.map((n) => (typeof n === 'number' ? n : NaN));
  if (!Number.isFinite(a[0]) || !Number.isFinite(b[0])) return false;
  if (b[0] > a[0]) return true;
  if (b[0] === 0 && a[0] === 0 && Number.isFinite(a[1]) && Number.isFinite(b[1]) && b[1] > a[1]) return true;
  return false;
}

module.exports = { parse, compare, matchPredicate, isAnyPredicate, inMavenRange, isAnyRange, versionCore, isMajorBump };
