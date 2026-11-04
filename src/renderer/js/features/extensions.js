// Extensiones de la comunidad. startup() lo llama app.js: registra en el menú una página por cada extensión prendida
// (siempre con la pieza de rompecabezas y dentro de su marco), dibuja las tarjetas aceptadas en Inicio y, si la persona
// activó el catálogo, consulta actualizaciones; la lista de bloqueadas se consulta solo con su consentimiento independiente.
// Guía para autores: docs/extensiones.md. Por dentro: docs/implementacion/extensiones.md.
//   extensionsState() -> { items, safeMode, safeModeForced } · onExtensions(fn) -> off · refreshExtensions()
//   catalogAllowed() / setCatalogAllowed(on) · availableUpdates() -> Map(id -> fila del catálogo) · checkCatalog()
import { h, icon, mount, ensureCss, toast, switchEl, fail, confirmDialog } from '../ui.js';
import { api, store } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { cloud } from '../cloud.js';
import { registerPage, unregisterPage, setNavBadge, navigate } from '../app.js';
import { registerSettingsCard } from '../settings-cards.js';
import { extensionFrame } from './extensions/frame.js';
import { isNewer } from './extensions/version.js';

const MAX_HOME_CARDS = 3;
const BLOCKLIST_DELAY = 4000;
const BLOCKLIST_INTERVAL = 4 * 60 * 60 * 1000;
let checkingBlocklist = null;
const listeners = new Set();

let state = { items: [], safeMode: false, safeModeForced: false };
let updates = new Map();
let registered = new Map(); // id -> firma de lo registrado
let started = false;

export const extensionsState = () => state;
export const availableUpdates = () => updates;
export const catalogAllowed = () => store.settings?.extensions?.catalog === true;
export const setCatalogAllowed = (on) => store.setSettings({ extensions: { catalog: Boolean(on) } });
// Consentimiento independiente, apagado hasta aceptarlo expresamente.
export const blocklistAllowed = () => store.settings?.extensions?.blocklist === true;
export async function allowBlocklist() {
  if (blocklistAllowed()) return true;
  const yes = await confirmDialog(t('extensions.blocklistTitle'), t('extensions.blocklistText'), { okText: t('extensions.blocklistAllow'), cancelText: t('extensions.cancel') });
  if (!yes) return false;
  await store.setSettings({ extensions: { blocklist: true } });
  await checkBlocklist();
  return true;
}
export async function setExtensionEnabled(id, on) {
  if (on && !(await allowBlocklist())) return false;
  await api.invoke('extensions:setEnabled', id, on);
  return true;
}

export function onExtensions(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      console.warn('[extensions]', err);
    }
  }
}

// Página de una extensión: el marco y nada más.
function pageFor(ext) {
  return () =>
    Promise.resolve({
      default: {
        ns: ['extensions'],
        css: ['pages/extensions'],
        render(root) {
          const frame = extensionFrame(ext, 'page');
          mount(root, h('div', { class: 'xt-page' }, frame.el));
          frame.start();
          return () => frame.destroy();
        },
      },
    });
}

function syncPages() {
  const live = state.safeMode ? [] : state.items.filter((x) => x.enabled && x.hasPage);
  const keep = new Set(live.map((x) => x.id));
  for (const id of [...registered.keys()]) {
    if (keep.has(id)) continue;
    registered.delete(id);
    unregisterPage(`ext-${id}`);
  }
  for (const ext of live) {
    const sig = JSON.stringify([ext.name, ext.version, ext.author, ext.permissions, ext.sha256]);
    const prev = registered.get(ext.id);
    if (prev === sig) continue;
    registered.set(ext.id, sig);
    registerPage(`ext-${ext.id}`, pageFor(ext), { label: ext.name, icon: 'puzzle', cls: 'xt-nav' });
    // Se actualizó con la página abierta: vuelve a dibujar el marco con los permisos nuevos
    if (prev && location.hash === `#/ext-${ext.id}`) navigate(`ext-${ext.id}`);
  }
}

function syncBadge() {
  const n = state.items.filter((x) => updates.has(x.id)).length;
  setNavBadge('extensions', n);
}

export async function refreshExtensions() {
  try {
    state = await api.invoke('extensions:list');
  } catch (err) {
    console.warn('[extensions] lista:', err?.message || err);
    return state;
  }
  syncPages();
  syncBadge();
  emit();
  syncHomeCards();
  return state;
}

