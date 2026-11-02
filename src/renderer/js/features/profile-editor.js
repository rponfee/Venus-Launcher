// Editor del perfil de Venus ("Mi perfil"): datos basicos, pronombres y descripcion; fade, tipografia, efecto,
// color y brillo del nombre; banner (8 diseños, imagen propia o GIF animado con Premium); servidores favoritos,
// estadisticas publicadas y capturas destacadas; y lo equipado de la tienda. Vista previa en vivo a la izquierda.
// Lo personalizado se guarda con profile_customize (0020_perfiles.sql); nombre, nombre de Minecraft, estado y el
// color clasico del banner con la tabla profiles (como siempre). Las imagenes se preparan en la PC (media.js).
//   import('../features/profile-editor.js').then((m) => m.openProfileEditor({ tab: 'style' }))
// Tambien: openShareProfile() (imagen PNG de la tarjeta) y featureCapture({ src, title }) para Capturas y clips.
import { h, icon, mount, modal, ok, fail, toast, ensureCss, switchEl, setBusy, skeleton, emptyState, copyText, confirmDialog, fmtDate, LOADERS } from '../ui.js';
import { api, store } from '../store.js';
import { t, locale } from '../i18n.js';
import { navigate } from '../app.js';
import { cloud } from '../cloud.js';
import { social } from '../social.js';
import { BANNERS, bannerBackground, bannerName, encodeBanner, parseBanner, isMcName, presenceLabel, MY_STATUSES, publicAddress } from '../social/cosmetics.js';
import { ensureProfileStyle, styledName, normalize, setStyleCache, titleLabel, premiumChip, applyFrame } from '../social/profile-style.js';
import { profileCard, presenceDot, headImg, headWithDot, prepareSocialUi, fetchPublicProfile, forgetPublicProfile } from '../social/profile-ui.js';
import * as M from './profile-editor/model.js';
import { MediaError, readImageFile, bannerFromImage, featuredFromImage, featuredFromSource, gifBanner, uploadMedia, removeMedia, makeRoom, loadImage } from './profile-editor/media.js';
import { drawShareCard, loadFonts } from './profile-editor/share.js';

const NS = 'profile';
const P = (k, vars) => t(`${NS}.${k}`, vars);
const TABS = [
  { id: 'identity', icon: 'user' },
  { id: 'style', icon: 'type' },
  { id: 'banner', icon: 'image' },
  { id: 'showcase', icon: 'star' },
  { id: 'items', icon: 'sparkles' },
];
const FIELD_TAB = { pronouns: 'identity', bio: 'identity', theme: 'style', nameStyle: 'style', banner: 'banner', favoriteServers: 'showcase', publicStats: 'showcase', featured: 'showcase', equipped: 'items' };
const SLOTS = [
  { slot: 'frame', kind: 'frame' },
  { slot: 'title', kind: 'title' },
  { slot: 'badgeStyle', kind: 'badge_style' },
  { slot: 'nameEffect', kind: 'name_effect' },
];
const MEDIA_CODES = ['type', 'too_big', 'decode', 'limit', 'denied', 'unavailable', 'network', 'session'];
const PLACEHOLDER_HOST = 'https://pending.supabase.co/storage/v1/object/public/profile-media';

let current = null; // editor abierto (no se abren dos)
let premiumModule; // undefined: sin probar; null: todavia no existe

async function ensureUi() {
  ensureCss('features/profile-editor');
  await Promise.all([prepareSocialUi(), ensureProfileStyle()]);
}

const isDevshot = () => Boolean(store.info?.devshot);
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
let seq = 0;
const uid = (p) => `pfe-${p}-${++seq}`;

// ---------- Datos ----------
async function premiumFlag() {
  if (premiumModule === undefined) {
    try {
      premiumModule = await import('./premium.js');
    } catch {
      premiumModule = null; // la parte de Venus Points y Premium todavia no esta
    }
  }
  try {
    if (typeof premiumModule?.isPremium === 'function') return Boolean(await premiumModule.isPremium({ force: true }));
  } catch (err) {
    console.warn('[profile] premium:', err?.message || err);
  }
  return null;
}

async function loadOwned() {
  try {
    const { data, error } = await cloud.client.from('user_items').select('item_id');
    if (error) throw error;
    return new Set((data || []).map((r) => r.item_id));
  } catch (err) {
    console.warn('[profile] user_items:', err?.message || err);
    return new Set();
  }
}

async function loadShop() {
  try {
    const { data, error } = await cloud.client.from('shop_items').select('id,kind,price,premium_only,active,sort,data').order('sort');
    if (error) throw error;
    const list = (data || [])
      .filter((r) => ['frame', 'name_effect', 'badge_style', 'title'].includes(r.kind))
      .map((r) => ({ id: r.id, kind: r.kind, price: r.price, premiumOnly: Boolean(r.premium_only), active: r.active !== false, style: r.data?.style || r.data?.effect || r.data?.title || r.id.replace(/^[a-z]+_/, '') }));
    return list.length ? list : M.SHOP_CATALOG;
  } catch (err) {
    console.warn('[profile] shop_items:', err?.message || err);
    return M.SHOP_CATALOG;
  }
}

// Fila de profiles + lo de profile_public, en snake_case (la fila trae el banner viejo, mc_uuid y el estado)
function combine(row, pub, opts) {
  const base = { ...(row || {}) };
  if (pub) {
    Object.assign(base, {
      theme: pub.theme,
      name_style: pub.nameStyle,
      banner_style: pub.banner,
      favorite_servers: pub.favoriteServers,
      public_stats: pub.publicStats,
      featured: pub.featured,
      equipped: pub.equipped,
      pronouns: pub.pronouns,
      bio: pub.bio ?? base.bio,
      premium: pub.premium === true,
      created_at: pub.createdAt || base.created_at,
      badges: pub.badges || base.badges,
      friend_code: pub.friendCode || base.friend_code,
      username: pub.username || base.username,
    });
  }
  return M.normalizeProfile(base, opts);
}

async function loadEditorData(demoKind) {
  if (demoKind) {
    const d = await import('./profile-editor/demo.js');
    const pub = d.demoProfile(demoKind);
    const row = { id: pub.id, username: pub.username, display_name: pub.displayName, friend_code: pub.friendCode, mc_name: pub.mcName, mc_uuid: null, status_text: 'Armando la base del server', banner: 'venus', bio: pub.bio };
    return { uid: pub.id, row, n: combine(row, pub, { allowLocalMedia: true }), premium: pub.premium, owned: new Set(d.demoOwned(demoKind)), items: M.SHOP_CATALOG, available: true, demo: d };
  }
  const id = cloud.user.id;
  const [row, pub, prem, owned, items] = await Promise.all([
    cloud.profile ? Promise.resolve(cloud.profile) : cloud.loadProfile().catch(() => null),
    fetchPublicProfile(id, { force: true }),
    premiumFlag(),
    loadOwned(),
    loadShop(),
  ]);
  if (!row && !pub) throw new Error('profile');
  return { uid: id, row: row || {}, n: combine(row, pub), premium: prem ?? pub?.premium === true, owned, items, available: Boolean(pub), demo: null };
}

async function loadStats(demo) {
  if (demo) return demo.demoStats();
  try {
    return M.publicStatsFromReport(await api.invoke('stats:report'));
  } catch (err) {
    console.warn('[profile] stats:report:', err?.message || err);
    return null;
  }
}

async function loadSavedServers(demo) {
  let list = [];
  try {
    list = demo ? demo.demoSavedServers() : await api.invoke('serverlist:saved');
  } catch (err) {
    console.warn('[profile] serverlist:saved:', err?.message || err);
  }
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    const address = publicAddress(s?.address || s?.ip || '');
    if (!address || !M.isServerAddress(address) || out.some((o) => o.address === address)) continue;
    out.push({ address, name: M.cleanText(s?.name, M.LIMITS.serverName).replace(/[<>]/g, '') });
  }
  return out.slice(0, 8);
}

// ---------- Ayudas de la interfaz ----------
async function goPlans() {
  try {
    const { openPlans } = await import('./plans.js');
    openPlans();
  } catch (err) {
    console.warn('[profile] planes:', err?.message || err);
    navigate('settings/plan');
  }
}

async function goShop(close) {
  try {
    await import('../pages/rewards.js');
    close?.();
    navigate('rewards');
  } catch {
    toast('info', P('shopSoon'));
  }
}

