'use strict';
// "Tu resumen de Venus": imagen para compartir con las horas jugadas, la instancia favorita, los mods y los
// mundos. La interfaz la dibuja en un <canvas> con datos locales; aca se juntan los datos y se copia o se
// guarda la imagen. No usa la red ni sube nada.
//   recap:data() -> { generatedAt, hasPlaytime, firstPlay, streak, milestones, collection, periods: { week, month, all } }
//                   (cada periodo: { from, to, ms, sessions, daysPlayed, longestMs, favorite, top, figures, ... })
//   recap:copy(dataUrlPng) -> { width, height } (copia la imagen al portapapeles)
//   recap:save(dataUrlPng, nombreSugerido) -> { path, bytes, width, height } | null si se cancela
//                   (dialogo para guardar, en la carpeta Imagenes; escritura atomica)
//   recap:reveal(ruta) -> muestra en la carpeta una imagen guardada en esta sesion
// Errores con err.code: 'badImage' (no es un PNG valido), 'tooBig', 'clipboard', 'save', 'reveal'.
const path = require('path');
const stats = require('../core/stats');
const instances = require('../core/instances');
const { t } = require('../core/i18n');
const { buildRecap } = require('./recap/aggregate');
const { scanCollection } = require('./recap/collection');
const image = require('./recap/image');

let ctx = null;
const saved = new Set(); // imagenes guardadas en esta sesion (las unicas que se pueden mostrar en la carpeta)

function coded(key, code, vars) {
  const err = new Error(t(`recap.${key}`, vars));
  err.code = code;
  return err;
}

// Los errores de recap/image.js traen solo el codigo: aca se les pone el texto traducido.
function translate(err) {
  if (err?.code === 'badImage') return coded('errImage', 'badImage');
  if (err?.code === 'tooBig') return coded('errTooBig', 'tooBig');
  return err;
}

async function safe(label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    console.warn(`[recap] ${label}:`, err?.message || err);
    return fallback;
  }
}

// Carpeta de un mundo tal como la guarda la actividad: un solo segmento, sin separadores ni "..".
const validFolder = (s) => typeof s === 'string' && s.length > 0 && s.length <= 255 && !/[\\/\x00-\x1f]/.test(s) && s !== '.' && s !== '..';

// Nombre visible del mundo (LevelName de level.dat); si no se puede leer, la carpeta.
async function worldName(byId, place) {
  const inst = byId.get(place.instanceId);
  if (!inst || !validFolder(place.world)) return place.world;
  try {
    const dir = instances.dir(place.instanceId);
    ctx.safePath(path.join(dir, 'saves', place.world));
    const brief = await require('./statsplus/ingame').worldBrief({ ...inst, dir }, place.world);
    return (typeof brief?.name === 'string' && brief.name.trim()) || place.world;
  } catch {
    return place.world;
  }
}

async function recapData() {
  const now = Date.now();
  const [data, places, list] = await Promise.all([
    safe('estadísticas', () => stats.get(), null),
    safe('actividad', () => require('./statsplus/activity').aggregate(), []),
    safe('instancias', () => instances.list(), []),
  ]);
  const collection = await safe('colección', () => scanCollection(list, { dirOf: (id) => instances.dir(id) }), null);
  const recap = buildRecap({ data, places, instances: list, collection, milestoneIds: (stats.MILESTONES || []).map((m) => m.id), now });
  // A la interfaz solo le llega lo que se dibuja: nombre del mundo o servidor, instancia y tiempo
  const byId = new Map(list.map((i) => [i.id, i]));
  for (const p of Object.values(recap.periods)) {
    const top = p.top;
    if (!top) continue;
    if (top.kind === 'world') {
      // venus-instance.json se puede editar a mano: el nombre tiene que ser texto
      const inst = byId.get(top.instanceId);
      const own = typeof inst?.name === 'string' && inst.name.trim() ? inst.name.trim() : null;
      p.top = { kind: 'world', name: String(await worldName(byId, top)).slice(0, 120), instanceName: (own || top.instanceName || '').slice(0, 120) || null, ms: top.ms };
    } else {
      p.top = { kind: 'server', name: top.address, instanceName: null, ms: top.ms };
    }
  }
  return recap;
}

// Capturas automaticas en desarrollo (VENUS_DEVSHOT, sin empaquetar): no se toca el portapapeles del usuario y
// la imagen se guarda en la carpeta de las capturas, sin dialogo.
function devshotDir() {
  const { app } = require('electron');
  return process.env.VENUS_DEVSHOT && !app.isPackaged ? path.resolve(process.env.VENUS_DEVSHOT) : null;
}

function copy(dataUrl) {
  const { clipboard, nativeImage } = require('electron');
  try {
    return image.copyPng(dataUrl, { clipboard, nativeImage, dryRun: Boolean(devshotDir()) });
  } catch (err) {
    if (err?.code === 'badImage' || err?.code === 'tooBig') throw translate(err);
    console.warn('[recap] portapapeles:', err?.message || err);
    throw coded('errClipboard', 'clipboard');
  }
}

async function save(dataUrl, suggested) {
  const { dialog, app } = require('electron');
  const safety = require('./packs/safety');
  let defaultDir;
  try {
    defaultDir = app.getPath('pictures');
  } catch {
    defaultDir = app.getPath('documents');
  }
  const win = ctx.getWindow();
  try {
    const res = await image.savePng(dataUrl, suggested, {
      showSaveDialog: (opts) => (win && !win.isDestroyed() ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts)),
      defaultDir,
      writeFile: (target, buf) => safety.writeFileAtomic(target, buf),
      title: t('recap.saveTitle'),
      filterName: t('recap.filterPng'),
      fallbackName: t('recap.fileName'),
      fixedDir: devshotDir(),
    });
    if (res) saved.add(path.resolve(res.path));
    return res;
  } catch (err) {
    if (err?.code === 'badImage' || err?.code === 'tooBig') throw translate(err);
    throw coded('errSave', 'save', { error: err?.message || String(err) });
  }
}

function register(context) {
  ctx = context;
  const { handle } = context;
  handle('recap:data', () => recapData());
  handle('recap:copy', (dataUrl) => copy(dataUrl));
  handle('recap:save', (dataUrl, suggested) => save(dataUrl, suggested));
  handle('recap:reveal', (p) => {
    const full = typeof p === 'string' && p ? path.resolve(p) : '';
    if (!full || !saved.has(full)) throw coded('errReveal', 'reveal');
    require('electron').shell.showItemInFolder(full);
    return true;
  });
}

module.exports = { register, recapData };
