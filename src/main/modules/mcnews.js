'use strict';
// Aviso de version nueva de Minecraft (3.1): al arrancar y cada 6 horas lee el manifiesto de versiones (core/minecraft
// lo baja con cache) y compara latest.release y latest.snapshot con lo ultimo visto (settings.news.seenVersions).
// Si hay una nueva manda el evento mcnews:new ({ id, type, releaseTime }) y la interfaz (features/tools) muestra el
// aviso con "Crear instancia" y "Ya vi". Solo consulta si la conexion opcional "news" esta activada
// (settings.privacy.news) y el interruptor settings.news.newVersions (true por defecto) esta prendido.
// La primera vez (sin nada visto) el manifiesto se toma como base: no avisa por versiones que ya existian.
//   mcnews:status()           -> { enabled, allowed, latest, seen, pending, lastCheck, error }
//   mcnews:check()            -> status (consulta ahora, aunque la cache este fresca)
//   mcnews:seen({ id, type }) -> status (marca esa version como vista)
const versions = require('./mcnews/versions');

const CHECK_MS = 6 * 60 * 60 * 1000;
const FIRST_MS = 20 * 1000;

const st = { ctx: null, enabled: true, allowed: false, seen: {}, latest: null, lastCheck: 0, error: null, notified: new Set(), checking: null, first: null, timer: null };

function applySettings(s) {
  st.enabled = s?.news?.newVersions !== false;
  st.allowed = s?.privacy?.news === true;
  st.seen = s?.news?.seenVersions && typeof s.news.seenVersions === 'object' ? s.news.seenVersions : {};
}

function status() {
  return {
    enabled: st.enabled,
    allowed: st.allowed,
    latest: st.latest,
    seen: versions.seenPatch({}, st.seen),
    pending: st.latest && !versions.isBaseline(st.seen) ? versions.newVersions(st.latest, st.seen) : [],
    lastCheck: st.lastCheck || null,
    error: st.error,
  };
}

async function saveSeen(patch) {
  await require('../core/settings').set({ news: { seenVersions: patch } });
}

function notify(manifest, list) {
  for (const v of list) {
    if (st.notified.has(v.id)) continue;
    st.notified.add(v.id);
    st.ctx?.send?.('mcnews:new', { id: v.id, type: v.type, releaseTime: versions.releaseTimeOf(manifest, v.id) });
  }
}

function check({ force = false } = {}) {
  if (st.checking) return st.checking;
  st.checking = (async () => {
    if (!st.enabled || !st.allowed) return status();
    let manifest;
    try {
      manifest = await require('../core/minecraft').getManifest(force);
      st.error = null;
    } catch (err) {
      st.error = err?.code || 'network';
      console.warn('[mcnews] manifiesto:', err?.message || err);
      return status();
    }
    st.latest = manifest?.latest && typeof manifest.latest === 'object' ? { release: manifest.latest.release || null, snapshot: manifest.latest.snapshot || null } : null;
    st.lastCheck = Date.now();
    if (!st.latest) return status();
    if (versions.isBaseline(st.seen)) {
      // Primera vez: lo de hoy es la base, sin avisos.
      await saveSeen(versions.seenPatch(st.latest, st.seen)).catch((err) => console.warn('[mcnews] guardar', err?.message || err));
      return status();
    }
    notify(manifest, versions.newVersions(st.latest, st.seen));
    return status();
  })().finally(() => {
    st.checking = null;
  });
  return st.checking;
}

async function markSeen(v) {
  const id = typeof v?.id === 'string' ? v.id : null;
  const type = versions.TYPES.includes(v?.type) ? v.type : null;
  if (!id || !type) return status();
  const patch = { [type]: id };
  // Una release nueva suele ser tambien la ultima snapshot: se marcan las dos.
  if (type === 'release' && st.latest?.snapshot === id) patch.snapshot = id;
  await saveSeen(patch);
  return status();
}

function arm() {
  clearTimeout(st.first);
  clearInterval(st.timer);
  st.first = null;
  st.timer = null;
  if (!st.enabled || !st.allowed) return;
  st.first = setTimeout(() => check().catch(() => {}), FIRST_MS);
  st.timer = setInterval(() => check().catch(() => {}), CHECK_MS);
  st.first.unref?.();
  st.timer.unref?.();
}

function register({ app, handle, send, onQuit }) {
  st.ctx = { send };
  const settings = require('../core/settings');
  settings
    .get()
    .then((s) => {
      applySettings(s);
      arm();
    })
    .catch((err) => console.warn('[mcnews] ajustes', err?.message || err));
  settings.onChange((s, patch) => {
    if (!patch || !(patch.news || patch.privacy)) return;
    const before = `${st.enabled}|${st.allowed}`;
    applySettings(s);
    if (`${st.enabled}|${st.allowed}` !== before) arm();
  });

  handle('mcnews:status', () => status());
  handle('mcnews:check', () => check({ force: true }));
  handle('mcnews:seen', (v) => markSeen(v));

  // Capturas de desarrollo: VENUS_MCNEWS_FAKE=<id> avisa esa version como nueva, sin consultar nada.
  const fake = process.env.VENUS_MCNEWS_FAKE;
  if (process.env.VENUS_DEVSHOT && !app?.isPackaged && fake && /^[\w.+-]{1,64}$/.test(fake)) {
    setTimeout(() => send?.('mcnews:new', { id: fake, type: /^\d+w\d+[a-z]$/i.test(fake) ? 'snapshot' : 'release', releaseTime: Date.now() }), 3000);
  }

  onQuit?.(() => {
    clearTimeout(st.first);
    clearInterval(st.timer);
  });
}

module.exports = { register, check, status, markSeen, CHECK_MS };
