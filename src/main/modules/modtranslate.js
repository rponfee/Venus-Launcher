'use strict';
// Traduccion automatica de mods: detecta los mods que no tienen textos en el idioma elegido, los traduce
// con IA (conservando %s, §a, {0}...), y genera el paquete de recursos "venus-auto-translations" marcado
// como traduccion automatica. El jugador puede corregir cada texto (queda "revisado") y compartir el
// resultado con la comunidad (archivo .json o paquete .zip).
// Canales: modtranslate:scan, :run, :cancel, :status, :get, :save, :export, :import, :clear,
//          :setEnabled, :setGameLanguage, :openPack, :reveal
// Eventos: modtranslate:progress (instanceId, estado), modtranslate:scanProgress (instanceId, { done, total })
const fsp = require('fs/promises');
const path = require('path');
const { t } = require('../core/i18n');
const instances = require('../core/instances');
const engine = require('./modtranslate/engine');
const pack = require('./modtranslate/pack');

const exported = new Set(); // archivos exportados en esta sesion (los unicos que se pueden mostrar en la carpeta)

function checkId(instanceId) {
  if (typeof instanceId !== 'string' || !instanceId) throw new Error(t('modtranslate.errNoInstance'));
  return instanceId;
}

function plainOpts(o) {
  return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
}

function register({ handle, send, getWindow, safePath, onQuit, app }) {
  engine.configure({
    ai: require('./ai'),
    send,
    trash: (p) => require('electron').shell.trashItem(safePath(p)),
    appVersion: app?.getVersion?.() || null,
  });

  const win = () => {
    const w = getWindow();
    return w && !w.isDestroyed() ? w : null;
  };

  handle('modtranslate:scan', async (instanceId, opts) => {
    checkId(instanceId);
    const o = plainOpts(opts);
    let last = 0;
    return engine.analyze(instanceId, { locale: o.locale, remember: Boolean(o.locale) }, (p) => {
      const now = Date.now();
      if (now - last < 120 && p.done < p.total) return;
      last = now;
      send('modtranslate:scanProgress', instanceId, { done: p.done, total: p.total });
    });
  });

  handle('modtranslate:run', (instanceId, opts) => {
    checkId(instanceId);
    const o = plainOpts(opts);
    return engine.run(instanceId, { locale: o.locale, mods: o.mods, setLanguage: Boolean(o.setLanguage) });
  });

  handle('modtranslate:cancel', (instanceId) => engine.cancel(checkId(instanceId)));
  handle('modtranslate:status', (instanceId) => engine.status(checkId(instanceId)));

  handle('modtranslate:get', (instanceId, opts) => engine.entries(checkId(instanceId), plainOpts(opts)));
  handle('modtranslate:save', (instanceId, opts) => engine.save(checkId(instanceId), plainOpts(opts)));

  // Exporta con un dialogo de guardado. format: 'json' (para compartir y corregir) | 'zip' (paquete listo)
  handle('modtranslate:export', async (instanceId, opts) => {
    checkId(instanceId);
    const o = plainOpts(opts);
    const format = o.format === 'zip' ? 'zip' : 'json';
    const data = await engine.buildExport(instanceId, { locale: o.locale, mods: o.mods, format });
    const { dialog, app: eapp } = require('electron');
    const dialogOpts = {
      title: t(format === 'zip' ? 'modtranslate.exportZipTitle' : 'modtranslate.exportJsonTitle'),
      defaultPath: path.join(eapp.getPath('documents'), data.fileName),
      filters: [format === 'zip' ? { name: t('modtranslate.filterZip'), extensions: ['zip'] } : { name: t('modtranslate.filterJson'), extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const w = win();
    const r = w ? await dialog.showSaveDialog(w, dialogOpts) : await dialog.showSaveDialog(dialogOpts);
    if (r.canceled || !r.filePath) return null;
    try {
      await fsp.writeFile(r.filePath, data.buffer);
    } catch (err) {
      throw new Error(t('modtranslate.errExportWrite', { error: err.message }));
    }
    exported.add(path.resolve(r.filePath));
    return { path: r.filePath, count: data.count, reviewed: data.reviewed, format };
  });

  // Importa una traduccion compartida (dialogo para elegir el archivo).
  handle('modtranslate:import', async (instanceId, opts) => {
    checkId(instanceId);
    const o = plainOpts(opts);
    const { dialog } = require('electron');
    const dialogOpts = {
      title: t('modtranslate.importTitle'),
      properties: ['openFile'],
      filters: [{ name: t('modtranslate.filterImport'), extensions: ['json', 'zip', 'lang'] }],
    };
    const w = win();
    const r = w ? await dialog.showOpenDialog(w, dialogOpts) : await dialog.showOpenDialog(dialogOpts);
    if (r.canceled || !r.filePaths?.[0]) return null;
    return engine.importFile(instanceId, { locale: o.locale, file: r.filePaths[0] });
  });

  handle('modtranslate:clear', (instanceId, opts) => {
    const o = plainOpts(opts);
    return engine.clear(checkId(instanceId), { locale: o.locale, mods: o.mods });
  });

  handle('modtranslate:setEnabled', (instanceId, enabled) => engine.setEnabled(checkId(instanceId), Boolean(enabled)));
  handle('modtranslate:setGameLanguage', (instanceId, locale) => engine.setGameLanguage(checkId(instanceId), locale));

  handle('modtranslate:openPack', async (instanceId) => {
    const base = instances.dir(checkId(instanceId));
    const dir = safePath(pack.packDir(base));
    const exists = await fsp.stat(dir).catch(() => null);
    const target = exists ? dir : safePath(path.join(base, 'resourcepacks'));
    await fsp.mkdir(target, { recursive: true }).catch(() => {});
    const err = await require('electron').shell.openPath(target);
    if (err) throw new Error(err);
    return true;
  });

  // Muestra en la carpeta un archivo exportado en esta sesion (fuera de la carpeta del launcher).
  handle('modtranslate:reveal', (file) => {
    const full = typeof file === 'string' ? path.resolve(file) : '';
    if (!exported.has(full)) throw new Error(t('modtranslate.errBadPath'));
    require('electron').shell.showItemInFolder(full);
    return true;
  });

  onQuit(() => engine.shutdown());
}

module.exports = { register };
