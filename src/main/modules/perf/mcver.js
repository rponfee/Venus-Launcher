'use strict';
// Versiones de Minecraft: comparar "1.20.1", "1.21.11", "26.1", "26.4-snapshot-5", "24w14a"...
// y saber que Java necesita cada una cuando todavia no se bajo su JSON.

// Snapshots semanales viejos (24w14a) -> release aproximada, para poder compararlos.
const WEEKLY = [
  [25, 41, [1, 21, 11]],
  [25, 31, [1, 21, 9]],
  [25, 14, [1, 21, 6]],
  [25, 0, [1, 21, 5]],
  [24, 44, [1, 21, 4]],
  [24, 33, [1, 21, 2]],
  [24, 18, [1, 21, 0]],
  [24, 14, [1, 20, 5]],
  [24, 0, [1, 20, 4]],
  [23, 40, [1, 20, 3]],
  [23, 31, [1, 20, 2]],
  [23, 12, [1, 20, 0]],
  [23, 0, [1, 19, 4]],
  [22, 42, [1, 19, 3]],
  [22, 24, [1, 19, 1]],
  [22, 0, [1, 19, 0]],
  [21, 37, [1, 18, 0]],
  [20, 45, [1, 17, 0]],
  [20, 0, [1, 16, 0]],
  [19, 34, [1, 15, 0]],
  [18, 43, [1, 14, 0]],
  [17, 43, [1, 13, 0]],
];

function parse(v) {
  const s = String(v || '').trim().toLowerCase();
  let m = s.match(/^(\d{2})w(\d{2})[a-z]?$/);
  if (m) {
    const year = Number(m[1]);
    const week = Number(m[2]);
    if (year >= 26) return [year, 0, 0];
    const hit = WEEKLY.find(([y, w]) => year > y || (year === y && week >= w));
    return hit ? hit[2] : [1, 12, 0];
  }
  m = s.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return [0, 0, 0]; // alpha/beta/rd-...: muy viejas
  return [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
}

function cmp(a, b) {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function atLeast(v, target) {
  return cmp(v, target) >= 0;
}

// Java que pide Mojang para cada version (respaldo cuando no hay JSON a mano).
function javaMajorFor(mcVersion) {
  const [major, minor, patch] = parse(mcVersion);
  if (major >= 26) return 25;
  if (major === 0) return 8; // alpha, beta y anteriores
  if (major !== 1) return 21;
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

module.exports = { parse, cmp, atLeast, javaMajorFor };