// Grupo de opciones (role="radiogroup") con flechas; las bloqueadas llevan candado y abren onLocked
function radioGroup({ label, options, value, onPick, onLocked, cls = '', render }) {
  const el = h('div', { class: ['pfe-radios', cls], role: 'radiogroup', 'aria-label': label });
  let cur = value;
  const draw = () => {
    const hadFocus = el.contains(document.activeElement);
    const buttons = options.map((o) => {
      const active = o.id === cur;
      const btn = h(
        'button',
        {
          type: 'button',
          role: 'radio',
          class: ['pfe-radio', active && 'active', o.locked && 'locked'],
          'aria-checked': String(active),
          tabindex: active || (!options.some((x) => x.id === cur) && o === options[0]) ? '0' : '-1',
          title: o.title || o.label,
          'aria-label': o.aria || o.label,
          dataset: { id: o.id },
          onclick: () => {
            if (o.locked) onLocked?.(o);
            else if (o.id !== cur) {
              cur = o.id;
              draw();
              onPick(o.id, o);
            }
          },
        },
        render ? render(o, active) : h('span', { class: 'pfe-radio-label' }, o.label),
        o.locked ? h('span', { class: 'pfe-lock', 'aria-hidden': 'true' }, icon(o.lockIcon || 'lock'), o.lockText ? h('span', {}, o.lockText) : null) : null,
      );
      return btn;
    });
    mount(el, buttons);
    if (hadFocus) (el.querySelector('[aria-checked="true"]') || buttons[0])?.focus({ preventScroll: true });
  };
  el.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const btns = [...el.querySelectorAll('[role="radio"]')];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    let j = i;
    if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = btns.length - 1;
    else j = (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
    btns.forEach((b, k) => (b.tabIndex = k === j ? 0 : -1));
    btns[j].focus();
  });
  draw();
  return {
    el,
    set(v) {
      cur = v;
      draw();
    },
  };
}

function fieldBox(label, control, { hint, error, id, extra } = {}) {
  const cid = id || uid('f');
  const isText = ['INPUT', 'TEXTAREA', 'SELECT'].includes(control.tagName);
  if (isText) control.id = cid;
  else control.setAttribute('aria-labelledby', `${cid}-l`);
  const hintId = hint ? `${cid}-h` : null;
  const errId = error ? error.id || (error.id = `${cid}-e`) : null;
  const described = [hintId, errId].filter(Boolean).join(' ');
  if (described) control.setAttribute('aria-describedby', described);
  return h(
    'div',
    { class: 'field' },
    isText ? h('label', { for: cid }, label) : h('span', { class: 'label', id: `${cid}-l` }, label),
    control,
    extra || null,
    error || null,
    hint ? h('div', { class: 'field-help', id: hintId }, hint) : null,
  );
}