// ---------- Tarjetas en Inicio ----------
// Inicio presta un contenedor y se encarga de liberar las tarjetas cuando se cierra.
let homeHost = null;
let homeFrames = [];
function clearHomeCards() {
  for (const f of homeFrames) f.destroy();
  homeFrames = [];
  homeHost?.replaceChildren();
}
export function mountHomeCards(host) {
  clearHomeCards();
  homeHost = host;
  syncHomeCards();
  return () => {
    if (homeHost !== host) return;
    clearHomeCards();
    homeHost = null;
  };
}
function syncHomeCards() {
  clearHomeCards();
  if (!homeHost?.isConnected || state.safeMode) return;
  const cards = state.items.filter((x) => x.enabled && x.homeCardEnabled).slice(0, MAX_HOME_CARDS);
  if (!cards.length) return;
  homeFrames = cards.map((ext) => extensionFrame(ext, 'card'));
  mount(homeHost, h('section', { class: 'xt-home' }, homeFrames.map((f) => f.el)));
  for (const f of homeFrames) f.start();
}

// ---------- Catálogo: lista de bloqueadas y actualizaciones ----------
// La consulta no manda la lista de instaladas. La última respuesta se cumple también sin conexión.
export async function checkBlocklist() {
  if (!blocklistAllowed() || store.settings?.downloads?.offline === true || !cloud.isConfigured() || !cloud.client) return;
  if (checkingBlocklist) return checkingBlocklist;
  checkingBlocklist = fetchBlocklist().finally(() => { checkingBlocklist = null; });
  return checkingBlocklist;
}
async function fetchBlocklist() {
  try {
    const { data, error } = await cloud.client.rpc('extension_blocklist');
    if (error) throw error;
    const disabled = await api.invoke('extensions:applyBlocklist', data || {});
    if (disabled?.length) toast('bad', t('extensions.blockedTitle'), t('extensions.blockedText', { count: disabled.length }), 10000);
  } catch (err) {
    console.warn('[extensions] lista de bloqueadas:', err?.message || err);
  }
  await refreshExtensions();
}

export async function checkCatalog() {
  if (!catalogAllowed() || !cloud.isConfigured() || !cloud.client) return;
  await checkUpdates();
}

async function checkUpdates() {
  const ids = state.items.filter((x) => x.source === 'catalog').map((x) => x.id);
  updates = new Map();
  if (ids.length && cloud.isSignedIn()) {
    try {
      const { data, error } = await cloud.client.rpc('extension_catalog', { p_ids: ids });
      if (error) throw error;
      for (const row of Array.isArray(data) ? data : []) {
        const mine = state.items.find((x) => x.id === row.id);
        if (mine && isNewer(row.version, mine.version)) updates.set(row.id, row);
      }
    } catch (err) {
      console.warn('[extensions] actualizaciones:', err?.message || err);
    }
  }
  syncBadge();
  emit();
}

// ---------- Ajustes → Privacidad ----------
function settingsCard() {
  const row = h(
    'div',
    { class: 'toggle-row' },
    h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('extensions.catalogSwitch')), h('div', { class: 'tr-sub' }, t('extensions.catalogSwitchText'))),
    switchEl(
      catalogAllowed(),
      (on) => {
        setCatalogAllowed(on)
          .then(() => (on ? checkCatalog() : undefined))
          .catch((err) => fail(t('extensions.saveFailed'), err));
      },
      t('extensions.catalogSwitch'),
    ),
  );
  return h(
    'div',
    { class: 'card', id: 'extensions' },
    h('div', { class: 'card-title' }, icon('puzzle'), t('extensions.title')),
    row,
    h('div', { class: 'toggle-row' },
      h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('extensions.blocklistTitle')), h('div', { class: 'tr-sub' }, t('extensions.blocklistText'))),
      switchEl(blocklistAllowed(), async (on) => {
        try {
          await store.setSettings({ extensions: { blocklist: on } });
          if (on) await checkBlocklist();
        } catch (err) { fail(t('extensions.saveFailed'), err); }
      }, t('extensions.blocklistTitle'))),
    h('div', { class: 'row', style: { marginTop: '12px' } }, h('button', { class: 'btn sm', type: 'button', onclick: () => navigate('extensions') }, icon('puzzle'), t('extensions.manage'))),
  );
}

export async function startup() {
  if (started) return;
  started = true;
  await loadNs('extensions').catch((err) => console.warn('[extensions] textos', err));
  ensureCss('pages/extensions');
  registerSettingsCard('privacy', settingsCard);
  api.on('extensions:changed', () => refreshExtensions());
  await refreshExtensions();
  setTimeout(() => { checkBlocklist(); checkCatalog(); }, BLOCKLIST_DELAY);
  setInterval(() => checkBlocklist(), BLOCKLIST_INTERVAL);
  window.addEventListener('online', () => checkBlocklist());
  cloud.on('config', () => checkBlocklist());
}
