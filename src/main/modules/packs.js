'use strict';
// Modpacks: ver que cambia antes de actualizar un modpack de Modrinth (y actualizarlo con instantanea previa),
// exportar instancias (.mrpack o .zip de Prism/MultiMC) e importar packs (.mrpack, CurseForge, Prism/MultiMC).
// La logica vive en ./packs/ (sin Electron): zip.js, state.js, lookup.js, mrpack.js, diff.js, update.js,
// export.js e import.js.
//
// Para otros modulos del proceso principal:
//   const packs = require('./packs');
//   await packs.recordInstall(instanceId, rutaMrpack, { projectId, versionId })  // despues de instalar un .mrpack
//   await packs.diff(instanceId, versionId?)                                     // misma respuesta que packs:diff
const fsp = require('fs/promises');
const path = require('path');
const instances = require('../core/instances');
const { t } = require('../core/i18n');
const { sanitizeFileName } = require('../core/util');
const { diff } = require('./packs/diff');
const { update } = require('./packs/update');
const exporter = require('./packs/export');
const importer = require('./packs/import');
const { readPack } = require('./packs/mrpack');
const { clientFiles, writeState, resolveInside } = require('./packs/state');

// Guarda el estado del pack para una instancia instalada desde un .mrpack por otro modulo (core/modrinth):
// asi las actualizaciones saben que archivos son del pack y cuales agrego el usuario.
async function recordInstall(instanceId, mrpackFile, meta = {}) {
  const inst = await instances.get(instanceId);
  const { index, overrides } = await readPack(mrpackFile);
  const files = {};
  for (const f of clientFiles(index).values()) files[f.path] = { sha1: f.sha1, src: 'index' };
  for (const [rel, sha1] of Object.entries(overrides)) if (resolveInside(inst.dir, rel)) files[rel] = { sha1, src: 'override' };
  const pack = inst.modrinth?.pack || {};
  await writeState(inst.dir, {
    meta: { projectId: meta.projectId || pack.projectId || null, versionId: meta.versionId || pack.versionId || null, versionNumber: index.versionId || pack.version || null, installedAt: Date.now() },
    index,
    overrides,
    files,
  });
  return true;
}

function register({ handle, send, getWindow }) {
  const { dialog, shell, app } = require('electron');
  const exported = new Set(); // solo se pueden mostrar en la carpeta los archivos exportados en esta sesion
  const changed = () => {
    try {
      send('instances:changed');
    } catch {
      /* ventana cerrada */
    }
  };
  const str = (v) => (typeof v === 'string' && v ? v : null);

  handle('packs:diff', (id, versionId) => diff(str(id), str(versionId)));
  handle('packs:update', (id, versionId, opts) => {
    const o = opts && typeof opts === 'object' ? opts : {};
    return update(str(id), str(versionId), { snapshot: o.snapshot !== false, worlds: o.worlds === 'all' ? 'all' : 'none' }, { onChanged: changed });
  });

  handle('packs:exportPreview', (id, opts) => exporter.preview(str(id), opts));
  handle('packs:export', async (id, opts) => {
    const inst = await instances.get(str(id));
    const o = exporter.normalizeOpts(opts);
    const defaults = exporter.defaultsFor(inst);
    const ext = o.format === 'zip' ? 'zip' : 'mrpack';
    const base = sanitizeFileName(`${o.name || defaults.name} ${o.version || defaults.version}`).replace(/\s+/g, '-');
    let dir;
    try {
      dir = app.getPath('downloads');
    } catch {
      dir = app.getPath('documents');
    }
    const r = await dialog.showSaveDialog(getWindow(), {
      title: t('packs.saveTitle'),
      defaultPath: path.join(dir, `${base}.${ext}`),
      filters: [{ name: ext === 'zip' ? t('packs.filterZip') : t('packs.filterMrpack'), extensions: [ext] }],
    });
    if (r.canceled || !r.filePath) return null;
    let dest = r.filePath;
    if (path.extname(dest).toLowerCase() !== `.${ext}`) dest += `.${ext}`;
    const res = await exporter.exportPack(inst.id, o, dest);
    exported.add(path.resolve(res.file));
    return res;
  });
  handle('packs:reveal', (file) => {
    const full = typeof file === 'string' ? path.resolve(file) : '';
    if (!exported.has(full)) throw new Error(t('packs.errReveal'));
    shell.showItemInFolder(full);
    return true;
  });

  const pick = async () => {
    const r = await dialog.showOpenDialog(getWindow(), {
      title: t('packs.openTitle'),
      properties: ['openFile'],
      filters: [{ name: t('packs.filterPacks'), extensions: ['mrpack', 'zip'] }],
    });
    return r.canceled || !r.filePaths?.[0] ? null : r.filePaths[0];
  };
  handle('packs:pickFile', pick);
  handle('packs:inspect', async (file) => {
    const f = str(file) || (await pick());
    return f ? importer.inspect(f) : null;
  });
  // Contrato: packs:import(filePath?) -> si no se pasa ruta abre el selector de archivos.
  handle('packs:import', async (file, opts) => {
    const f = str(file) || (await pick());
    if (!f) return null;
    await fsp.access(f).catch(() => {
      throw new Error(t('packs.errFileMissing'));
    });
    const name = opts && typeof opts.name === 'string' ? opts.name : undefined;
    return importer.importPack(f, { name }, { onCreated: changed, onChanged: changed });
  });
}

module.exports = {
  register,
  recordInstall,
  diff,
  update,
  inspect: importer.inspect,
  importPack: importer.importPack,
  exportPreview: exporter.preview,
};
