'use strict';
// Estadisticas completas: tiempo por mundo y por servidor (actividad del juego), estadisticas dentro del juego
// (saves/<mundo>/stats y advancements), hitos, resumen para Inicio y exportacion a CSV/JSON.
// Los canales stats:get y stats:reset los registra ipc.js con core/stats; aca se suman los demas:
//   stats:summary -> { totalMs, weekMs, todayMs, streak, sessions, lastPlayed, favoriteInstance, ... } (barato)
//   stats:report  -> reporte completo del launcher (pagina de Estadisticas)
//   stats:places  -> tiempo por mundo y por servidor
//   stats:world(instanceId, folder) -> detalle de un mundo (tiempo en el launcher + estadisticas del juego + logros)
//   stats:ingame({ instanceId?, world? }) -> estadisticas del juego agregadas
//   stats:export('csv' | 'json') -> dialogo para guardar; devuelve { path, bytes } o null si se cancela
//   stats:reveal(ruta) -> muestra en la carpeta un archivo exportado en esta sesion
//   stats:milestonesSeen([ids]) -> marca hitos como vistos (deja de mostrarse "Nuevo")
// Eventos hacia la interfaz: 'stats:updated' ({ kind: 'session' | 'places' | 'reset' })
//                            'stats:milestone' ([{ id, icon, group, target, achievedAt }]) hitos conseguidos en la ultima partida
const fsp = require('fs/promises');
const path = require('path');
const stats = require('../core/stats');
const game = require('../core/game');
const instances = require('../core/instances');
const { t, getLanguage } = require('../core/i18n');
const activity = require('./statsplus/activity');
const ingame = require('./statsplus/ingame');
const exporter = require('./statsplus/export');

let ctx = null;
const exported = new Set(); // archivos exportados en esta sesion (los unicos que se pueden mostrar en la carpeta)

// Nombre de carpeta o id: sin separadores ni caracteres de control, y nunca "." o "..".
function validName(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 255 && !/[\\/\x00-\x1f]/.test(s) && s !== '.' && s !== '..';
}

async function safeList() {
  try {
    return await instances.list();
  } catch (err) {
    console.warn('[stats] No se pudieron leer las instancias:', err.message);
    return [];
  }
}

// Causa probable de un cierre inesperado a partir de las ultimas lineas del log.
function crashReason(logs) {
  const lines = (Array.isArray(logs) ? logs : []).slice(-600).map((l) => String(l?.text ?? l ?? ''));
  const all = lines.join('\n');
  let reasonKind = null;
  if (/OutOfMemoryError|Could not reserve enough space|insufficient memory for the Java Runtime/i.test(all)) reasonKind = 'memory';
  else if (/UnsupportedClassVersionError|compiled by a more recent version of the Java Runtime|requires Java \d+/i.test(all)) reasonKind = 'java';
  else if (/MixinApplyError|InvalidMixinException|MixinTransformerError|Mixin (?:apply|transformation) (?:for|failed)/i.test(all)) reasonKind = 'mixin';
  else if (/ModResolutionException|Incompatible mods? (?:set|found)|Missing (?:or unsupported )?mandatory dependencies|requires (?:mod|version) .* of|Mod resolution failed|DuplicateModsFoundException/i.test(all)) reasonKind = 'mods';
  else if (/EXCEPTION_ACCESS_VIOLATION|SIGSEGV|A fatal error has been detected by the Java Runtime Environment/i.test(all)) reasonKind = 'native';
  else if (/GLFW error|Pixel format not accelerated|No OpenGL context|OpenGL (?:error|version)|failed to create (?:the )?window/i.test(all)) reasonKind = 'graphics';
  let reason = null;
  for (let i = lines.length - 1; i >= 0 && !reason; i--) {
    const m = /Description: (.+)/.exec(lines[i]);
    if (m) reason = m[1];
  }
  for (let i = lines.length - 1; i >= 0 && !reason; i--) {
    const m = /((?:[a-zA-Z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error))(?::\s*(.+))?/.exec(lines[i]);
    if (m) reason = m[2] ? `${m[1]}: ${m[2]}` : m[1];
  }
  // eslint-disable-next-line no-control-regex
  const clean = reason ? reason.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 240) : null;
  return { reasonKind, reason: clean };
}

// Carpeta del mundo que se estaba jugando: la que tiene el session.lock mas cercano al inicio del tramo.
async function resolveWorld(instanceId, start) {
  let saves;
  try {
    saves = path.join(instances.dir(instanceId), 'saves');
  } catch {
    return null;
  }
  let best = null;
  for (const name of await fsp.readdir(saves).catch(() => [])) {
    const st = await fsp.stat(path.join(saves, name, 'session.lock')).catch(() => null);
    if (!st) continue;
    const diff = Math.abs(st.mtimeMs - start);
    if (diff < 10 * 60000 && (!best || diff < best.diff)) best = { name, diff };
  }
  return best ? best.name : null;
}

