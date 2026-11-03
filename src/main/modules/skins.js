'use strict';
// Skins: vista previa en 3D, biblioteca local de PNG propios del jugador, catalogo de skins incluido con el
// launcher (assets/skins, solo lectura) y cambio de skin y capa en la cuenta de Microsoft con la API oficial
// de Minecraft Services. La logica esta en skins/ (sin Electron, con pruebas en skins/test/).
// Canales: skins:account, :profile, :texture, :library, :add, :addData, :rename, :setVariant, :remove,
//          :export, :saveCurrent, :apply, :reset, :cape, :catalog, :catalogFavorite, :catalogSave,
//          :catalogApply, :catalogExport
// Errores con err.code 'skins:<codigo>' (sessionExpired, offline, rateLimited, forbidden, network...).
const fsp = require('fs/promises');
const path = require('path');
const paths = require('../core/paths');
const { t } = require('../core/i18n');
const { sanitizeFileName } = require('../core/util');
const { validSegment } = require('./packs/safety');

const MAX_PICK = 20; // archivos por vez
// Catalogo incluido (tambien dentro de app.asar): catalog.json + <categoria>/<archivo>.png
const CATALOG_DIR = path.resolve(__dirname, '../../renderer/assets/skins');

function fail(code, vars) {
  const err = new Error(t(`skins.${code}`, vars));
  err.code = `skins:${code}`;
  return err;
}

// Modo de capturas: cuenta y API de ejemplo (sin red). Solo con VENUS_DEVSHOT y sin empaquetar.
function fakeMode() {
  if (!process.env.VENUS_DEVSHOT || process.env.VENUS_SKINS_FAKE !== '1' || !process.env.VENUS_SKINS_FAKE_DIR) return false;
  try {
    return !require('electron').app.isPackaged;
  } catch {
    return false;
  }
}

let service = null;
let library = null;

function libraryModule() {
  return require('./skins/library');
}

function getService() {
  if (service) return service;
  const { createSkinsService } = require('./skins/service');
  const { createMinecraftApi } = require('./skins/api');
  library = libraryModule().createLibrary({
    dir: paths.data('skins'),
    fail,
    trash: (p) => require('electron').shell.trashItem(p),
  });
  let accounts = require('../core/accounts');
  let api = createMinecraftApi({ fail });
  if (fakeMode()) {
    const fake = require('./skins/fake').createFake({ fail, dir: process.env.VENUS_SKINS_FAKE_DIR, scenario: process.env.VENUS_SKINS_FAKE_ERROR || '' });
    accounts = fake.accounts;
    api = fake.api;
    console.warn('[skins] Modo de capturas (VENUS_SKINS_FAKE=1): cuenta y API de ejemplo, sin red.');
  }
  const catalog = require('./skins/catalog').createCatalog({ dir: CATALOG_DIR, favoritesFile: paths.data('skin-favorites.json'), fail });
  service = createSkinsService({
    accounts,
    api,
    library,
    catalog,
    fail,
    t,
    isOffline: () => {
      try {
        return require('../core/http').isOffline();
      } catch {
        return false;
      }
    },
  });
  return service;
}

const plain = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? o : {});
const accountId = (v) => (typeof v === 'string' && v.length <= 80 ? v : '');
const catalogId = (v) => (typeof v === 'string' && v.length <= 100 ? v : '');
const variantArg = (v) => (v === 'classic' || v === 'slim' ? v : undefined);

