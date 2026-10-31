'use strict';
// Instalacion del "kit" del Buscador inteligente: instala varios proyectos de Modrinth en una
// instancia (o plugins en un servidor) uno por uno, como una sola tarea con progreso y cancelacion.
const L = require('./lexicon');
const { t } = require('../../core/i18n');

const MAX_ITEMS = 80;
const ID_RE = /^[\w.-]{2,64}$/;
const LOADERS = ['vanilla', 'fabric', 'forge', 'neoforge', 'quilt', 'optifine'];

function core() {
  return { instances: require('../../core/instances'), servers: require('../../core/servers'), tasks: require('../../core/tasks') };
}

function cleanItems(items) {
  if (!Array.isArray(items) || !items.length) throw new Error(t('smartsearch.errNothingToInstall'));
  if (items.length > MAX_ITEMS) throw new Error(t('smartsearch.errTooMany', { max: MAX_ITEMS }));
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it || !ID_RE.test(String(it.projectId || ''))) throw new Error(t('smartsearch.errInvalid'));
    if (seen.has(it.projectId)) continue;
    seen.add(it.projectId);
    out.push({
      projectId: String(it.projectId),
      versionId: it.versionId && ID_RE.test(String(it.versionId)) ? String(it.versionId) : null,
      type: L.TYPES.includes(it.type) ? it.type : 'mod',
      title: String(it.title || it.projectId).slice(0, 120),
    });
  }
  return out;
}

function cleanWorld(world) {
  if (!world) return null;
  const w = String(world);
  if (w.includes('/') || w.includes('\\') || w === '.' || w === '..' || w.length > 120) throw new Error(t('smartsearch.errInvalid'));
  return w;
}

// Crea la instancia sin descargar todavia el juego (eso se hace al terminar de instalar el kit).
async function createInstance(opts = {}, { send } = {}) {
  const { instances } = core();
  const mcVersion = String(opts.mcVersion || '').trim();
  if (!/^[\w.-]{2,40}$/.test(mcVersion)) throw new Error(t('smartsearch.errInvalid'));
  const loader = LOADERS.includes(opts.loader) ? opts.loader : 'vanilla';
  const preset = opts.preset === 'iris' && loader === 'fabric' ? 'iris' : null;
  const name = String(opts.name || '').replace(/\s+/g, ' ').trim().slice(0, 60) || undefined;
  const icon = typeof opts.icon === 'string' && /^https:\/\//.test(opts.icon) ? opts.icon : null;
  const inst = await instances.create({ name, mcVersion, loader, loaderVersion: 'latest', preset, icon });
  send?.('instances:changed');
  return inst;
}

/**
 * Instala el kit. opts: { target: { kind: 'instance'|'server', id }, items, world?, prepare?, jobId? }
 * Emite 'smartsearch:installProgress' { jobId, index, state, installed?, warnings?, error? }.
 */
async function installKit(opts = {}, { send } = {}) {
  const { instances, servers, tasks } = core();
  const kind = opts.target?.kind === 'server' ? 'server' : 'instance';
  const id = String(opts.target?.id || '');
  if (!ID_RE.test(id)) throw new Error(t('smartsearch.errInvalid'));
  const items = cleanItems(opts.items);
  const world = cleanWorld(opts.world);
  const jobId = typeof opts.jobId === 'string' && /^[\w-]{4,40}$/.test(opts.jobId) ? opts.jobId : null;
  let owner;
  try {
    owner = kind === 'instance' ? await instances.get(id) : await servers.get(id);
  } catch {
    throw new Error(t(kind === 'instance' ? 'smartsearch.errNoInstance' : 'smartsearch.errNoServer'));
  }
  if (kind === 'server' && owner.type === 'vanilla') throw new Error(t('smartsearch.errVanillaServer'));
  const emit = (data) => send?.('smartsearch:installProgress', { jobId, ...data });
  const title = t(kind === 'instance' ? 'smartsearch.taskInstallKit' : 'smartsearch.taskInstallKitServer', { name: owner.name });
  const total = items.length;
  const results = [];

  const summary = await tasks.run(
    title,
    async (task) => {
      for (let i = 0; i < total; i++) {
        const it = items[i];
        if (task.signal.aborted) {
          for (let k = i; k < total; k++) {
            results.push({ ...items[k], state: 'skipped' });
            emit({ index: k, state: 'skipped' });
          }
          break;
        }
        emit({ index: i, state: 'installing' });
        task.update({ detail: t('smartsearch.taskItem', { title: it.title, index: i + 1, total }), progress: i / total });
        // Tarea "proxy": el progreso de cada descarga se mapea a su parte de la barra total.
        const proxy = {
          signal: task.signal,
          update: ({ detail } = {}) => detail && task.update({ detail }),
          downloadProgress: () => ({ done, total: n, bytes, totalBytes }) => {
            const frac = totalBytes > 0 ? bytes / totalBytes : n ? done / n : 1;
            task.update({ progress: (i + Math.min(1, frac)) / total });
          },
        };
        try {
          if (it.type === 'datapack' && kind === 'instance' && !world) throw new Error(t('smartsearch.errNoWorld'));
          const r =
            kind === 'instance'
              ? await instances.installProject(id, it.projectId, it.versionId, { task: proxy, world: it.type === 'datapack' ? world : undefined, type: it.type === 'modpack' ? undefined : it.type })
              : await servers.installProject(id, it.projectId, it.versionId, proxy);
          results.push({ ...it, state: 'done', installed: r.installed || [], warnings: r.warnings || [] });
          emit({ index: i, state: 'done', installed: r.installed || [], warnings: r.warnings || [] });
        } catch (err) {
          if (task.signal.aborted) {
            results.push({ ...it, state: 'skipped' });
            emit({ index: i, state: 'skipped' });
            continue;
          }
          results.push({ ...it, state: 'error', error: err.message });
          emit({ index: i, state: 'error', error: err.message });
        }
      }
      const ok = results.filter((r) => r.state === 'done').length;
      task.update({ detail: t('smartsearch.kitResult', { ok, total }), progress: 1 });
      if (task.signal.aborted) throw new Error(t('smartsearch.errCanceled'));
      return { ok, total, results };
    },
    kind === 'instance' ? { instanceId: id } : { serverId: id },
  ).finally(() => {
    send?.(kind === 'instance' ? 'instances:changed' : 'servers:changed');
  });

  // Para una instancia nueva: descargar el juego y el loader cuando el kit ya esta.
  if (opts.prepare && kind === 'instance') {
    tasks
      .run(t('smartsearch.taskPrepare', { name: owner.name }), (task) => instances.prepare(id, task), { instanceId: id })
      .then(() => send?.('instances:changed'))
      .catch(() => send?.('instances:changed'));
  }
  return summary;
}

module.exports = { installKit, createInstance };