function errorLine() {
  const el = h('div', { class: 'field-error', role: 'alert', hidden: true });
  el.set = (text, input) => {
    el.hidden = !text;
    mount(el, text ? [icon('alert'), h('span', {}, text)] : []);
    if (input) {
      if (text) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  };
  return el;
}

const groupTitle = (text, sub) => h('div', { class: 'pfe-group-head' }, h('h4', { class: 'pfe-group-title' }, text), sub ? h('p', { class: 'pfe-group-sub' }, sub) : null);

// ---------- Editor ----------
/**
 * Abre el editor del perfil propio. tab: 'identity', 'style', 'banner', 'showcase' o 'items'.
 * demo: 'premium' o 'free' muestra datos de ejemplo (solo en capturas de desarrollo, VENUS_DEVSHOT).
 */
export async function openProfileEditor({ tab = 'identity', demo = false } = {}) {
  if (current) {
    current.focus();
    return current.dialog;
  }
  await ensureUi();
  const demoKind = demo && isDevshot() ? (demo === 'free' ? 'free' : 'premium') : null;
  if (!demoKind) {
    await cloud.ready().catch(() => null);
    if (!cloud.isConfigured() || !cloud.isSignedIn()) return signedOutDialog();
  }

  const body = h('div', { class: 'pfe' }, h('div', { class: 'pfe-loading' }, skeleton('block', { height: 220, label: P('loading') }), skeleton('card', { lines: 4 })));
  const saveBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, icon('save'), P('save'));
  const shareBtn = h('button', { class: 'btn ghost', type: 'button', disabled: true }, icon('share'), P('shareProfile'));
  const dirtyNote = h('span', { class: 'pfe-dirty', role: 'status', 'aria-live': 'polite' });
  const dialog = modal({
    title: P('editorTitle'),
    subtitle: P('editorSub'),
    icon: 'palette',
    size: 'xwide',
    body,
    footer: [shareBtn, dirtyNote, h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', type: 'button', onclick: () => dialog.close() }, P('cancel')), saveBtn],
    onClose: () => {
      current = null;
      cleanupUrls();
    },
  });
  current = { dialog, focus: () => dialog.el.focus() };

  // URLs locales (vistas previas de imagenes sin subir) que hay que liberar al cerrar
  const localUrls = new Set();
  const track = (url) => (localUrls.add(url), url);
  function cleanupUrls() {
    for (const u of localUrls) URL.revokeObjectURL(u);
    localUrls.clear();
  }

  let data;
  try {
    data = await loadEditorData(demoKind);
  } catch (err) {
    console.warn('[profile] editor:', err?.message || err);
    mount(body, emptyState('alert', P('loadFailed'), P('err_unavailable'), h('button', { class: 'btn', type: 'button', onclick: () => (dialog.close(), openProfileEditor({ tab, demo })) }, icon('refresh'), P('retry'))));
    return dialog;
  }
  if (!dialog.el.isConnected) return dialog;

  // ---------- Estado ----------
  const socialReady = !demoKind && social.state === 'ready';
  const prefs = socialReady ? social.prefs() : { status: 'online', shareActivity: true, autoAway: true, notifications: true };
  const n = data.n;
  const S = {
    uid: data.uid,
    n,
    premium: data.premium,
    owned: data.owned,
    items: data.items,
    available: data.available,
    demo: data.demo,
    saved: {
      basics: { display_name: n.displayName || '', mc_name: n.mcName || '', mc_uuid: data.row.mc_uuid || null, status_text: n.statusText || '', banner: n.legacyBanner || 'venus' },
      custom: M.customOf(n),
      prefs: { status: prefs.status, shareActivity: prefs.shareActivity, autoAway: prefs.autoAway, notifications: prefs.notifications },
    },
    publishStats: Boolean(n.publicStats),
    stats: undefined, // undefined: sin pedir; null: no se pudo; objeto: estadisticas para publicar
    pending: { banner: null, featured: new Map() },
    bannerSource: null,
    bannerFocus: 0.5,
    fadeMemory: n.theme ? { ...n.theme } : { ...M.FADE_PRESETS[0], angle: 135 },
  };
  S.draft = { basics: clone(S.saved.basics), custom: clone(S.saved.custom), prefs: clone(S.saved.prefs) };
  S.draft.custom.nameStyle = { font: 'default', effect: 'none', color: null, glow: 0, ...S.draft.custom.nameStyle };
  const ctx = () => ({ userId: S.uid, premium: S.premium, owned: S.owned, items: S.items });
  const locked = !S.available;

  // ---------- Vista previa ----------
  const previewBox = h('div', { class: 'pfe-preview-card' });
  const listBox = h('div', { class: 'pfe-preview-list' });
  function previewRaw() {
    const c = S.draft.custom;
    const b = S.draft.basics;
    return {
      id: S.uid,
      username: S.n.username,
      display_name: b.display_name.trim(),
      friend_code: S.n.friendCode,
      mc_name: b.mc_name.trim(),
      mc_uuid: b.mc_uuid,
      banner: b.banner,
      badges: S.n.badges,
      created_at: S.n.createdAt,
      premium: S.premium,
      pronouns: c.pronouns,
      bio: c.bio,
      theme: c.theme,
      name_style: c.nameStyle,
      banner_style: c.banner,
      favorite_servers: c.favoriteServers.filter((s) => M.isServerAddress(s.address)),
      public_stats: S.publishStats ? S.stats || S.saved.custom.publicStats : null,
      featured: c.featured,
      equipped: c.equipped,
    };
  }
  let raf = 0;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const raw = previewRaw();
      const presence = socialReady ? (S.draft.prefs.status === 'invisible' ? 'invisible' : S.draft.prefs.status) : 'online';
      mount(previewBox, profileCard(raw, { full: true, preview: true, self: true, presence, statusText: S.draft.basics.status_text.trim() }));
      const n2 = normalize(M.normalizeProfile(raw, { allowLocalMedia: true }));
      mount(
        listBox,
        h(
          'div',
          { class: 'pfe-mini' },
          applyFrame(headWithDot(n2, presence, 36), n2),
          h('div', { class: 'pfe-mini-main' }, h('div', { class: 'pfe-mini-name ellipsis' }, styledName(n2, { size: 'sm' })), h('div', { class: 'pfe-mini-sub ellipsis' }, S.draft.basics.status_text.trim() || presenceLabel(presence === 'invisible' ? 'offline' : presence))),
        ),
      );
      updateDirty();
    });
  }

  // ---------- Cambios sin guardar ----------
  function currentCustom() {
    const c = clone(S.draft.custom);
    c.publicStats = S.publishStats ? S.stats || S.saved.custom.publicStats || null : null;
    return c;
  }
  const basicsDiff = () => {
    const out = {};
    const b = S.draft.basics;
    const next = { display_name: b.display_name.trim() || null, mc_name: b.mc_name.trim() || null, mc_uuid: b.mc_name.trim() ? b.mc_uuid : null, status_text: b.status_text.trim() || null, banner: b.banner };
    const prev = { display_name: S.saved.basics.display_name || null, mc_name: S.saved.basics.mc_name || null, mc_uuid: S.saved.basics.mc_uuid || null, status_text: S.saved.basics.status_text || null, banner: S.saved.basics.banner };
    for (const k of Object.keys(next)) if ((prev[k] ?? null) !== (next[k] ?? null)) out[k] = next[k];
    return out;
  };
  const prefsChanged = () => socialReady && !M.deepEqual(S.saved.prefs, S.draft.prefs);
  const isDirty = () => Object.keys(basicsDiff()).length > 0 || Object.keys(M.buildPatch(S.saved.custom, currentCustom())).length > 0 || prefsChanged();
  function updateDirty() {
    const dirty = isDirty();
    dirtyNote.textContent = dirty ? P('dirty') : '';
    saveBtn.disabled = !dirty;
  }

  // ---------- Aviso de errores ----------
  const notice = h('div', { class: 'pfe-notice', hidden: true });
  function showError(text, action) {
    notice.hidden = !text;
    mount(notice, text ? h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', { class: 'pfe-notice-text' }, text), action || null) : []);
  }

  // ---------- Pestañas ----------
  const panels = {};
  const tabButtons = {};
  let activeTab = TABS.some((x) => x.id === tab) ? tab : 'identity';
  const tabsEl = h(
    'div',
    { class: 'tabs pfe-tabs', role: 'tablist', 'aria-label': P('editorTitle') },
    TABS.map((x) => {
      const b = h(
        'button',
        { class: 'tab', type: 'button', role: 'tab', id: `pfe-tab-${x.id}`, 'aria-controls': `pfe-panel-${x.id}`, onclick: () => selectTab(x.id) },
        icon(x.icon),
        h('span', {}, P(`tab_${x.id}`)),
      );
      tabButtons[x.id] = b;
      return b;
    }),
  );
  tabsEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.findIndex((x) => x.id === activeTab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length].id;
    selectTab(next);
    tabButtons[next].focus();
  });
  function selectTab(id) {
    activeTab = id;
    for (const x of TABS) {
      const on = x.id === id;
      tabButtons[x.id].classList.toggle('active', on);
      tabButtons[x.id].setAttribute('aria-selected', String(on));
      tabButtons[x.id].tabIndex = on ? 0 : -1;
      if (panels[x.id]) panels[x.id].hidden = !on;
    }
    if (id === 'showcase') ensureShowcaseData();
  }
  const panel = (id, ...children) => {
    panels[id] = h('div', { class: 'pfe-panel', role: 'tabpanel', id: `pfe-panel-${id}`, 'aria-labelledby': `pfe-tab-${id}`, tabindex: '0', hidden: true }, children);
    return panels[id];
  };
  const unavailableNote = () =>
    h('div', { class: 'notice info pfe-unavailable' }, icon('info'), h('div', {}, h('strong', {}, P('unavailableTitle')), h('div', {}, P('unavailableText'))));

  // ===== Perfil =====
  const nameErr = errorLine();
  const nameInput = h('input', { class: 'input', value: S.draft.basics.display_name, maxlength: M.LIMITS.displayName, placeholder: S.n.username || '', autocomplete: 'nickname' });
  nameInput.addEventListener('input', () => {
    S.draft.basics.display_name = nameInput.value;
    nameErr.set('', nameInput);
    schedule();
  });
  const pronErr = errorLine();
  const pronInput = h('input', { class: 'input', value: S.draft.custom.pronouns || '', maxlength: M.LIMITS.pronouns, placeholder: P('pronounsPlaceholder'), disabled: locked });
  pronInput.addEventListener('input', () => {
    S.draft.custom.pronouns = pronInput.value;
    pronErr.set('', pronInput);
    schedule();
  });
  pronInput.addEventListener('blur', () => pronErr.set(M.validateField('pronouns', pronInput.value) ? P('err_bad_pronouns') : '', pronInput));
  const bioErr = errorLine();
  const bioCount = h('span', { class: 'pfe-count', 'aria-hidden': 'true' });
  const bioInput = h('textarea', { class: 'textarea', maxlength: M.LIMITS.bio, rows: 3, placeholder: P('bioPlaceholder') }, S.draft.custom.bio || '');
  const setBioCount = () => (bioCount.textContent = P('bioCount', { count: bioInput.value.length, max: M.LIMITS.bio }));
  bioInput.addEventListener('input', () => {
    S.draft.custom.bio = bioInput.value;
    setBioCount();
    bioErr.set('', bioInput);
    schedule();
  });
  setBioCount();
  const mcErr = errorLine();
  const mcInput = h('input', { class: 'input', value: S.draft.basics.mc_name, maxlength: 16, placeholder: 'Steve' });
  mcInput.addEventListener('input', () => {
    S.draft.basics.mc_name = mcInput.value;
    S.draft.basics.mc_uuid = null;
    mcErr.set('', mcInput);
    schedule();
  });
  mcInput.addEventListener('blur', () => {
    const v = mcInput.value.trim();
    mcErr.set(v && !isMcName(v) ? t('social.mcNameInvalid') : '', mcInput);
  });
  const acc = store.selectedAccount?.();
  const useAccount = acc
    ? h(
        'button',
        {
          class: 'btn sm ghost',
          type: 'button',
          onclick: () => {
            mcInput.value = acc.name;
            S.draft.basics.mc_name = acc.name;
            S.draft.basics.mc_uuid = acc.type === 'msa' && acc.uuid ? acc.uuid : null;
            mcErr.set('', mcInput);
            schedule();
          },
        },
        icon('user'),
        t('social.useAccount', { name: acc.name }),
      )
    : null;
  const statusTextInput = h('input', { class: 'input', value: S.draft.basics.status_text, maxlength: 80, placeholder: t('social.statusTextPlaceholder') });
  statusTextInput.addEventListener('input', () => {
    S.draft.basics.status_text = statusTextInput.value;
    schedule();
  });
  const statusGroup = socialReady
    ? radioGroup({
        label: t('social.status'),
        cls: 'pfe-status',
        options: MY_STATUSES.map((s) => ({ id: s, label: presenceLabel(s) })),
        value: S.draft.prefs.status,
        render: (o) => [presenceDot(o.id), h('span', {}, o.label)],
        onPick: (id) => {
          S.draft.prefs.status = id;
          schedule();
        },
      })
    : null;
  const toggle = (key, title, sub) =>
    h(
      'div',
      { class: 'toggle-row' },
      h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), h('div', { class: 'tr-sub' }, sub)),
      switchEl(Boolean(S.draft.prefs[key]), (v) => {
        S.draft.prefs[key] = v;
        updateDirty();
      }, title),
    );
  const code = S.n.friendCode;
  panel(
    'identity',
    locked ? unavailableNote() : null,
    h(
      'div',
      { class: 'form-grid pfe-grid' },
      fieldBox(t('social.displayName'), nameInput, { error: nameErr, hint: P('displayNameHint', { username: S.n.username || '' }) }),
      fieldBox(P('pronouns'), pronInput, { error: pronErr, hint: P('pronounsHint') }),
      h('div', { class: 'full' }, fieldBox(P('bio'), bioInput, { error: bioErr, extra: bioCount })),
      h(
        'div',
        { class: 'full' },
        fieldBox(t('social.mcNameLabel'), mcInput, { error: mcErr, hint: t('social.mcNameHint'), extra: useAccount ? h('div', { class: 'pfe-inline' }, useAccount) : null }),
      ),
      socialReady ? h('div', { class: 'full' }, fieldBox(t('social.status'), statusGroup.el, { hint: t('social.statusHint') })) : null,
      socialReady ? h('div', { class: 'full' }, fieldBox(t('social.statusText'), statusTextInput)) : null,
    ),
    socialReady
      ? h(
          'div',
          { class: 'pfe-group' },
          groupTitle(t('social.privacy')),
          h(
            'div',
            { class: 'pfe-toggles' },
            toggle('shareActivity', t('social.shareActivity'), t('social.shareActivityHint')),
            toggle('autoAway', t('social.autoAway'), t('social.autoAwayHint')),
            toggle('notifications', t('social.notifications'), t('social.notificationsHint')),
          ),
        )
      : null,
    code
      ? h(
          'div',
          { class: 'pfe-group' },
          groupTitle(t('social.yourCode'), t('social.yourCodeHint')),
          h('div', { class: 'pfe-code' }, h('span', { class: 'kbd selectable' }, code), h('button', { class: 'icon-btn sm', type: 'button', title: t('social.copyCode'), 'aria-label': t('social.copyCode'), onclick: () => copyText(code, t('social.codeCopied')) }, icon('copy'))),
        )
      : null,
  );

  // ===== Estilo =====
  const ns = () => S.draft.custom.nameStyle;
  const sample = (style) => styledName({ displayName: M.cleanText(S.draft.basics.display_name, 32) || S.n.username || 'Steve', nameStyle: style, theme: S.draft.custom.theme, hasStyle: true }, { size: 'md', animate: false });
  // Fade
  const fadeFrom = h('input', { type: 'color', class: 'pfe-color', value: S.fadeMemory.from });
  const fadeTo = h('input', { type: 'color', class: 'pfe-color', value: S.fadeMemory.to });
  const angleInput = h('input', { type: 'range', class: 'pfe-range', min: 0, max: 360, step: 5, value: S.fadeMemory.angle ?? 135 });
  const angleOut = h('output', { class: 'pfe-range-value num' });
  const fadeOn = () => Boolean(S.draft.custom.theme?.from);
  const fadeControls = h('div', { class: 'pfe-fade-controls' });
  const fadeSwitch = switchEl(fadeOn(), (v) => {
    S.draft.custom.theme = v ? { ...S.fadeMemory } : {};
    syncFade();
    refreshSamples();
    schedule();
  }, P('fadeOn'));
  const applyFade = () => {
    S.fadeMemory = { from: fadeFrom.value, to: fadeTo.value, angle: Number(angleInput.value) };
    if (fadeOn()) S.draft.custom.theme = { ...S.fadeMemory };
    syncFade();
    refreshSamples();
    schedule();
  };
  fadeFrom.addEventListener('input', applyFade);
  fadeTo.addEventListener('input', applyFade);
  angleInput.addEventListener('input', applyFade);
  const fadePresets = h(
    'div',
    { class: 'pfe-fade-presets', role: 'group', 'aria-label': P('fadePresets') },
    M.FADE_PRESETS.map((f, i) =>
      h('button', {
        type: 'button',
        class: 'pfe-fade-swatch',
        style: { background: `linear-gradient(135deg, ${f.from}, ${f.to})` },
        title: P('fadePreset', { n: i + 1 }),
        'aria-label': P('fadePreset', { n: i + 1 }),
        onclick: () => {
          fadeFrom.value = f.from;
          fadeTo.value = f.to;
          if (!fadeOn()) {
            S.draft.custom.theme = { from: f.from, to: f.to, angle: Number(angleInput.value) };
            fadeSwitch.querySelector('input').checked = true;
          }
          applyFade();
        },
      }),
    ),
  );
  function syncFade() {
    const on = fadeOn();
    fadeControls.classList.toggle('off', !on);
    for (const el of [fadeFrom, fadeTo, angleInput]) el.disabled = !on || locked;
    angleOut.textContent = P('fadeAngleValue', { angle: angleInput.value });
    fadeControls.style.setProperty('--pfe-fade', `linear-gradient(${angleInput.value}deg, ${fadeFrom.value}, ${fadeTo.value})`);
  }
  mount(
    fadeControls,
    h('span', { class: 'pfe-fade-bar', 'aria-hidden': 'true' }),
    h('div', { class: 'pfe-fade-row' }, h('label', { class: 'pfe-color-field' }, fadeFrom, h('span', {}, P('fadeFrom'))), h('label', { class: 'pfe-color-field' }, fadeTo, h('span', {}, P('fadeTo')))),
    h('label', { class: 'pfe-range-field' }, h('span', {}, P('fadeAngle')), angleInput, angleOut),
    fadePresets,
  );
  if (locked) fadeSwitch.querySelector('input').disabled = true;
  syncFade();

  // Tipografia
  const fontGroup = radioGroup({
    label: P('font'),
    cls: 'pfe-fonts',
    options: M.FONTS.map((f) => ({ id: f, label: P(`font_${f}`) })),
    value: ns().font,
    render: (o) => [h('span', { class: 'pfe-sample' }, sample({ ...ns(), font: o.id, effect: 'none' })), h('span', { class: 'pfe-radio-label' }, o.label)],
    onPick: (id) => {
      ns().font = id;
      refreshSamples();
      schedule();
    },
  });
  // Efecto
  const effectOptions = () =>
    M.EFFECTS.map((fx) => {
      const free = M.canUseEffect(fx, ctx());
      return { id: fx, label: P(`effect_${fx}`), locked: !free || locked, lockIcon: 'crown', lockText: free ? null : P('lockedPremium'), aria: free ? P(`effect_${fx}`) : P('lockedPremiumTitle', { name: P(`effect_${fx}`) }) };
    });
  const effectGroup = radioGroup({
    label: P('effect'),
    cls: 'pfe-effects',
    options: effectOptions(),
    value: ns().effect,
    render: (o) => [h('span', { class: 'pfe-sample' }, sample({ ...ns(), effect: o.id })), h('span', { class: 'pfe-radio-label' }, o.label)],
    onLocked: () => (locked ? null : goPlans()),
    onPick: (id) => {
      ns().effect = id;
      syncNameEffectItem();
      schedule();
    },
  });
  // Color y brillo
  const colorInput = h('input', { type: 'color', class: 'pfe-color', value: ns().color || M.DEFAULT_NAME_COLOR, 'aria-label': P('nameColorCustom'), disabled: locked });
  const colorNote = h('div', { class: 'field-help pfe-color-note', hidden: true }, P('nameColorAdjusted'));
  const colorGroup = h('div', { class: 'pfe-swatches', role: 'radiogroup', 'aria-label': P('nameColor') });
  function drawColors() {
    const cur = ns().color;
    mount(
      colorGroup,
      h('button', { type: 'button', role: 'radio', class: ['pfe-swatch', 'auto', !cur && 'active'], 'aria-checked': String(!cur), title: P('nameColorAuto'), 'aria-label': P('nameColorAuto'), disabled: locked, onclick: () => setColor(null) }, h('span', {}, 'A')),
      M.NAME_COLORS.map((c) => h('button', { type: 'button', role: 'radio', class: ['pfe-swatch', cur === c && 'active'], 'aria-checked': String(cur === c), style: { background: c }, title: P('nameColorSwatch', { color: c }), 'aria-label': P('nameColorSwatch', { color: c }), disabled: locked, onclick: () => setColor(c) })),
      h('label', { class: ['pfe-swatch', 'custom', cur && !M.NAME_COLORS.includes(cur) && 'active'], title: P('nameColorCustom') }, colorInput, icon('palette')),
    );
    colorNote.hidden = !cur || M.readableColor(cur) === cur;
  }
  function setColor(c) {
    ns().color = c;
    if (c) colorInput.value = c;
    drawColors();
    refreshSamples();
    schedule();
  }
  colorInput.addEventListener('input', () => setColor(colorInput.value.toLowerCase()));
  const glowInput = h('input', { type: 'range', class: 'pfe-range', min: 0, max: 100, step: 5, value: ns().glow, disabled: locked });
  const glowOut = h('output', { class: 'pfe-range-value num' }, P('glowValue', { value: ns().glow }));
  glowInput.addEventListener('input', () => {
    ns().glow = Number(glowInput.value);
    glowOut.textContent = P('glowValue', { value: glowInput.value });
    schedule();
  });
  drawColors();
  function refreshSamples() {
    fontGroup.set(ns().font);
    effectGroup.set(ns().effect);
  }
  panel(
    'style',
    locked ? unavailableNote() : null,
    h('div', { class: 'pfe-group' }, h('div', { class: 'pfe-group-row' }, groupTitle(P('fade'), P('fadeHint')), fadeSwitch), fadeControls),
    h('div', { class: 'pfe-group' }, groupTitle(P('font')), fontGroup.el),
    h('div', { class: 'pfe-group' }, groupTitle(P('effect'), P('effectHint')), effectGroup.el),
    h(
      'div',
      { class: 'pfe-group pfe-two' },
      h('div', {}, groupTitle(P('nameColor')), colorGroup, colorNote),
      h('div', {}, groupTitle(P('glow'), P('glowHint')), h('label', { class: 'pfe-range-field compact' }, h('span', { class: 'sr-only' }, P('glow')), glowInput, glowOut)),
    ),
  );
  if (locked) for (const g of [fontGroup.el, effectGroup.el]) g.querySelectorAll('button').forEach((b) => (b.disabled = true));

  // ===== Banner =====
  const banner = () => S.draft.custom.banner;
  const bannerKindOf = () => (banner().kind === 'preset' ? 'preset' : banner().kind === 'image' ? 'image' : banner().kind === 'animated' ? 'animated' : 'color');
  let bannerTab = bannerKindOf();
  const bannerArea = h('div', { class: 'pfe-banner-area' });
  const bannerSeg = h('div', { class: 'segmented pfe-banner-seg', role: 'group', 'aria-label': P('bannerKind') });
  function drawBannerSeg() {
    mount(
      bannerSeg,
      ['preset', 'image', 'animated', 'color'].map((k) =>
        h(
          'button',
          { type: 'button', class: bannerTab === k ? 'active' : '', 'aria-pressed': String(bannerTab === k), onclick: () => ((bannerTab = k), drawBannerSeg(), drawBannerArea()) },
          k === 'animated' && !S.premium ? icon('crown') : null,
          P(`bannerKind_${k}`),
        ),
      ),
    );
  }
  const setBanner = (b) => {
    S.draft.custom.banner = b;
    schedule();
  };
  const fileInput = (accept, onFile) => {
    const el = h('input', { type: 'file', accept, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
    el.addEventListener('change', () => {
      const f = el.files?.[0];
      el.value = '';
      if (f) onFile(f);
    });
    return el;
  };
  const mediaMessage = (err) => P(`errMedia_${MEDIA_CODES.includes(err?.code) ? err.code : 'decode'}`);
  async function pickBannerImage(file, btn) {
    const done = setBusy(btn);
    showError('');
    try {
      const src = await readImageFile(file);
      if (S.bannerSource) URL.revokeObjectURL(S.bannerSource.url);
      S.bannerSource = src;
      S.bannerFocus = 0.5;
      await renderBannerImage();
    } catch (err) {
      showError(mediaMessage(err));
    } finally {
      done();
    }
  }
  async function renderBannerImage() {
    const out = await bannerFromImage(S.bannerSource.img, S.bannerFocus);
    if (S.pending.banner?.url) URL.revokeObjectURL(S.pending.banner.url);
    track(out.url);
    S.pending.banner = { ...out, kind: 'image' };
    setBanner({ kind: 'image', url: out.url });
    drawBannerArea();
  }
  async function pickGif(file, btn) {
    const done = setBusy(btn);
    showError('');
    try {
      const out = await gifBanner(file);
      track(out.url);
      if (S.pending.banner?.url) URL.revokeObjectURL(S.pending.banner.url);
      S.pending.banner = { ...out, kind: 'animated' };
      setBanner({ kind: 'animated', url: out.url });
      drawBannerArea();
    } catch (err) {
      showError(mediaMessage(err));
    } finally {
      done();
    }
  }
  function drawBannerArea() {
    const b = banner();
    if (bannerTab === 'preset') {
      const group = radioGroup({
        label: P('bannerKind_preset'),
        cls: 'pfe-presets',
        options: M.BANNER_PRESETS.map((id) => ({ id, label: P(`banner_${id}`) })),
        value: b.kind === 'preset' ? b.preset : null,
        render: (o) => [h('span', { class: 'pfe-preset-art', style: { background: M.presetCss(o.id) }, 'aria-hidden': 'true' }), h('span', { class: 'pfe-radio-label' }, o.label)],
        onPick: (id) => setBanner({ kind: 'preset', preset: id }),
      });
      if (locked) group.el.querySelectorAll('button').forEach((x) => (x.disabled = true));
      mount(bannerArea, group.el);
    } else if (bannerTab === 'image') {
      const has = b.kind === 'image';
      const pickBtn = h('button', { class: 'btn tonal', type: 'button', disabled: locked }, icon('upload'), has ? P('bannerReplace') : P('bannerPick'));
      const input = fileInput('image/png,image/jpeg,image/webp', (f) => pickBannerImage(f, pickBtn));
      pickBtn.addEventListener('click', () => input.click());
      const focusInput = h('input', { type: 'range', class: 'pfe-range', min: 0, max: 100, step: 1, value: Math.round(S.bannerFocus * 100) });
      focusInput.addEventListener('change', async () => {
        S.bannerFocus = Number(focusInput.value) / 100;
        try {
          await renderBannerImage();
        } catch (err) {
          showError(mediaMessage(err));
        }
      });
      mount(
        bannerArea,
        h(
          'div',
          { class: 'pfe-upload' },
          has ? h('div', { class: 'pfe-upload-preview', style: { backgroundImage: `url("${b.url}")` }, role: 'img', 'aria-label': P('bannerKind_image') }) : h('div', { class: 'pfe-upload-empty' }, icon('image'), h('span', {}, P('bannerImageHint'))),
          h(
            'div',
            { class: 'pfe-upload-actions' },
            pickBtn,
            input,
            has ? h('button', { class: 'btn ghost', type: 'button', onclick: () => (S.pending.banner = null, setBanner({ kind: 'none' }), (bannerTab = 'color'), drawBannerSeg(), drawBannerArea()) }, icon('trash'), P('bannerRemove')) : null,
            S.pending.banner?.kind === 'image' ? h('span', { class: 'pill info' }, icon('cloudUpload'), P('pendingUpload')) : null,
          ),
          has && S.bannerSource ? h('label', { class: 'pfe-range-field' }, h('span', {}, P('bannerFocus')), focusInput) : null,
          has ? h('div', { class: 'field-help' }, P('bannerImageHint')) : null,
        ),
      );
    } else if (bannerTab === 'animated') {
      if (!S.premium) {
        mount(
          bannerArea,
          h(
            'div',
            { class: 'pfe-locked' },
            h('span', { class: 'pfe-locked-icon' }, icon('lock')),
            h('div', { class: 'pfe-locked-text' }, h('strong', {}, P('bannerGifLocked')), h('span', {}, P('bannerGifLockedText'))),
            h('button', { class: 'btn tonal sm', type: 'button', onclick: goPlans }, icon('crown'), P('seePlans')),
          ),
        );
        return;
      }
      const has = b.kind === 'animated';
      const pickBtn = h('button', { class: 'btn tonal', type: 'button', disabled: locked }, icon('upload'), P('bannerGifPick'));
      const input = fileInput('image/gif', (f) => pickGif(f, pickBtn));
      pickBtn.addEventListener('click', () => input.click());
      mount(
        bannerArea,
        h(
          'div',
          { class: 'pfe-upload' },
          has ? h('div', { class: 'pfe-upload-preview', style: { backgroundImage: `url("${b.url}")` }, role: 'img', 'aria-label': P('bannerKind_animated') }) : h('div', { class: 'pfe-upload-empty' }, icon('sparkles'), h('span', {}, P('bannerGifHint'))),
          h(
            'div',
            { class: 'pfe-upload-actions' },
            pickBtn,
            input,
            has ? h('button', { class: 'btn ghost', type: 'button', onclick: () => (S.pending.banner = null, setBanner({ kind: 'none' }), (bannerTab = 'color'), drawBannerSeg(), drawBannerArea()) }, icon('trash'), P('bannerRemove')) : null,
            S.pending.banner?.kind === 'animated' ? h('span', { class: 'pill info' }, icon('cloudUpload'), P('pendingUpload')) : null,
          ),
          has ? h('div', { class: 'field-help' }, P('bannerGifHint')) : null,
        ),
      );
    } else {
      // Color clasico (columna banner de siempre): se ve cuando no hay diseño ni imagen
      const cur = parseBanner(S.draft.basics.banner);
      const colorA = h('input', { type: 'color', class: 'pfe-color', value: cur.kind === 'preset' ? '#f29a2e' : cur.colors[0], 'aria-label': t('social.bannerColorA') });
      const colorB = h('input', { type: 'color', class: 'pfe-color', value: cur.kind === 'preset' ? '#3b1450' : cur.colors[1], 'aria-label': t('social.bannerColorB') });
      const pickLegacy = (value) => {
        S.draft.basics.banner = value;
        if (banner().kind !== 'none') S.draft.custom.banner = { kind: 'none' };
        schedule();
        drawBannerArea();
      };
      const custom = () => pickLegacy(encodeBanner({ kind: colorA.value === colorB.value ? 'solid' : 'gradient', colors: [colorA.value, colorB.value] }));
      colorA.addEventListener('change', custom);
      colorB.addEventListener('change', custom);
      const active = b.kind === 'none';
      mount(
        bannerArea,
        h(
          'div',
          { class: 'pfe-legacy' },
          h(
            'div',
            { class: 'pfe-legacy-grid', role: 'radiogroup', 'aria-label': P('bannerKind_color') },
            BANNERS.map((x) => {
              const on = active && cur.kind === 'preset' && cur.id === x.id;
              return h('button', { type: 'button', role: 'radio', class: ['pfe-legacy-swatch', on && 'active'], 'aria-checked': String(on), title: bannerName(x.id), 'aria-label': bannerName(x.id), style: { background: bannerBackground(x.id) }, onclick: () => pickLegacy(x.id) });
            }),
            h('div', { class: ['pfe-legacy-custom', active && cur.kind !== 'preset' && 'active'], title: P('bannerColorCustom') }, colorA, colorB),
          ),
          h('div', { class: 'field-help' }, P('bannerColorHint')),
        ),
      );
    }
  }
  drawBannerSeg();
  drawBannerArea();
  panel('banner', locked ? unavailableNote() : null, h('div', { class: 'pfe-group' }, bannerSeg, bannerArea));

  // ===== Vitrina =====
  const servers = () => S.draft.custom.favoriteServers;
  const serverList = h('div', { class: 'pfe-servers' });
  const addrInput = h('input', { class: 'input mono', placeholder: 'mc.hypixel.net', maxlength: 259, disabled: locked, autocomplete: 'off', spellcheck: 'false' });
  const srvNameInput = h('input', { class: 'input', placeholder: P('serverNamePlaceholder'), maxlength: M.LIMITS.serverName, disabled: locked });
  const srvErr = errorLine();
  const addSrvBtn = h('button', { class: 'btn', type: 'button', disabled: locked }, icon('plus'), P('serverAdd'));
  const suggestBox = h('div', { class: 'pfe-suggest' });
  let savedServers = null;
  function addServer(address, name) {
    const a = String(address || '').trim().toLowerCase().replace(/^minecraft:\/\//, '');
    if (servers().length >= M.LIMITS.favoriteServers) return srvErr.set(P('serversFull'), addrInput), false;
    if (!M.isServerAddress(a) || !publicAddress(a)) return srvErr.set(P('serverInvalid'), addrInput), false;
    if (servers().some((s) => s.address === a)) return srvErr.set(P('serverDuplicate'), addrInput), false;
    const nm = M.cleanText(name, M.LIMITS.serverName).replace(/[<>]/g, '');
    servers().push(nm ? { address: a, name: nm } : { address: a });
    srvErr.set('', addrInput);
    drawServers();
    schedule();
    return true;
  }
  addSrvBtn.addEventListener('click', () => {
    if (addServer(addrInput.value, srvNameInput.value)) {
      addrInput.value = '';
      srvNameInput.value = '';
      addrInput.focus();
    } else addrInput.focus();
  });
  for (const el of [addrInput, srvNameInput]) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addSrvBtn.click();
      }
    });
  }
  addrInput.addEventListener('input', () => srvErr.set('', addrInput));
  function drawServers() {
    const list = servers();
    mount(
      serverList,
      list.length
        ? list.map((s, i) =>
            h(
              'div',
              { class: 'pfe-server' },
              h('span', { class: 'pf-server-icon' }, icon('server')),
              h('div', { class: 'pfe-server-main' }, h('span', { class: 'pfe-server-name ellipsis' }, s.name || s.address), s.name ? h('span', { class: 'pfe-server-addr ellipsis mono' }, s.address) : null),
              h('button', { class: 'icon-btn sm', type: 'button', disabled: locked || i === 0, title: P('moveUp'), 'aria-label': P('moveUp'), onclick: () => (list.splice(i - 1, 0, list.splice(i, 1)[0]), drawServers(), schedule()) }, icon('chevronDown', 'pfe-flip')),
              h('button', { class: 'icon-btn sm danger', type: 'button', disabled: locked, title: P('serverRemove', { name: s.name || s.address }), 'aria-label': P('serverRemove', { name: s.name || s.address }), onclick: () => (list.splice(i, 1), drawServers(), schedule()) }, icon('trash')),
            ),
          )
        : h('div', { class: 'pfe-empty-line' }, P('serversEmpty')),
    );
    addSrvBtn.disabled = locked || list.length >= M.LIMITS.favoriteServers;
    drawSuggestions();
  }
  function drawSuggestions() {
    const list = (savedServers || []).filter((s) => !servers().some((x) => x.address === s.address));
    mount(
      suggestBox,
      list.length && servers().length < M.LIMITS.favoriteServers && !locked
        ? [
            h('span', { class: 'pfe-suggest-label' }, P('serverSuggestions')),
            h(
              'div',
              { class: 'chips' },
              list.slice(0, 6).map((s) => h('button', { class: 'chip', type: 'button', title: s.address, onclick: () => addServer(s.address, s.name) }, icon('plus'), h('span', { class: 'ellipsis' }, s.name || s.address))),
            ),
          ]
        : [],
    );
  }
  drawServers();

  // Estadisticas
  const statsBox = h('div', { class: 'pfe-stats' });
  const statsSwitch = switchEl(S.publishStats, (v) => {
    S.publishStats = v;
    if (v && S.stats === undefined) fetchStats();
    drawStats();
    schedule();
  }, P('stats'));
  if (locked) statsSwitch.querySelector('input').disabled = true;
  function drawStats() {
    if (!S.publishStats) {
      mount(statsBox, []);
      return;
    }
    if (S.stats === undefined) mount(statsBox, h('div', { class: 'pfe-empty-line' }, skeleton('line', { width: 220, label: P('statsLoading') })));
    else if (S.stats === null) mount(statsBox, h('div', { class: 'pfe-empty-line' }, icon('alert'), P('statsUnavailable')));
    else if (!S.stats.sessions) mount(statsBox, h('div', { class: 'pfe-empty-line' }, icon('info'), P('statsEmpty')));
    else {
      const s = S.stats;
      const nf = (v, max = 0) => new Intl.NumberFormat(locale(), { maximumFractionDigits: max }).format(v);
      const since = s.since ? new Date(`${s.since}T12:00:00`).getTime() : NaN;
      const items = [
        [P('statHours'), P('hoursShort', { hours: nf(s.hours, s.hours < 10 ? 1 : 0) })],
        [P('statSessions'), nf(s.sessions)],
        s.topVersion ? [P('statVersion'), s.topVersion] : null,
        s.topLoader ? [P('statLoader'), LOADERS[s.topLoader]?.name || s.topLoader] : null,
        Number.isFinite(since) ? [P('statSince'), fmtDate(since, { month: 'long', year: 'numeric' })] : null,
      ].filter(Boolean);
      mount(statsBox, h('dl', { class: 'pfe-stats-list' }, items.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', { class: 'num' }, v)))));
    }
  }
  async function fetchStats() {
    S.stats = undefined;
    drawStats();
    S.stats = await loadStats(S.demo);
    drawStats();
    schedule();
  }
  let showcaseLoaded = false;
  function ensureShowcaseData() {
    if (showcaseLoaded) return;
    showcaseLoaded = true;
    loadSavedServers(S.demo).then((list) => {
      savedServers = list;
      drawSuggestions();
    });
    if (S.publishStats && S.stats === undefined) fetchStats();
  }
  drawStats();

  // Capturas destacadas
  const featured = () => S.draft.custom.featured;
  const featuredBox = h('div', { class: 'pfe-featured' });
  const addShotBtn = h('button', { class: 'pfe-shot-add', type: 'button', disabled: locked }, icon('plus'), h('span', {}, P('featuredAdd')));
  const shotInput = fileInput('image/png,image/jpeg,image/webp', async (file) => {
    const done = setBusy(addShotBtn);
    showError('');
    try {
      const src = await readImageFile(file);
      const out = await featuredFromImage(src.img);
      URL.revokeObjectURL(src.url);
      track(out.url);
      S.pending.featured.set(out.url, out);
      featured().push({ url: out.url });
      drawFeatured();
      schedule();
    } catch (err) {
      showError(mediaMessage(err));
    } finally {
      done();
    }
  });
  addShotBtn.addEventListener('click', () => shotInput.click());
  function drawFeatured() {
    const list = featured();
    const move = (i, d) => {
      list.splice(i + d, 0, list.splice(i, 1)[0]);
      drawFeatured();
      schedule();
    };
    mount(
      featuredBox,
      list.map((f, i) => {
        const title = h('input', { class: 'input', value: f.title || '', maxlength: M.LIMITS.featuredTitle, placeholder: P('featuredTitlePlaceholder'), 'aria-label': P('featuredTitleLabel', { n: i + 1 }), disabled: locked });
        title.addEventListener('input', () => {
          f.title = title.value;
          schedule();
        });
        return h(
          'div',
          { class: 'pfe-shot' },
          h('div', { class: 'pfe-shot-img', style: { backgroundImage: `url("${f.url}")` }, role: 'img', 'aria-label': f.title || P('featuredAlt') }, S.pending.featured.has(f.url) ? h('span', { class: 'pill info pfe-shot-pending' }, icon('cloudUpload'), P('pendingUpload')) : null),
          title,
          h(
            'div',
            { class: 'pfe-shot-actions' },
            h('button', { class: 'icon-btn sm', type: 'button', disabled: locked || i === 0, title: P('featuredLeft'), 'aria-label': P('featuredLeft'), onclick: () => move(i, -1) }, icon('chevronLeft')),
            h('button', { class: 'icon-btn sm', type: 'button', disabled: locked || i === list.length - 1, title: P('featuredRight'), 'aria-label': P('featuredRight'), onclick: () => move(i, 1) }, icon('chevronRight')),
            h('span', { class: 'spacer' }),
            h(
              'button',
              {
                class: 'icon-btn sm danger',
                type: 'button',
                disabled: locked,
                title: P('featuredRemove'),
                'aria-label': P('featuredRemove'),
                onclick: () => {
                  list.splice(i, 1);
                  S.pending.featured.delete(f.url);
                  drawFeatured();
                  schedule();
                },
              },
              icon('trash'),
            ),
          ),
        );
      }),
      list.length < M.LIMITS.featured ? h('div', { class: 'pfe-shot pfe-shot-new' }, addShotBtn, shotInput) : null,
    );
  }
  drawFeatured();
  panel(
    'showcase',
    locked ? unavailableNote() : null,
    h(
      'div',
      { class: 'pfe-group' },
      groupTitle(P('favoriteServers'), P('serversHint')),
      serverList,
      h('div', { class: 'pfe-server-add' }, fieldBox(P('serverAddress'), addrInput, { error: srvErr }), fieldBox(P('serverName'), srvNameInput), addSrvBtn),
      suggestBox,
    ),
    h('div', { class: 'pfe-group' }, h('div', { class: 'pfe-group-row' }, groupTitle(P('stats'), P('statsHint')), statsSwitch), statsBox),
    h('div', { class: 'pfe-group' }, groupTitle(P('featured'), P('featuredHint')), featuredBox),
  );

  // ===== Cosmeticos =====
  const itemsBox = h('div', { class: 'pfe-items' });
  const eq = () => S.draft.custom.equipped;
  const itemName = (it) => {
    if (it.kind === 'frame') return P(`frame_${it.style}`);
    if (it.kind === 'title') return titleLabel(it.style) || it.id;
    if (it.kind === 'badge_style') return P(`badge_${it.style}`);
    if (it.kind === 'name_effect') return P(`effect_${it.style}`);
    return it.id;
  };
  // Si se usa un efecto premium que la cuenta compro, queda equipado tambien en la tienda
  function syncNameEffectItem() {
    const fx = ns().effect;
    const it = S.items.find((i) => i.kind === 'name_effect' && i.style === fx && S.owned.has(i.id));
    if (it) eq().nameEffect = it.id;
    else delete eq().nameEffect;
    drawItems();
  }
  function itemPreview(it) {
    if (it.kind === 'frame') {
      const wrap = h('span', { class: 'sc-headwrap pfe-item-head', style: { width: '40px', height: '40px' } }, headImg({ mc_name: S.draft.basics.mc_name, username: S.n.username }, 40));
      return applyFrame(wrap, { equipped: { frame: it.id }, hasStyle: true });
    }
    if (it.kind === 'title') return h('span', { class: 'pf-title', dataset: { title: it.style } }, titleLabel(it.style));
    if (it.kind === 'badge_style') return premiumChip({ premium: false, equipped: { badgeStyle: it.id }, hasStyle: true });
    if (it.kind === 'name_effect') return sample({ ...ns(), effect: it.style });
    return null;
  }
  function drawItems() {
    const groups = SLOTS.map(({ slot, kind }) => {
      const list = S.items.filter((i) => i.kind === kind && i.active !== false);
      const options = [{ id: '', label: P('itemNone') }];
      for (const it of list) {
        const usable = M.canEquip(slot, it.id, ctx());
        const premiumLock = !usable && it.premiumOnly;
        options.push({
          id: it.id,
          label: itemName(it),
          item: it,
          locked: !usable || locked,
          lockIcon: premiumLock ? 'crown' : 'lock',
          lockText: usable ? null : premiumLock ? P('lockedPremium') : P('lockedShop', { price: it.price }),
          aria: usable ? itemName(it) : premiumLock ? P('lockedPremiumTitle', { name: itemName(it) }) : P('lockedShopTitle', { name: itemName(it), price: it.price }),
        });
      }
      const group = radioGroup({
        label: P(`slot_${slot}`),
        cls: 'pfe-item-grid',
        options,
        value: eq()[slot] || '',
        render: (o) => [h('span', { class: 'pfe-item-art' }, o.item ? itemPreview(o.item) : icon('x')), h('span', { class: 'pfe-radio-label' }, o.label)],
        onLocked: (o) => (locked ? null : o.item?.premiumOnly ? goPlans() : goShop(() => dialog.close())),
        onPick: (id) => {
          if (id) eq()[slot] = id;
          else delete eq()[slot];
          if (slot === 'nameEffect') {
            const it = S.items.find((i) => i.id === id);
            ns().effect = it ? it.style : M.PREMIUM_EFFECTS.includes(ns().effect) ? 'none' : ns().effect;
            effectGroup.set(ns().effect);
          }
          schedule();
        },
      });
      return h('div', { class: 'pfe-group' }, groupTitle(P(`slot_${slot}`), slot === 'badgeStyle' ? P('badgeStyleHint') : null), group.el);
    });
    mount(itemsBox, groups);
  }
  drawItems();
  panel(
    'items',
    locked ? unavailableNote() : null,
    h('div', { class: 'pfe-items-head' }, h('p', { class: 'pfe-group-sub' }, P('itemsHint')), h('button', { class: 'btn ghost sm', type: 'button', onclick: () => goShop(() => dialog.close()) }, icon('star'), P('goShop'))),
    itemsBox,
  );

  // ---------- Armado ----------
  mount(
    body,
    h('aside', { class: 'pfe-side', 'aria-label': P('previewLabel') }, h('div', { class: 'pfe-side-label' }, icon('eye'), P('previewHint')), previewBox, h('div', { class: 'pfe-side-label' }, icon('users'), P('listPreview')), listBox),
    h('div', { class: 'pfe-main' }, tabsEl, notice, ...TABS.map((x) => panels[x.id])),
  );
  selectTab(activeTab);
  schedule();
  shareBtn.disabled = false;
  shareBtn.addEventListener('click', () => openShareProfile({ profile: previewRaw(), demo: Boolean(S.demo) }));
  setTimeout(() => (activeTab === 'identity' ? nameInput : tabButtons[activeTab]).focus({ preventScroll: true }), 40);

  // ---------- Guardar ----------
  function placeholderUrls(custom) {
    const c = clone(custom);
    const fake = (i) => `${PLACEHOLDER_HOST}/${S.uid}/pending-${i}.webp`;
    if ((c.banner?.kind === 'image' || c.banner?.kind === 'animated') && S.pending.banner?.url === c.banner.url) c.banner.url = fake(0);
    c.featured = (c.featured || []).map((f, i) => (S.pending.featured.has(f.url) ? { ...f, url: fake(i + 1) } : f));
    return c;
  }
  function failWith(info) {
    const code = info.code;
    const key = code.startsWith('premium_required:') ? `err_premium_${info.field}` : code.startsWith('not_owned:') ? 'err_not_owned' : code.startsWith('bad_field:') ? 'err_bad_request' : `err_${code}`;
    let text = P(key, { item: info.item ? itemName(S.items.find((i) => i.id === info.item) || { id: info.item }) : '' });
    if (text === key) text = P('err_unknown');
    let action = null;
    if (info.kind === 'premium') action = h('button', { class: 'btn tonal sm', type: 'button', onclick: goPlans }, icon('crown'), P('seePlans'));
    else if (info.kind === 'session') action = h('button', { class: 'btn sm', type: 'button', onclick: () => (dialog.close(), navigate('settings/cloud')) }, P('signedOutAction'));
    showError(text, action);
    const tabId = FIELD_TAB[info.field];
    if (tabId) selectTab(tabId);
    if (info.field === 'pronouns') pronErr.set(text, pronInput);
    if (info.field === 'bio') bioErr.set(text, bioInput);
  }

  saveBtn.addEventListener('click', async () => {
    showError('');
    // Datos basicos
    const b = S.draft.basics;
    if (b.display_name.trim().length > M.LIMITS.displayName) {
      selectTab('identity');
      nameErr.set(P('displayNameLong'), nameInput);
      return nameInput.focus();
    }
    const mc = b.mc_name.trim();
    if (mc && !isMcName(mc)) {
      selectTab('identity');
      mcErr.set(t('social.mcNameInvalid'), mcInput);
      return mcInput.focus();
    }
    const custom = currentCustom();
    const basics = basicsDiff();
    if (!S.available) {
      // Sin la personalizacion del servidor: la descripcion va por la tabla, como antes
      const bio = typeof custom.bio === 'string' ? custom.bio.trim() || null : null;
      if (bio !== (S.saved.custom.bio || null)) basics.bio = bio;
    }
    const check = S.available ? M.validatePatch(M.buildPatch(S.saved.custom, placeholderUrls(custom)), ctx()) : { ok: true };
    if (!check.ok) return failWith(M.parseCustomizeError({ message: check.code }));
    const release = setBusy(saveBtn);
    try {
      if (S.demo) {
        await new Promise((r) => setTimeout(r, 500));
      } else {
        // Imagenes nuevas: primero se hace lugar (limite de 12) y despues se suben
        const pendingCount = (S.pending.banner && S.pending.banner.url === custom.banner?.url ? 1 : 0) + custom.featured.filter((f) => S.pending.featured.has(f.url)).length;
        if (S.available && pendingCount) {
          const keep = [S.saved.custom.banner?.url, ...S.saved.custom.featured.map((f) => f.url), ...custom.featured.map((f) => f.url)].filter((u) => u && /^https:/.test(u));
          dirtyNote.textContent = P('uploading');
          await makeRoom(keep, pendingCount);
          if (S.pending.banner && S.pending.banner.url === custom.banner?.url) custom.banner.url = await uploadMedia(S.pending.banner.blob, { kind: 'banner', ext: S.pending.banner.ext });
          for (const f of custom.featured) {
            const p = S.pending.featured.get(f.url);
            if (p) f.url = await uploadMedia(p.blob, { kind: 'featured', ext: p.ext });
          }
        }
        if (Object.keys(basics).length) {
          if (socialReady) await social.updateProfile(basics);
          else await cloud.updateProfile(basics);
        }
        const patch = S.available ? M.buildPatch(S.saved.custom, custom) : {};
        if (Object.keys(patch).length) {
          const { error } = await cloud.client.rpc('profile_customize', { p_patch: patch });
          if (error) throw error;
        }
        if (prefsChanged()) await social.setPrefs({ ...S.draft.prefs });
        // Imagenes viejas que ya no usa nada: a borrar (si falla, se borran la proxima vez que haga falta lugar)
        const used = new Set([custom.banner?.url, ...custom.featured.map((f) => f.url)].filter(Boolean));
        const old = [S.saved.custom.banner?.url, ...S.saved.custom.featured.map((f) => f.url)].filter((u) => u && !used.has(u));
        const mine = old.map((u) => M.mediaPathFromUrl(u)).filter((p) => p && p.userId.toLowerCase() === S.uid.toLowerCase()).map((p) => p.name);
        if (mine.length) removeMedia(mine).catch((err) => console.warn('[profile] borrar imagenes viejas:', err?.message || err));
        forgetPublicProfile(S.uid);
        setStyleCache(S.uid, { ...previewRaw(), banner_style: custom.banner, featured: custom.featured, hasStyle: true });
        cloud.loadProfile().catch(() => null);
      }
      S.pending.banner = null;
      S.pending.featured.clear();
      dialog.close();
      ok(P('saved'));
    } catch (err) {
      if (err instanceof MediaError) showError(mediaMessage(err));
      else if (err?.code && typeof err.code === 'string' && /^(user_|bad_|not_)/.test(err.code)) failWith(M.parseCustomizeError({ message: err.code }));
      else {
        const info = M.parseCustomizeError(err);
        if (info.kind === 'unknown') console.warn('[profile] guardar:', err?.message || err);
        failWith(info);
      }
      updateDirty();
    } finally {
      release();
    }
  });

  return dialog;
}

function signedOutDialog() {
  let d;
  const go = h('button', { class: 'btn primary', type: 'button', onclick: () => (d.close(), navigate('settings/cloud')) }, icon('logIn'), P('signedOutAction'));
  d = modal({ title: P('editorTitle'), icon: 'palette', size: 'sm', body: emptyState('user', P('signedOutTitle'), P('signedOutText'), go) });
  setTimeout(() => go.focus(), 40);
  return d;
}

// ---------- Compartir mi perfil (imagen PNG) ----------
function safeFileName(name) {
  return String(name || 'perfil').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, '-').slice(0, 40) || 'perfil';
}

