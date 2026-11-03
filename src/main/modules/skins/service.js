'use strict';
// Skins: cuenta elegida, perfil de Minecraft (skin y capas), texturas, biblioteca local, catalogo incluido y
// cambios en la cuenta. Sin Electron (cuentas, API, biblioteca, catalogo y reloj se inyectan):
// test/service.test.js y test/catalog.test.js.
//  - Un pedido de red a la vez por cuenta (cola) y un solo cambio a la vez (el segundo da skins:busy).
//  - Antes de cada cambio se vuelve a revisar que la cuenta elegida sea la misma que vio la interfaz,
//    tambien despues de renovar el token (getLaunchAccount puede tardar).
//  - El token nunca sale de aca: no va a la interfaz ni a la consola.
const png = require('./png');
const { textureUrl } = require('./api');

const VARIANTS = new Set(['classic', 'slim']);
const PROFILE_TTL = 60 * 1000;
const TEXTURE_CACHE = 48;
const MAX_TEXTURE_BYTES = 256 * 1024;
const CAPE_SIZES = [
  [64, 32],
  [128, 64],
];
const cleanUuid = (v) => String(v || '').replace(/-/g, '').toLowerCase();

function createSkinsService({ accounts, api, library, catalog = null, fail, t = (k) => k, isOffline = () => false, now = Date.now, profileTtl = PROFILE_TTL } = {}) {
  const queues = new Map(); // accountId -> cola de pedidos de red
  const writing = new Set(); // cuentas con un cambio en curso
  const reading = new Map(); // accountId -> Promise del perfil
  const profiles = new Map(); // accountId -> { at, view }
  const textures = new Map(); // url -> resultado (los mas usados al final)
  const fetching = new Map(); // url -> Promise

  function online() {
    if (isOffline()) throw fail('launcherOffline');
  }

  function needCatalog() {
    if (!catalog) throw fail('catalogUnavailable');
    return catalog;
  }

  // Modelo con el que va una skin del catalogo: el elegido en la interfaz o el del catalogo (64x32: clasico).
  const catalogVariant = (item, variant) => (item.legacy ? 'classic' : VARIANTS.has(variant) ? variant : item.model);

  function enqueue(accountId, fn) {
    const prev = queues.get(accountId) || Promise.resolve();
    const run = prev.then(fn);
    const tail = run.catch(() => {});
    queues.set(accountId, tail);
    tail.then(() => {
      if (queues.get(accountId) === tail) queues.delete(accountId);
    });
    return run;
  }

  async function selectedAccount() {
    const state = await accounts.list();
    const list = Array.isArray(state?.accounts) ? state.accounts : [];
    return list.find((a) => a.id === state.selected) || null;
  }

  // La cuenta elegida tiene que ser la que pide la interfaz y de Microsoft.
  async function guard(accountId) {
    const sel = await selectedAccount();
    if (!sel) throw fail('noAccount');
    if (typeof accountId !== 'string' || accountId !== sel.id) throw fail('accountChanged');
    if (sel.type !== 'msa') throw fail('offline');
    return sel;
  }

  // Errores de core/accounts (vienen traducidos de ese modulo) a los codigos de skins.
  function accountError(err, sel) {
    const code = err?.code;
    if (code === 'sessionExpired' || code === 'notFound' || code === 'noAccount') return code === 'sessionExpired' ? fail('sessionExpired', { name: sel.name }) : fail('accountChanged');
    if (code === 'network' || code === 'refreshFailed') return fail('network');
    if (code === 'mcRateLimited') return fail('rateLimited');
    return Object.assign(new Error(err?.message || t('skins.accountError')), { code: 'skins:accountError' });
  }

  // Token vigente de la cuenta (renueva si hace falta) y vuelve a revisar que siga elegida.
  async function tokenFor(sel) {
    let launch;
    try {
      launch = await accounts.getLaunchAccount(sel.id);
    } catch (err) {
      throw accountError(err, sel);
    }
    const again = await guard(sel.id);
    if (launch?.type !== 'msa' || cleanUuid(launch.uuid) !== cleanUuid(sel.uuid) || cleanUuid(again.uuid) !== cleanUuid(sel.uuid)) throw fail('accountChanged');
    const token = launch.accessToken;
    if (typeof token !== 'string' || !token || token === '0') throw fail('sessionExpired', { name: sel.name });
    return token;
  }

  // Lo que ve la interfaz (sin ids internos de mas ni nada sensible).
  function remember(sel, raw) {
    const active = raw.skins.find((s) => s.state === 'active') || raw.skins[0] || null;
    const view = {
      accountId: sel.id,
      name: raw.name,
      skin: active ? { id: active.id, variant: active.variant, textureUrl: active.textureUrl, alias: active.alias } : null,
      capes: raw.capes.map((c) => ({ id: c.id, alias: c.alias, active: c.state === 'active', textureUrl: c.textureUrl })),
      activeCapeId: raw.capes.find((c) => c.state === 'active')?.id || null,
      fetchedAt: now(),
    };
    profiles.set(sel.id, { at: now(), view });
    return view;
  }

  async function profile(accountId, { force = false } = {}) {
    const sel = await guard(accountId);
    const cached = profiles.get(sel.id);
    if (!force && cached && now() - cached.at < profileTtl) return cached.view;
    if (reading.has(sel.id)) return reading.get(sel.id);
    const run = enqueue(sel.id, async () => {
      online();
      const token = await tokenFor(sel);
      return remember(sel, await api.getProfile(token));
    });
    reading.set(sel.id, run);
    run.then(
      () => reading.delete(sel.id),
      () => reading.delete(sel.id),
    );
    return run;
  }

  // Un cambio en la cuenta: uno a la vez, en la cola de la cuenta y con la cuenta revisada otra vez.
  async function change(accountId, fn) {
    const sel = await guard(accountId);
    if (writing.has(sel.id)) throw fail('busy');
    writing.add(sel.id);
    try {
      return await enqueue(sel.id, async () => {
        online();
        const token = await tokenFor(sel);
        const raw = await fn(token);
        profiles.delete(sel.id);
        return raw ? remember(sel, raw) : null;
      });
    } finally {
      writing.delete(sel.id);
    }
  }

  // Textura de textures.minecraft.net como data: (la interfaz nunca dibuja imagenes de la red en un canvas).
  async function textureBytes(url, kind) {
    const safe = textureUrl(url);
    if (!safe) throw fail('badTextureUrl');
    const key = `${kind}:${safe}`;
    if (textures.has(key)) {
      const hit = textures.get(key);
      textures.delete(key);
      textures.set(key, hit);
      return hit;
    }
    if (fetching.has(key)) return fetching.get(key);
    const run = (async () => {
      online();
      const bytes = await api.fetchTexture(safe);
      const checked = png.check(bytes, { maxBytes: MAX_TEXTURE_BYTES, sizes: kind === 'cape' ? CAPE_SIZES : png.SKIN_SIZES });
      if (!checked.ok) throw fail('textureInvalid');
      const out = { url: safe, kind, bytes, width: checked.image.width, height: checked.image.height, pixelHash: checked.pixelHash, sha1: checked.sha1 };
      textures.set(key, out);
      while (textures.size > TEXTURE_CACHE) textures.delete(textures.keys().next().value);
      return out;
    })();
    fetching.set(key, run);
    run.then(
      () => fetching.delete(key),
      () => fetching.delete(key),
    );
    return run;
  }

  async function texture(url, kind) {
    const k = kind === 'cape' ? 'cape' : 'skin';
    const tex = await textureBytes(url, k);
    return { url: tex.url, kind: k, width: tex.width, height: tex.height, pixelHash: tex.pixelHash, dataUrl: `data:image/png;base64,${tex.bytes.toString('base64')}` };
  }

  // Skin publica de un jugador por nombre, para la vitrina de un perfil (solo cuando alguien toca "Ver skin").
  const publicSkins = new Map(); // nombre -> { at, view }
  async function publicSkin(name) {
    const key = String(name || '').toLowerCase();
    if (!/^[a-z0-9_]{3,16}$/.test(key)) throw fail('noProfile');
    const hit = publicSkins.get(key);
    if (hit && now() - hit.at < 10 * 60 * 1000) return hit.view;
    const { url, variant } = await api.publicProfile(key);
    const tex = await texture(url, 'skin');
    const view = { dataUrl: tex.dataUrl, variant };
    publicSkins.set(key, { at: now(), view });
    if (publicSkins.size > 32) publicSkins.delete(publicSkins.keys().next().value);
    return view;
  }

  async function account() {
    const sel = await selectedAccount();
    return sel ? { id: sel.id, type: sel.type === 'msa' ? 'msa' : 'offline', name: sel.name, needsLogin: Boolean(sel.needsLogin) } : null;
  }

  return {
    account,
    profile,
    texture,
    publicSkin,

    library: () => library.list(),
    read: (id) => library.read(id),
    rename: (id, name) => library.rename(id, name),
    setVariant: (id, variant) => library.setVariant(id, variant),
    remove: (id) => library.remove(id),

    // Agrega varios PNG: { added: [item], duplicates: [item], failed: [{ name, code, message }] }.
    async addFiles(files) {
      const out = { added: [], duplicates: [], failed: [] };
      for (const f of files) {
        try {
          if (f.error) throw f.error;
          const r = await library.add(f.bytes, { name: f.name, source: 'file' });
          (r.duplicate ? out.duplicates : out.added).push(r.item);
        } catch (err) {
          out.failed.push({ name: String(f.name || ''), code: err?.code || 'skins:error', message: err?.message || String(err) });
        }
      }
      return out;
    },

    // Guarda en la biblioteca una copia de la skin que tiene puesta la cuenta.
    async saveCurrent(accountId) {
      const view = await profile(accountId);
      if (!view.skin?.textureUrl) throw fail('noSkin');
      const tex = await textureBytes(view.skin.textureUrl, 'skin');
      return library.add(tex.bytes, { name: t('skins.currentName', { name: view.name }), variant: view.skin.variant, source: 'account' });
    },

    // Sube una skin de la biblioteca a la cuenta. variant (opcional) pisa el guardado.
    async apply(libraryId, accountId, variant) {
      await guard(accountId);
      const { item, bytes } = await library.read(libraryId);
      const v = item.height === 32 ? 'classic' : VARIANTS.has(variant) ? variant : item.variant;
      return change(accountId, (token) => api.uploadSkin(token, { bytes, variant: v, fileName: `${item.id}.png` }));
    },

    reset: (accountId) => change(accountId, (token) => api.resetSkin(token)),

    // Catalogo: lista, favoritas y lectura (los bytes ya revisados).
    catalog: async (opts) => needCatalog().list(opts),
    catalogFavorite: async (id, enabled) => needCatalog().setFavorite(id, enabled),
    catalogRead: async (id) => needCatalog().read(id),

    // Copia una skin del catalogo a la biblioteca, con su nombre y su modelo (o el elegido).
    async catalogSave(catalogId, variant) {
      const { item, bytes } = await needCatalog().read(catalogId);
      return library.add(bytes, { name: item.name, variant: catalogVariant(item, variant), source: 'catalog' });
    },

    // Sube una skin del catalogo a la cuenta sin pasar por la biblioteca: mismo candado, misma revision de
    // la cuenta y mismos errores que apply.
    async catalogApply(catalogId, accountId, variant) {
      await guard(accountId);
      const { item, bytes } = await needCatalog().read(catalogId);
      return change(accountId, (token) => api.uploadSkin(token, { bytes, variant: catalogVariant(item, variant), fileName: `${item.id}.png` }));
    },

    // capeId null o '' oculta la capa.
    async cape(capeId, accountId) {
      if (capeId !== null && capeId !== '' && (typeof capeId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(capeId))) throw fail('capeRejected');
      return change(accountId, (token) => (capeId ? api.showCape(token, capeId) : api.hideCape(token)));
    },
  };
}

module.exports = { createSkinsService, VARIANTS, PROFILE_TTL };
