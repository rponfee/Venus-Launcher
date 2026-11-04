'use strict';
// Changelog explicado por IA: "¿Qué cambia?" trae los changelogs entre la versión instalada de un mod y la nueva
// (Modrinth y CurseForge), los devuelve tal cual y, si el usuario lo pide, los resume con la IA de su plan
// (modules/ai.js, una sola consulta). Sin plan o sin conexión se ve solo el texto original. Solo corre porque el
// usuario apretó un botón: no consulta nada por su cuenta. Lógica pura en ./modchangelog/logic.js.
// Canales:
//   modchangelog:forFile(instanceId, { folder?, file }) -> { token, source, title, icon, slug, file, from, to, upToDate,
//       versions: [{ id, number, type, date, body, truncated }], moreVersions }
//   modchangelog:list(instanceId) -> { items: [{ source, projectId, folder, file, title, icon, from, to }], total }
//   modchangelog:aiStatus()       -> { available, reason: null | 'offline' | 'disabled' | 'signedOut' | 'noPlan' }
//   modchangelog:explain(token)   -> { summary, news, risks, at } (el texto es el que ya se mostró; se guarda en memoria)
// Errores con err.code (la interfaz los traduce): offline, unknownOrigin, notInCatalog, curseforgeOff, badToken; los de
// la IA llegan con sus códigos (6.7 de docs/arquitectura.md) y su mensaje traducido.
const instances = require('../core/instances');
const modrinth = require('../core/modrinth');
const http = require('../core/http');
const { getLanguage } = require('../core/i18n');
const { uid } = require('../core/util');
const logic = require('./modchangelog/logic');

const FOLDERS = new Set(['mods', 'resourcepacks', 'shaderpacks']);
const MAX_RESULTS = 20;
const CF_CONCURRENCY = 4;
const CF_MAX_MODS = 60;
const CF_PAGE = 50;

function codeError(code) {
  return Object.assign(new Error(code), { code });
}

function assertOnline() {
  if (http.isOffline()) throw codeError('offline');
}

// Lo que se mostró queda en memoria (lo último): a la IA va ese texto y no lo que mande la interfaz.
const results = new Map();
function remember(result) {
  const token = uid(16);
  results.set(token, result);
  while (results.size > MAX_RESULTS) results.delete(results.keys().next().value);
  return token;
}

const strip = (file) => String(file ?? '').replace(/\.disabled$/i, '');

function recordOf(projects, folder, file) {
  for (const [id, rec] of Object.entries(projects || {})) {
    if (strip(rec?.file) === file && (!rec.folder || rec.folder === folder)) return { id, rec };
  }
  return null;
}

// De dónde salió un archivo: los registros de la instancia o, si no hay, Modrinth por su hash.
async function originOf(inst, folder, file, deps) {
  const cf = recordOf(inst.curseforge?.projects, folder, file);
  if (cf?.rec?.fileId) return { source: 'curseforge', projectId: Number(cf.id), fileId: Number(cf.rec.fileId), title: cf.rec.title, icon: cf.rec.icon, versionNumber: cf.rec.versionNumber };
  const mr = recordOf(inst.modrinth?.projects, folder, file);
  if (mr?.rec?.versionId) return { source: 'modrinth', projectId: mr.id, versionId: mr.rec.versionId, title: mr.rec.title, icon: mr.rec.icon, versionNumber: mr.rec.versionNumber };
  const listed = await deps.modrinth.listFolder(inst.dir, folder);
  const found = listed.filter((f) => strip(f.file) === file);
  if (!found.length) throw codeError('unknownOrigin');
  const hit = Object.values(await deps.modrinth.identify(inst.dir, found))[0];
  if (!hit) throw codeError('unknownOrigin');
  return { source: 'modrinth', projectId: hit.projectId, versionId: hit.versionId, title: hit.title, icon: hit.icon, slug: hit.slug, versionNumber: hit.versionNumber };
}

function loadersFor(inst, folder, deps) {
  return folder === 'mods' ? deps.modrinth.modLoadersFor(inst) : [];
}

