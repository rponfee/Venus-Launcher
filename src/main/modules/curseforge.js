'use strict';
// Modulo del proceso principal del dueño "modrinth" (se autocarga):
//  - CurseForge (con la API key del launcher de core/app-config.js; sin key queda desactivado): busqueda,
//    proyectos, archivos, instalacion en instancias, modpacks y huellas (fingerprints).
//  - Canales extra del catalogo de Modrinth que usan la pagina y el dialogo de instalacion
//    (equipo, pedidos en lote, filtros por tipo de proyecto).
//
// Para otros modulos del proceso principal (importar packs, analisis de seguridad):
//   const curseforge = require('./curseforge');
//   await curseforge.available()                 -> CurseForge esta disponible (el launcher trae API key)
//   await curseforge.getMods([ids])              -> mods (datos crudos de la API de CurseForge)
//   await curseforge.getFiles([fileIds])         -> archivos (crudos; downloadUrl puede venir null)
//   await curseforge.fingerprintMatches([n])     -> { exactMatches, exactFingerprints, unmatchedFingerprints, ... }
//   curseforge.computeFingerprint(buffer)        -> huella (murmur2 sin espacios, semilla 1)
//   await curseforge.fingerprintFile(ruta)       -> huella de un archivo sin cargarlo entero
const { t } = require('../core/i18n');
const tasks = require('../core/tasks');
const instances = require('../core/instances');
const modrinth = require('../core/modrinth');
const cf = require('./curseforge/api');
const cfInstall = require('./curseforge/install');
const { computeFingerprint, fingerprintFile } = require('./curseforge/fingerprint');

let emit = () => {};

function toId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(t('curseforge.errBadId'));
  return n;
}

async function status() {
  return { configured: await cf.hasKey(), classIds: cf.CLASS_IDS, maxResults: cf.MAX_WINDOW };
}

function list(value, max = 500) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string' || typeof v === 'number').slice(0, max) : [];
}

function register({ handle, send }) {
  emit = (channel, ...args) => {
    try {
      send(channel, ...args);
    } catch {
      /* ventana cerrada */
    }
  };

  // ---------- CurseForge ----------
  handle('curseforge:status', status);
  handle('curseforge:search', (params) => cf.search(params && typeof params === 'object' ? params : {}));
  handle('curseforge:project', async (id) => {
    const modId = toId(id);
    const [raw, body] = await Promise.all([cf.getModRaw(modId), cf.getDescription(modId).catch(() => '')]);
    return { ...cf.normalizeMod(raw), body };
  });
  handle('curseforge:files', async (id, filters = {}) => {
    const res = await cf.getModFiles(toId(id), filters && typeof filters === 'object' ? filters : {});
    return { files: res.data.map(cf.normalizeFile), total: res.total, index: res.index, pageSize: res.pageSize };
  });
  // instanceId vacio = modpack (crea una instancia nueva). opts: { world, name, dependencies }
  handle('curseforge:install', async (instanceId, modId, fileId, opts = {}) => {
    const mId = toId(modId);
    const fId = fileId ? toId(fileId) : null;
    const o = opts && typeof opts === 'object' ? opts : {};
    if (!instanceId) {
      if (!fId) throw new Error(t('curseforge.errNoFile'));
      const mod = await cf.getModRaw(mId);
      return tasks.run(t('curseforge.taskModpack', { name: mod?.name || mId }), async (task) => {
        const r = await cfInstall.installModpack(mId, fId, { task, name: typeof o.name === 'string' ? o.name.slice(0, 60) : undefined, onCreated: () => emit('instances:changed') });
        emit('instances:changed');
        return r;
      });
    }
    const inst = await instances.get(instanceId);
    return tasks.run(
      t('curseforge.taskInstall', { name: inst.name }),
      async (task) => {
        const r = await cfInstall.installToInstance(inst.id, mId, fId, { world: o.world, task, dependencies: o.dependencies !== false });
        emit('instances:changed');
        return r;
      },
      { instanceId: inst.id },
    );
  });
  handle('curseforge:fingerprints', (hashes) => cf.fingerprintMatches(list(hashes, 2000)));
  handle('curseforge:categories', (type) => cf.getCategories(type));
  handle('curseforge:changelog', (modId, fileId) => cf.getChangelog(toId(modId), toId(fileId)));

  // ---------- Modrinth: catalogo completo ----------
  handle('modrinth:projects', (ids) => modrinth.getProjects(list(ids)));
  handle('modrinth:team', (id) => modrinth.getTeam(String(id || '')));
  handle('modrinth:version', (id) => modrinth.getVersion(String(id || '')));
  handle('modrinth:versionsByIds', (ids) => modrinth.getVersionsByIds(list(ids)));
  handle('modrinth:facets', (type) => modrinth.getTypeTags(type));
}

module.exports = {
  register,
  available: cf.hasKey,
  getMods: cf.getMods,
  getFiles: cf.getFiles,
  getMod: async (id) => cf.normalizeMod(await cf.getModRaw(toId(id))),
  getModFiles: cf.getModFiles,
  getDownloadUrl: cf.getDownloadUrl,
  search: cf.search,
  fingerprintMatches: cf.fingerprintMatches,
  computeFingerprint,
  fingerprintFile,
  installToInstance: cfInstall.installToInstance,
  installModpack: cfInstall.installModpack,
  normalizeMod: cf.normalizeMod,
  normalizeFile: cf.normalizeFile,
  CLASS_IDS: cf.CLASS_IDS,
};