async function loadShareImages(n) {
  const { avatarUrl } = await import('../ui.js');
  const head = (() => {
    if (/^[0-9a-f]{32}$|^[0-9a-f-]{36}$/i.test(n.mcUuid || '')) return n.mcUuid.replace(/-/g, '');
    if (isMcName(n.mcName)) return n.mcName;
    if (isMcName(n.username)) return n.username;
    return 'MHF_Steve';
  })();
  const safe = (p) => p.catch(() => null);
  const bannerUrl = n.banner.kind === 'image' || n.banner.kind === 'animated' ? n.banner.url : null;
  const [headImgEl, bannerImg, logo] = await Promise.all([
    safe(loadImage(avatarUrl(head, 128), { cors: true })),
    bannerUrl ? safe(loadImage(bannerUrl, { cors: !/^(blob:|data:)/.test(bannerUrl) })) : null,
    safe(loadImage('assets/logo-256.png')),
    loadFonts(),
  ]);
  return { head: headImgEl, banner: bannerImg, logo };
}

/**
 * Dialogo con la imagen PNG de la tarjeta del perfil (Copiar imagen y Guardar PNG).
 * profile: el perfil a dibujar (por defecto el propio, de profile_public). demo: capturas de desarrollo.
 */
export async function openShareProfile({ profile = null, demo = false } = {}) {
  await ensureUi();
  let raw = profile;
  if (!raw && demo && isDevshot()) raw = (await import('./profile-editor/demo.js')).demoProfile('premium');
  if (!raw) {
    await cloud.ready().catch(() => null);
    if (!cloud.isSignedIn()) return signedOutDialog();
    raw = combine(cloud.profile || {}, await fetchPublicProfile(cloud.user.id));
  }
  const n = normalize(M.normalizeProfile(raw, { allowLocalMedia: true }));
  const canvas = h('canvas', { class: 'pfe-share-canvas', role: 'img', 'aria-label': P('shareAlt', { name: n.name || P('someone') }) });
  const stage = h('div', { class: 'pfe-share-stage' }, skeleton('block', { height: 320, label: P('shareDrawing') }));
  const copyBtn = h('button', { class: 'btn', type: 'button', disabled: true }, icon('copy'), P('shareCopy'));
  const saveBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, icon('download'), P('shareSave'));
  const d = modal({
    title: P('shareTitle'),
    subtitle: P('shareSub'),
    icon: 'share',
    size: 'wide',
    body: h('div', { class: 'pfe-share' }, stage, h('p', { class: 'pfe-share-note' }, icon('shield'), P('shareNote'))),
    footer: [h('span', { class: 'spacer' }), copyBtn, saveBtn],
  });
  try {
    const images = await loadShareImages(n);
    drawShareCard(canvas, n, { images });
    mount(stage, canvas);
    copyBtn.disabled = false;
    saveBtn.disabled = false;
  } catch (err) {
    console.warn('[profile] imagen:', err?.message || err);
    mount(stage, emptyState('alert', P('shareFailed'), P('err_unknown')));
    return d;
  }
  const toBlob = () =>
    new Promise((resolve, reject) => {
      try {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('blob'))), 'image/png');
      } catch (err) {
        reject(err);
      }
    });
  copyBtn.addEventListener('click', async () => {
    const done = setBusy(copyBtn);
    try {
      const blob = await toBlob();
      // En las capturas de desarrollo no se toca el portapapeles
      if (!isDevshot()) await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      ok(P('shareCopied'), P('shareCopiedText'));
    } catch (err) {
      console.warn('[profile] copiar imagen:', err?.message || err);
      fail(P('shareCopyFailed'));
    } finally {
      done();
    }
  });
  saveBtn.addEventListener('click', async () => {
    const done = setBusy(saveBtn);
    try {
      const blob = await toBlob();
      if (!isDevshot()) {
        const url = URL.createObjectURL(blob);
        const a = h('a', { href: url, download: `${P('shareFile', { name: safeFileName(n.username || n.name) })}.png`, hidden: true });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      ok(P('shareSaved'), P('shareSavedText'));
    } catch (err) {
      console.warn('[profile] guardar imagen:', err?.message || err);
      fail(P('shareSaveFailed'));
    } finally {
      done();
    }
  });
  return d;
}