function view(number, type, date, raw, { html = false } = {}) {
  const { body, truncated } = logic.trimEntry(html ? logic.htmlToText(raw) : raw);
  return { number, type, date, body, truncated };
}

async function modrinthChanges(inst, folder, origin, deps) {
  const loaders = loadersFor(inst, folder, deps);
  const filters = { gameVersions: inst.mcVersion ? [inst.mcVersion] : undefined, loaders: loaders.length ? loaders : undefined };
  let versions = await deps.modrinth.getVersions(origin.projectId, filters);
  // La versión instalada puede no estar en esa lista (se instaló a mano o el autor la sacó de esa versión de Minecraft).
  if (!versions.some((v) => v.id === origin.versionId)) {
    const installed = await deps.modrinth.getVersion(origin.versionId).catch(() => null);
    if (!installed) throw codeError('notInCatalog');
    versions = [...versions, installed];
  }
  const { current, target, between } = logic.modrinthBetween(versions, origin.versionId);
  const project = origin.slug && origin.title && origin.icon ? null : await deps.modrinth.getProject(origin.projectId).catch(() => null);
  return {
    source: 'modrinth',
    projectId: origin.projectId,
    title: origin.title || project?.title || null,
    icon: origin.icon || project?.icon_url || null,
    slug: origin.slug || project?.slug || null,
    from: current?.version_number || origin.versionNumber || null,
    to: target?.version_number || null,
    upToDate: !target,
    moreVersions: Math.max(0, between.length - logic.MAX_VERSIONS),
    versions: between.slice(0, logic.MAX_VERSIONS).map((v) => ({ id: v.id, ...view(v.version_number, v.version_type, v.date_published, v.changelog) })),
  };
}

async function curseforgeChanges(inst, folder, origin, deps) {
  if (!(await deps.curseforge.available())) throw codeError('curseforgeOff');
  const res = await deps.curseforge.getModFiles(origin.projectId, { gameVersion: inst.mcVersion, loader: folder === 'mods' ? inst.loader : undefined, pageSize: CF_PAGE });
  const files = res.data.map(deps.curseforge.normalizeFile);
  const { current, target, between } = logic.curseforgeBetween(files, origin.fileId);
  const shown = between.slice(0, logic.MAX_VERSIONS);
  // Los pedidos de a uno: CurseForge los recuerda un rato y son pocos.
  const texts = [];
  for (const f of shown) texts.push(await deps.curseforge.getChangelog(origin.projectId, f.id).catch(() => ''));
  return {
    source: 'curseforge',
    projectId: origin.projectId,
    title: origin.title || null,
    icon: origin.icon || null,
    slug: null,
    from: current?.displayName || origin.versionNumber || null,
    to: target?.displayName || null,
    upToDate: !target,
    moreVersions: Math.max(0, between.length - logic.MAX_VERSIONS),
    versions: shown.map((f, i) => ({ id: String(f.id), ...view(f.displayName, f.releaseType, f.date, texts[i], { html: true }) })),
  };
}

function realDeps() {
  const cf = require('./curseforge/api');
  return { modrinth, curseforge: { available: cf.hasKey, getModFiles: cf.getModFiles, getChangelog: cf.getChangelog, normalizeFile: cf.normalizeFile }, ai: require('./ai') };
}

async function forFile(instanceId, { folder = 'mods', file } = {}, deps = realDeps()) {
  if (!FOLDERS.has(folder) || typeof file !== 'string' || !file) throw codeError('unknownOrigin');
  assertOnline();
  const inst = await instances.get(instanceId);
  const name = strip(file);
  const origin = await originOf(inst, folder, name, deps);
  const changes = origin.source === 'curseforge' ? await curseforgeChanges(inst, folder, origin, deps) : await modrinthChanges(inst, folder, origin, deps);
  const result = { ...changes, folder, file: name, title: changes.title || name };
  return { token: remember(result), ...result };
}