async function instanceName(instanceId) {
  try {
    return (await instances.get(instanceId)).name;
  } catch {
    return null;
  }
}

async function buildReport() {
  const [list, places] = await Promise.all([safeList(), activity.aggregate().catch(() => [])]);
  const report = await stats.report({
    instances: list.map((i) => ({ id: i.id, created: Number(i.created) || null })),
    worldsFirst: places.filter((p) => p.kind === 'world' && p.world).map((p) => p.first),
    serversFirst: places.filter((p) => p.kind === 'server').map((p) => p.first),
  });
  const byId = new Map(list.map((i) => [i.id, i]));
  report.byInstance = report.byInstance.map((x) => {
    const inst = byId.get(x.id);
    return { ...x, name: inst?.name || x.name, exists: Boolean(inst), mcVersion: inst?.mcVersion || null, loader: inst ? inst.preset || inst.loader : null };
  });
  report.crashes = report.crashes.map((c) => ({ ...c, name: byId.get(c.instanceId)?.name || c.name, exists: byId.has(c.instanceId) }));
  report.instancesCount = list.length;
  return report;
}

async function buildPlaces() {
  const [list, places, data] = await Promise.all([safeList(), activity.aggregate(), stats.get()]);
  const byId = new Map(list.map((i) => [i.id, i]));
  const worlds = [];
  const servers = [];
  let since = null;
  let worldMs = 0;
  let serverMs = 0;
  for (const p of places) {
    since = since === null ? p.first : Math.min(since, p.first);
    const closedMs = p.ms - (p.liveMs || 0);
    if (p.kind === 'world') {
      worldMs += closedMs;
      const inst = byId.get(p.instanceId);
      const brief = inst && p.world ? await ingame.worldBrief(inst, p.world).catch(() => null) : null;
      worlds.push({
        instanceId: p.instanceId,
        instanceName: inst?.name || p.instanceName || p.instanceId,
        instanceExists: Boolean(inst),
        mcVersion: inst?.mcVersion || null,
        loader: inst ? inst.preset || inst.loader : null,
        folder: p.world,
        name: brief?.name || p.world || null,
        exists: Boolean(brief),
        ms: p.ms,
        visits: p.visits,
        first: p.first,
        last: p.last,
        live: Boolean(p.live),
        playTimeMs: brief?.playTimeMs || 0,
      });
    } else {
      serverMs += closedMs;
      servers.push({
        address: p.address,
        ms: p.ms,
        visits: p.visits,
        first: p.first,
        last: p.last,
        live: Boolean(p.live),
        instances: Object.entries(p.instances || {})
          .map(([id, v]) => ({ id, name: byId.get(id)?.name || v.name || id, exists: byId.has(id), ms: v.ms, last: v.last }))
          .sort((a, b) => b.ms - a.ms),
      });
    }
  }
  worlds.sort((a, b) => b.ms - a.ms);
  servers.sort((a, b) => b.ms - a.ms);
  // Tiempo de partidas desde que se registra la actividad: lo que no fue mundo ni servidor son menus y cargas.
  let sessionMs = 0;
  if (since !== null) for (const s of data.sessions) if (s.end > since) sessionMs += s.end - Math.max(s.start, since);
  return { since, worlds, servers, totals: { worldMs, serverMs, sessionMs, otherMs: Math.max(0, sessionMs - worldMs - serverMs) } };
}

async function worldDetail(instanceId, folder) {
  if (!validName(instanceId) || !validName(folder)) throw new Error(t('stats.errInvalid'));
  let inst = null;
  try {
    inst = await instances.get(instanceId);
  } catch {
    inst = null;
  }
  const place = await activity.place({ kind: 'world', instanceId, world: folder }).catch(() => null);
  if (!inst && !place) throw new Error(t('stats.errInstance'));
  let detail = null;
  if (inst) {
    const dir = inst.dir || instances.dir(instanceId);
    ctx.safePath(path.join(dir, 'saves', folder));
    detail = await ingame.worldDetail({ ...inst, dir }, folder, { lang: getLanguage() });
  }
  if (!detail && !place) throw new Error(t('stats.errWorld'));
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = stats.dayKey(d);
    days.push({ day: key, ms: place?.days?.[key] || 0 });
  }
  return {
    instanceId,
    folder,
    instanceName: inst?.name || place?.instanceName || instanceId,
    instanceExists: Boolean(inst),
    mcVersion: inst?.mcVersion || null,
    loader: inst ? inst.preset || inst.loader : null,
    world: detail ? { ...detail.info, exists: true } : { name: folder, folder, exists: false },
    launcher: place
      ? { ms: place.ms, visits: place.visits, first: place.first, last: place.last, live: Boolean(place.live), days }
      : { ms: 0, visits: 0, first: null, last: null, live: false, days },
    ingame: detail?.ingame || null,
    advancements: detail?.advancements || null,
  };
}