function register({ handle, getWindow }) {
  const win = () => {
    const w = getWindow?.();
    return w && !w.isDestroyed() ? w : null;
  };

  handle('skins:account', () => getService().account());
  handle('skins:profile', (id, opts) => getService().profile(accountId(id), { force: plain(opts).force === true }));
  handle('skins:publicSkin', (name) => getService().publicSkin(name));
  handle('skins:texture', (url, kind) => getService().texture(typeof url === 'string' ? url : '', kind === 'cape' ? 'cape' : 'skin'));
  handle('skins:library', () => getService().library());

  // Elegir PNG con el dialogo del sistema (uno o varios). null si se cancela.
  handle('skins:add', async () => {
    const svc = getService();
    const { MAX_BYTES, nameFromFile } = libraryModule();
    const { dialog } = require('electron');
    const opts = { title: t('skins.pickTitle'), properties: ['openFile', 'multiSelections'], filters: [{ name: t('skins.pngFilter'), extensions: ['png'] }] };
    const w = win();
    const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || !r.filePaths?.length) return null;
    const files = [];
    for (const file of r.filePaths.slice(0, MAX_PICK)) {
      const name = nameFromFile(file);
      try {
        const st = await fsp.stat(file);
        if (!st.isFile()) throw fail('invalidPng');
        if (st.size > MAX_BYTES) throw fail('tooBig');
        files.push({ name, bytes: await fsp.readFile(file) });
      } catch (err) {
        files.push({ name, error: String(err?.code || '').startsWith('skins:') ? err : fail('readFailed') });
      }
    }
    const out = await svc.addFiles(files);
    out.skipped = Math.max(0, r.filePaths.length - MAX_PICK);
    return out;
  });

  // PNG soltados sobre la pagina: la interfaz manda los bytes (nunca rutas) y aca se validan igual.
  handle('skins:addData', async (list) => {
    const svc = getService();
    const { MAX_BYTES, nameFromFile } = libraryModule();
    const items = Array.isArray(list) ? list.slice(0, MAX_PICK) : [];
    const files = items.map((f) => {
      const name = nameFromFile(typeof f?.name === 'string' ? f.name.slice(0, 200) : '');
      if (f?.tooBig === true) return { name, error: fail('tooBig') };
      if (f?.unreadable === true) return { name, error: fail('readFailed') };
      const bytes = f?.bytes instanceof Uint8Array ? Buffer.from(f.bytes) : null;
      if (!bytes) return { name, error: fail('invalidPng') };
      if (bytes.length > MAX_BYTES) return { name, error: fail('tooBig') };
      return { name, bytes };
    });
    const out = await svc.addFiles(files);
    out.skipped = Math.max(0, (Array.isArray(list) ? list.length : 0) - MAX_PICK);
    return out;
  });

  handle('skins:rename', (id, name) => getService().rename(id, typeof name === 'string' ? name.slice(0, 200) : ''));
  handle('skins:setVariant', (id, variant) => getService().setVariant(id, variant));
  handle('skins:remove', (id) => getService().remove(id));

  // Guardar una copia del PNG donde elija el jugador (Descargas por defecto). null si se cancela.
  async function savePng(name, bytes) {
    const { dialog, app } = require('electron');
    let base = sanitizeFileName(name);
    // Sin nombre o con un nombre que Windows no deja usar (CON, NUL, COM1...): "skin.png"
    if (!base || base === 'sin-nombre' || !validSegment(`${base}.png`)) base = 'skin';
    const opts = {
      title: t('skins.exportTitle'),
      defaultPath: path.join(app.getPath('downloads'), `${base}.png`),
      filters: [{ name: t('skins.pngFilter'), extensions: ['png'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const w = win();
    const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    const dest = /\.png$/i.test(r.filePath) ? r.filePath : `${r.filePath}.png`;
    try {
      await fsp.writeFile(dest, bytes);
    } catch {
      throw fail('exportFailed');
    }
    return { path: dest, name: path.basename(dest) };
  }

  handle('skins:export', async (id) => {
    const { item, bytes } = await getService().read(id);
    return savePng(item.name, bytes);
  });

  handle('skins:saveCurrent', (id) => getService().saveCurrent(accountId(id)));
  handle('skins:apply', (libraryId, id, variant) => getService().apply(libraryId, accountId(id), variant));
  handle('skins:reset', (id) => getService().reset(accountId(id)));
  handle('skins:cape', (capeId, id) => getService().cape(capeId === null || capeId === undefined ? null : capeId, accountId(id)));

  // Catalogo: { query, category, model, onlyFavorites, offset, limit } -> { items, total, offset, limit,
  // categories, favoriteCount, catalogTotal }. Las imagenes van como data: (ya revisadas).
  handle('skins:catalog', (opts) => getService().catalog(plain(opts)));
  handle('skins:catalogFavorite', (id, enabled) => getService().catalogFavorite(catalogId(id), enabled === true));
  handle('skins:catalogSave', (id, variant) => getService().catalogSave(catalogId(id), variantArg(variant)));
  handle('skins:catalogApply', (id, accId, variant) => getService().catalogApply(catalogId(id), accountId(accId), variantArg(variant)));
  handle('skins:catalogExport', async (id) => {
    const { item, bytes } = await getService().catalogRead(catalogId(id));
    return savePng(item.name, bytes);
  });
}

module.exports = { register };
