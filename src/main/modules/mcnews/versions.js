'use strict';
// Comparacion del manifiesto de versiones de Minecraft con lo ultimo visto (settings.news.seenVersions). Sin
// Electron: lo usan modules/mcnews.js y las pruebas de mcnews/test/.
//   latest: { release, snapshot } del manifiesto; seen: { release, snapshot } guardado.

const TYPES = ['release', 'snapshot'];
const VALID_ID = /^[\w.+-]{1,64}$/;

const idOf = (v) => (typeof v === 'string' && VALID_ID.test(v) ? v : null);

// Versiones nuevas respecto de lo visto: [{ id, type }]. Si la snapshot mas nueva es la misma release, se avisa una
// sola vez (como release). Con `seen` vacio todo es nuevo: el modulo decide si eso es una base o un aviso.
function newVersions(latest, seen) {
  const l = latest && typeof latest === 'object' ? latest : {};
  const s = seen && typeof seen === 'object' ? seen : {};
  const out = [];
  for (const type of TYPES) {
    const id = idOf(l[type]);
    if (!id || idOf(s[type]) === id) continue;
    if (type === 'snapshot' && out.some((x) => x.id === id)) continue;
    out.push({ id, type });
  }
  return out;
}

// Lo que hay que guardar como visto despues de mirar el manifiesto (sin pisar con basura).
function seenPatch(latest, seen) {
  const l = latest && typeof latest === 'object' ? latest : {};
  const s = seen && typeof seen === 'object' ? seen : {};
  const out = {};
  for (const type of TYPES) out[type] = idOf(l[type]) || idOf(s[type]) || null;
  return out;
}

// true si todavia no se vio ninguna version (primera vez: se toma el manifiesto como base, sin avisar).
function isBaseline(seen) {
  const s = seen && typeof seen === 'object' ? seen : {};
  return !TYPES.some((type) => idOf(s[type]));
}

// Fecha de publicacion (epoch ms) de una version del manifiesto, o null.
function releaseTimeOf(manifest, id) {
  const v = (manifest?.versions || []).find((x) => x && x.id === id);
  const t = v ? Date.parse(v.releaseTime || v.time || '') : NaN;
  return Number.isFinite(t) ? t : null;
}

module.exports = { TYPES, newVersions, seenPatch, isBaseline, releaseTimeOf };