function scopeOf(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const instanceId = o.instanceId ? String(o.instanceId) : null;
  const world = o.world && instanceId ? String(o.world) : null;
  if ((instanceId && !validName(instanceId)) || (world && !validName(world))) throw new Error(t('stats.errInvalid'));
  return { instanceId, world };
}

async function queryIngame(opts) {
  const scope = scopeOf(opts);
  const list = await safeList();
  if (scope.instanceId && !list.some((i) => i.id === scope.instanceId)) throw new Error(t('stats.errInstance'));
  const res = await ingame.query(list, scope, { lang: getLanguage() });
  if (scope.world && !res.worldsCount) throw new Error(t('stats.errWorld'));
  return res;
}

async function exportStats(format) {
  const fmt = String(format || '').toLowerCase();
  if (fmt !== 'csv' && fmt !== 'json') throw new Error(t('stats.errFormat'));
  const { dialog, app } = require('electron');
  const win = ctx.getWindow();
  const opts = {
    title: t('stats.exportTitle'),
    defaultPath: path.join(app.getPath('documents'), `${t('stats.exportFileName')}-${exporter.fileDate()}.${fmt}`),
    filters: [fmt === 'csv' ? { name: t('stats.exportFilterCsv'), extensions: ['csv'] } : { name: t('stats.exportFilterJson'), extensions: ['json'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
  const r = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return null;
  const data = await stats.get();
  let content;
  if (fmt === 'csv') {
    content = exporter.sessionsCsv(data.sessions, getLanguage());
  } else {
    const [report, places, ig] = await Promise.all([buildReport(), buildPlaces().catch(() => null), queryIngame({}).catch(() => null)]);
    const slim = ig ? { worldsCount: ig.worldsCount, withStats: ig.withStats, totals: ig.totals, advancements: { ...ig.advancements, missing: undefined }, worlds: ig.worlds } : null;
    content = exporter.statsJson({ data, report, places, ingame: slim, appVersion: app.getVersion() });
  }
  try {
    await fsp.writeFile(r.filePath, content, 'utf8');
  } catch (err) {
    throw new Error(t('stats.errExport', { error: err.message }));
  }
  exported.add(path.resolve(r.filePath));
  return { path: r.filePath, bytes: Buffer.byteLength(content) };
}

function register(context) {
  ctx = context;
  const { handle, send, onQuit } = context;

  activity.configure({ resolveWorld, instanceName });
  activity.start(game.events);

  // Fin de cada partida: codigo de salida y causa del crash (se unen a la sesion que guarda game.js)
  game.events.on('session', (s) => {
    if (s?.quiet) return; // pruebas del buscador de mods culpables
    try {
      const extra = { code: s.code ?? null, killed: Boolean(s.killed) };
      if (s.crashed) Object.assign(extra, crashReason(s.logs));
      stats.annotateSession({ instanceId: s.instanceId, start: s.start, ...extra });
    } catch (err) {
      console.error('[stats]', err);
    }
    activity.endInstance(s.instanceId, s.end);
  });
  // Arranques que fallaron antes de abrir el juego (instalacion rota, chequeo previo que bloqueo...)
  game.events.on('state', (id, st) => {
    if (st?.quiet) return;
    if (st?.state === 'stopped' && st.error) stats.countFailedLaunch();
  });

  stats.events.on('session', async (s) => {
    send('stats:updated', { kind: 'session' });
    // Hitos conseguidos en esta partida (los historicos que se calculan por primera vez no se anuncian)
    try {
      const rep = await buildReport();
      const fresh = rep.milestones.filter((m) => rep.newlyUnlocked.includes(m.id) && m.achievedAt >= s.start - 60000);
      if (fresh.length) send('stats:milestone', fresh.map((m) => ({ id: m.id, icon: m.icon, group: m.group, target: m.target, achievedAt: m.achievedAt })));
    } catch (err) {
      console.error('[stats] hitos:', err);
    }
  });
  activity.events.on('segment', () => send('stats:updated', { kind: 'places' }));
  stats.onReset(() => {
    activity.clear().finally(() => send('stats:updated', { kind: 'reset' }));
  });

  handle('stats:summary', () => stats.summary());
  handle('stats:report', () => buildReport());
  handle('stats:places', () => buildPlaces());
  handle('stats:world', (instanceId, folder) => worldDetail(instanceId, folder));
  handle('stats:ingame', (opts) => queryIngame(opts));
  handle('stats:export', (format) => exportStats(format));
  handle('stats:reveal', async (p) => {
    const full = typeof p === 'string' ? path.resolve(p) : '';
    if (!exported.has(full)) throw new Error(t('stats.errInvalid'));
    require('electron').shell.showItemInFolder(full);
    return true;
  });
  handle('stats:milestonesSeen', (ids) => stats.markMilestonesSeen(ids));

  onQuit(async () => {
    await activity.flush();
    await stats.flush();
  });
}

module.exports = { register, crashReason, buildReport, buildPlaces, worldDetail, queryIngame };