// Mods con una actualización: Modrinth con compat (hash de cada archivo) y CurseForge con sus registros.
async function curseforgeUpdates(inst, deps) {
  const records = Object.entries(inst.curseforge?.projects || {}).filter(([, r]) => r?.fileId && FOLDERS.has(r.folder || 'mods')).slice(0, CF_MAX_MODS);
  if (!records.length || !(await deps.curseforge.available())) return [];
  const items = [];
  const queue = [...records];
  const worker = async () => {
    while (queue.length) {
      const [id, rec] = queue.shift();
      const folder = rec.folder || 'mods';
      const res = await deps.curseforge.getModFiles(Number(id), { gameVersion: inst.mcVersion, loader: folder === 'mods' ? inst.loader : undefined, pageSize: CF_PAGE }).catch(() => null);
      if (!res) continue;
      const { target } = logic.curseforgeBetween(res.data.map(deps.curseforge.normalizeFile), Number(rec.fileId));
      if (target) items.push({ source: 'curseforge', projectId: Number(id), folder, file: strip(rec.file), title: rec.title || strip(rec.file), icon: rec.icon || null, from: rec.versionNumber || null, to: target.displayName });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CF_CONCURRENCY, queue.length) }, worker));
  return items;
}

async function listUpdates(instanceId, deps = realDeps()) {
  assertOnline();
  const inst = await instances.get(instanceId);
  const compat = require('./compat');
  const [mr, cf] = await Promise.all([compat.listUpdates(instanceId, { includeBeta: false }).catch((err) => (console.warn('[modchangelog] compat:', err?.message || err), { items: [], total: 0 })), curseforgeUpdates(inst, deps)]);
  const seen = new Set(mr.items.map((i) => `${i.folder}/${strip(i.file)}`));
  const items = mr.items.map((i) => ({ source: 'modrinth', projectId: i.projectId, folder: i.folder, file: strip(i.file), title: i.title, icon: i.icon, from: i.current?.versionNumber || null, to: i.latest?.versionNumber || null }));
  for (const c of cf) if (!seen.has(`${c.folder}/${c.file}`)) items.push(c);
  items.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  return { items, total: mr.total || items.length };
}

async function aiStatus(deps = realDeps()) {
  if (http.isOffline()) return { available: false, reason: 'offline' };
  const s = await deps.ai.status({});
  if (!s.enabled) return { available: false, reason: 'disabled' };
  if (!s.provider) return { available: false, reason: 'signedOut' };
  const q = s.quota;
  if (q && (q.status === 'none' || !q.plan)) return { available: false, reason: 'noPlan' };
  return { available: true, reason: null };
}

async function explain(token, deps = realDeps()) {
  const result = results.get(token);
  if (!result) throw codeError('badToken');
  if (result.explained) return result.explained;
  assertOnline();
  const req = logic.buildRequest({ title: result.title, from: result.from, to: result.to, entries: result.versions, lang: getLanguage() });
  const answer = await deps.ai.json({ system: req.system, prompt: req.prompt, schema: req.schema, maxTokens: 2000, effort: 'low', turnId: `modchangelog-${uid(12)}` });
  const out = { ...logic.normalizeAnswer(answer), at: Date.now() };
  result.explained = out;
  return out;
}

// Capturas (VENUS_CHANGELOG_FAKE=1, solo con VENUS_DEVSHOT y sin empaquetar): IA de ejemplo, no consulta nada.
const FAKE_ANSWER = { summary: 'Mejora el rendimiento y arregla errores chicos; no hace falta un mundo nuevo.', news: ['Arregla un error al abrir el juego', 'Mejores mensajes en el registro de errores'], risks: ['Puede no llevarse bien con mods que cambian el dibujo del mundo'] };

function register({ app, handle }) {
  const fake = Boolean(process.env.VENUS_CHANGELOG_FAKE && process.env.VENUS_DEVSHOT && !app.isPackaged);
  handle('modchangelog:forFile', (instanceId, opts) => forFile(instanceId, opts && typeof opts === 'object' ? opts : {}));
  handle('modchangelog:list', (instanceId) => listUpdates(instanceId));
  handle('modchangelog:aiStatus', () => (fake ? { available: true, reason: null } : aiStatus()));
  handle('modchangelog:explain', (token) => (fake ? { ...FAKE_ANSWER, at: Date.now() } : explain(token)));
}

module.exports = { register, forFile, listUpdates, aiStatus, explain };
