'use strict';
// Competir (docs/wip/competir-33.md): el proceso principal solo calcula lo que hay para compartir en los rankings, porque
// necesita leer el disco. Los rankings, los desafíos y los eventos van directo de la interfaz a Supabase (0031_competencia).
//
// Canales:
//   compete:collect({ userId }) -> { off: true } | { first: true, reports: [] } | { token, reports: [{ week, minutes, diamonds, mobs, blocks, deaths }] }
//       Con settings.compete.share apagado no lee nada. La primera vez (o con otra cuenta de Venus) solo saca la foto: lo
//       que ya estaba no se envía nunca.
//   compete:commit(token, week) -> true/false   el servidor aceptó ese envío: esa semana pasa a ser el nuevo punto de partida
//   compete:reset() -> true                      olvida el punto de partida (al prender o apagar compartir)
// Datos: data/compete.json = { version, userId, cursor, files: { '<instancia>|<mundo>|<uuid>': { mtimeMs, size, ...totales } } }
const paths = require('../core/paths');
const settings = require('../core/settings');
const stats = require('../core/stats');
const game = require('../core/game');
const instances = require('../core/instances');
const { readJson, writeJson, uid } = require('../core/util');
const logic = require('./compete/logic');
const { scanStats, cleanUuid } = require('./compete/scan');

const FILE = () => paths.data('compete.json');
let pending = null; // el último collect: { token, reports } (con los archivos de cada semana)

const load = async () => {
  const data = await readJson(FILE(), null).catch(() => null);
  return data && typeof data === 'object' && data.files && typeof data.files === 'object' ? data : null;
};
const save = (state) => writeJson(FILE(), state);

// Las cuentas de Minecraft de este launcher: solo sus archivos de estadísticas cuentan.
async function knownUuids() {
  try {
    const r = await require('../core/accounts').list();
    return new Set((r?.accounts || []).map((a) => cleanUuid(a.uuid)).filter(Boolean));
  } catch {
    return new Set();
  }
}

// El registro de partidas más las que siguen abiertas.
async function sessionsNow(now) {
  const data = await stats.get();
  const closed = Array.isArray(data?.sessions) ? data.sessions : [];
  const open = Object.values(game.status()).filter((r) => r?.state === 'running' && !r.quiet && r.startedAt).map((r) => ({ start: r.startedAt, end: now }));
  return [...closed, ...open];
}

async function collect(opts) {
  pending = null;
  const userId = typeof opts?.userId === 'string' && opts.userId ? opts.userId : null;
  if (!userId || (await settings.get()).compete?.share !== true) return { off: true, reports: [] };
  const now = Date.now();
  const [list, known, saved] = await Promise.all([instances.list().catch(() => []), knownUuids(), load()]);
  if (!saved || saved.userId !== userId || !Number.isFinite(saved.cursor)) {
    await save({ version: 1, userId, cursor: now, files: logic.firstSnapshot(await scanStats(list, known, {})) });
    return { first: true, reports: [] };
  }
  const scanned = await scanStats(list, known, saved.files);
  const plan = logic.buildReports({ baseline: saved.files, scanned, sessions: await sessionsNow(now), cursor: saved.cursor, now });
  // Lo que no se envía se anota ahora; lo que se envía, recién cuando el servidor lo acepta. Lo que ya no existe se olvida.
  const seen = new Set(scanned.map((f) => f.key));
  const files = Object.fromEntries(Object.entries(saved.files).filter(([k]) => seen.has(k)));
  Object.assign(files, plan.silent);
  await save({ ...saved, files, cursor: plan.cursor ?? saved.cursor });
  if (!plan.reports.length) return { reports: [] };
  pending = { token: uid(), reports: plan.reports };
  return { token: pending.token, reports: plan.reports.map(({ files: _f, cursor: _c, ...report }) => report) };
}

async function commit(token, week) {
  const report = pending && pending.token === token ? pending.reports.find((r) => r.week === week) : null;
  if (!report) return false;
  const saved = await load();
  if (!saved) return false;
  await save({ ...saved, files: { ...saved.files, ...report.files }, cursor: report.cursor ?? saved.cursor });
  pending.reports = pending.reports.filter((r) => r !== report);
  return true;
}

async function reset() {
  pending = null;
  await save({ version: 1, files: {} });
  return true;
}

function register({ handle }) {
  handle('compete:collect', (opts) => collect(opts));
  handle('compete:commit', (token, week) => commit(token, week));
  handle('compete:reset', () => reset());
}

module.exports = { register, collect, commit, reset };