// ---------- Destacar una captura (lo usa Capturas y clips) ----------
/**
 * Sube una captura al perfil y la agrega a las destacadas (hasta 3; si ya hay 3, pregunta si reemplaza la primera).
 * src: URL file:, data: o blob:, o un Blob. title: texto opcional (hasta 60). Devuelve true si quedo destacada.
 */
export async function featureCapture({ src, title = '' } = {}) {
  await ensureUi();
  await cloud.ready().catch(() => null);
  if (!cloud.isSignedIn()) {
    signedOutDialog();
    return false;
  }
  try {
    const me = cloud.user.id;
    const pub = await fetchPublicProfile(me, { force: true });
    if (!pub) throw Object.assign(new Error('unavailable'), { code: 'PGRST202' });
    const list = M.normalizeProfile(pub).featured.map((f) => ({ ...f }));
    let replaced = null;
    if (list.length >= M.LIMITS.featured) {
      const first = list[0];
      const yes = await confirmDialog(P('featureReplace'), P('featureReplaceText', { title: first.title || P('featureUntitled') }), { okText: P('featureReplaceOk') });
      if (!yes) return false;
      replaced = list.shift();
    }
    const out = await featuredFromSource(src);
    URL.revokeObjectURL(out.url);
    await makeRoom([pub.banner?.url, ...list.map((f) => f.url)].filter(Boolean), 1);
    const url = await uploadMedia(out.blob, { kind: 'featured', ext: out.ext });
    const clean = M.cleanText(title, M.LIMITS.featuredTitle);
    list.push(clean ? { url, title: clean } : { url });
    const { error } = await cloud.client.rpc('profile_customize', { p_patch: { featured: list } });
    if (error) throw error;
    const old = replaced && M.mediaPathFromUrl(replaced.url);
    if (old && old.userId.toLowerCase() === me.toLowerCase()) removeMedia([old.name]).catch(() => null);
    forgetPublicProfile(me);
    ok(P('featureDone'), P('featureDoneText'));
    return true;
  } catch (err) {
    const info = err instanceof MediaError ? null : M.parseCustomizeError(err);
    if (info) console.warn('[profile] destacar captura:', err?.message || err);
    const key = info ? { unavailable: 'err_unavailable', session: 'err_session', blocked: `err_${info.code}` }[info.kind] || 'err_unknown' : `errMedia_${MEDIA_CODES.includes(err.code) ? err.code : 'decode'}`;
    fail(P('featureFailed'), P(key));
    return false;
  }
}
