// Editor del perfil de Venus ("Mi perfil"): datos basicos, pronombres y descripcion; fade, tipografia, efecto,
// color y brillo del nombre; banner (color clasico, GIF de KLIPY o imagen propia quieta); servidores favoritos,
// estadisticas publicadas y capturas destacadas; y lo equipado de la tienda. Vista previa en vivo a la izquierda.
// Lo personalizado se guarda con profile_customize (0020_perfiles.sql); nombre, nombre de Minecraft, estado y el
// color clasico del banner con la tabla profiles (como siempre). Las imagenes se preparan en la PC (media.js).
//   import('../features/profile-editor.js').then((m) => m.openProfileEditor({ tab: 'style' }))
// Tambien: openShareProfile() (imagen PNG de la tarjeta) y featureCapture({ src, title }) para Capturas y clips.
import { h, icon, mount, modal, ok, fail, toast, ensureCss, switchEl, setBusy, skeleton, emptyState, copyText, confirmDialog, fmtDate, fmtBytes, fmtDuration, reducedMotion, LOADERS } from '../ui.js';
import { api, store } from '../store.js';
import { t, has, locale, getLanguage, loadNs } from '../i18n.js';
import { navigate } from '../app.js';
import { cloud } from '../cloud.js';
import { social } from '../social.js';
import { BANNERS, bannerBackground, bannerName, encodeBanner, parseBanner, isMcName, presenceLabel, MY_STATUSES, publicAddress } from '../social/cosmetics.js';
import { ensureProfileStyle, styledName, normalize, setStyleCache, titleLabel, premiumChip, applyFrame, bubbleAttrs, bannerEl } from '../social/profile-style.js';
import { profileCard, presenceDot, headImg, headWithDot, prepareSocialUi, fetchPublicProfile, forgetPublicProfile } from '../social/profile-ui.js';
import { openEmojiPicker } from '../social/richtext.js';
import * as M from './profile-editor/model.js';
import { FRAME_CATEGORIES, frameItem, filterFrames, frameImageUrl } from '../social/frames.js';
import { EXTRA_FONTS, FONT_GROUPS } from './profile-editor/fonts.js';
import { searchGifs, reportShare } from './profile-editor/klipy.js';
import { buildMusicPanel } from './profile-editor/music.js';
import { achievementName, achievementInfo } from '../pages/achievements/names.js';
import { rarityOf, RARITY_MIN_USERS } from '../pages/achievements/catalog.js';
import { MediaError, readImageFile, bannerFromImage, featuredFromImage, featuredFromSource, uploadMedia, removeMedia, makeRoom, loadImage } from './profile-editor/media.js';
import { drawShareCard, loadFonts } from './profile-editor/share.js';

const NS = 'profile';
const P = (k, vars) => t(`${NS}.${k}`, vars);
const TABS = [
  { id: 'identity', icon: 'user' },
  { id: 'style', icon: 'type' },
  { id: 'banner', icon: 'image' },
  { id: 'showcase', icon: 'star' },
  { id: 'music', icon: 'music', label: () => t('profilemusic.tab') }, // 4.6: la cancion se elige de Openverse (profile-editor/music.js)
  { id: 'items', icon: 'sparkles' },
];
const FIELD_TAB = { pronouns: 'identity', bio: 'identity', theme: 'style', nameStyle: 'style', banner: 'banner', cardStyle: 'style', links: 'showcase', showcase: 'showcase', favoriteServers: 'showcase', publicStats: 'showcase', featured: 'showcase', equipped: 'items' };
const SLOTS = [
  { slot: 'frame', kind: 'frame' },
  { slot: 'title', kind: 'title' },
  { slot: 'badgeStyle', kind: 'badge_style' },
  { slot: 'nameEffect', kind: 'name_effect' },
];
const MEDIA_CODES = ['type', 'animated', 'too_big', 'decode', 'limit', 'denied', 'unavailable', 'network', 'session'];
const PLACEHOLDER_HOST = 'https://pending.supabase.co/storage/v1/object/public/profile-media';

let current = null; // editor abierto (no se abren dos)
let premiumModule; // undefined: sin probar; null: todavia no existe

async function ensureUi() {
  ensureCss('features/profile-editor');
  ensureCss('features/frames');
  // rewards trae los nombres de los marcos (item_frame_*) y las categorias de la tienda
  await Promise.all([prepareSocialUi(), ensureProfileStyle(), loadNs('achievements').catch(() => null), loadNs('profilemusic').catch(() => null), loadNs('rewards').catch(() => null)]);
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
    const { data, error } = await cloud.client.from('shop_items').select('id,kind,price,premium_only,active,sort,data,source').order('sort');
    if (error) throw error;
    const rows = (data || []).filter((r) => ['frame', 'name_effect', 'badge_style', 'title'].includes(r.kind));
    M.registerItems(rows); // asi se dibujan tambien los marcos, titulos y efectos del Venus Pass (pass_*)
    const list = rows.map((r) => ({ id: r.id, kind: r.kind, price: r.price, premiumOnly: Boolean(r.premium_only), active: r.active !== false, source: r.source || 'shop', style: r.data?.style || r.data?.effect || r.data?.title || r.id.replace(/^[a-z]+_/, '') }));
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
      card_style: pub.song ? { ...(pub.cardStyle || {}), song: pub.song } : pub.cardStyle, // profile_public manda la canción aparte: se vuelve a meter para que el editor la conserve al guardar
      links: pub.links,
      showcase: pub.showcase,
      rank: pub.rank ?? base.rank,
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
    // Los mundos son opcionales: si no se pudieron leer, se publica lo del launcher
    const [report, ingame] = await Promise.all([api.invoke('stats:report'), api.invoke('stats:ingame', {}).catch(() => null)]);
    return M.publicStatsFromReport(report, ingame);
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

// Los marcos, titulos y efectos del Venus Pass se ganan jugando: llevan a la pagina del Pase
async function goPass(close) {
  close?.();
  navigate('pass');
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
    const buttons = options.filter((o) => !o.hide?.() || o.id === cur).map((o) => {
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
    refresh: draw,
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
  S.draft.custom.showcase = { achievements: [], clips: [], skin: false, skinPose: 'stand', skinBg: 'none', rareBadges: [], ...S.draft.custom.showcase };
  // 3.1: tema, burbuja, entrada en voz, cancion y libro de visitas (lo que queda en su valor por defecto no se manda)
  S.draft.custom.cardStyle = { theme: { id: 'none', particles: false }, bubble: { style: 'default', color: null }, entry: 'none', song: null, guestbook: false, ...S.draft.custom.cardStyle };
  // Estado con emoji y vencimiento (3.1): el texto guardado es "<emoji> <texto>"
  const st0 = M.splitStatus(S.saved.basics.status_text);
  S.status = { emoji: st0.emoji, text: st0.text, until: n.statusUntil && !M.statusExpired(n.statusUntil) ? n.statusUntil : null };
  S.status.choice = S.status.until ? 'keep' : 'never';
  const ctx = () => ({ userId: S.uid, premium: S.premium, owned: S.owned, items: S.items });
  const locked = !S.available;

  // ---------- Vista previa ----------
  const previewBox = h('div', { class: 'pfe-preview-card' });
  const listBox = h('div', { class: 'pfe-preview-list' });
  const bannerStrip = h('div', { class: 'pfe-banner-strip-box' }); // el banner solo, a su proporcion (pestaña Banner)
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
      rank: S.n.rank,
      card_style: c.cardStyle,
      song: c.cardStyle.song,
      status_until: S.status.choice === 'keep' ? S.status.until : M.statusUntil(S.status.choice),
      links: c.links.filter((l) => M.isProfileLink(l.kind, l.url)),
      // En la vista previa se muestran los clips que ya se conocen (no hace falta pedirlos de nuevo al servidor)
      showcase: {
        skin: c.showcase.skin === true,
        skinPose: c.showcase.skinPose,
        skinBg: c.showcase.skinBg,
        achievements: c.showcase.achievements.map((id) => ({ id })),
        rareBadges: c.showcase.rareBadges.map((id) => ({ id })),
        clips: c.showcase.clips.map((id) => (S.clips || []).find((x) => x.id === id) || S.n.showcase.clips.find((x) => x.id === id)).filter(Boolean),
      },
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
      mount(bannerStrip, bannerEl(M.normalizeProfile(raw, { allowLocalMedia: true }), { cls: 'pfe-banner-strip' }));
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
  const statusChanged = () => S.status.choice !== (S.status.until ? 'keep' : 'never');
  const isDirty = () => Object.keys(basicsDiff()).length > 0 || Object.keys(M.buildPatch(S.saved.custom, currentCustom())).length > 0 || prefsChanged() || statusChanged();
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
        h('span', {}, x.label ? x.label() : P(`tab_${x.id}`)),
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
    const changed = id !== activeTab;
    activeTab = id;
    for (const x of TABS) {
      const on = x.id === id;
      tabButtons[x.id].classList.toggle('active', on);
      tabButtons[x.id].setAttribute('aria-selected', String(on));
      tabButtons[x.id].tabIndex = on ? 0 : -1;
      if (panels[x.id]) panels[x.id].hidden = !on;
    }
    if (id === 'showcase') ensureShowcaseData();
    // Al cambiar de pestaña se vuelve arriba (el cuerpo del dialogo es lo que se desplaza)
    if (changed) body.closest('.modal-body')?.scrollTo?.({ top: 0 });
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
  // Estado: emoji (grilla fija de 60), texto y vencimiento (3.1)
  const statusTextInput = h('input', { class: 'input', value: S.status.text, maxlength: M.LIMITS.statusBody, placeholder: t('social.statusTextPlaceholder'), 'aria-label': t('social.statusText') });
  const emojiBtn = h('button', { class: 'btn ghost pfe-emoji-btn', type: 'button', title: P('statusEmojiPick'), 'aria-label': P('statusEmojiPick'), 'aria-haspopup': 'dialog' });
  const emojiClear = h('button', { class: 'icon-btn sm', type: 'button', title: P('statusEmojiNone'), 'aria-label': P('statusEmojiNone') }, icon('x'));
  const untilChoices = [...(S.status.until ? ['keep'] : []), ...M.STATUS_DURATIONS];
  const untilSelect = h(
    'select',
    { class: 'select pfe-until', 'aria-label': P('statusUntil') },
    untilChoices.map((c) => h('option', { value: c }, c === 'keep' ? P('statusExpiresAt', { date: fmtDate(Date.parse(S.status.until), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }) : P(`statusUntil_${c}`))),
  );
  untilSelect.value = S.status.choice;
  untilSelect.addEventListener('change', () => {
    S.status.choice = untilSelect.value;
    schedule();
  });
  function syncStatus() {
    mount(emojiBtn, S.status.emoji ? h('span', { class: 'pfe-emoji' }, S.status.emoji) : icon('smile'));
    emojiClear.hidden = !S.status.emoji;
    S.draft.basics.status_text = M.joinStatus(S.status.emoji, S.status.text) || '';
    schedule();
  }
  emojiBtn.addEventListener('click', () =>
    openEmojiPicker(emojiBtn, (e) => {
      S.status.emoji = M.isEmoji(e) ? e : null;
      syncStatus();
    }, { label: P('statusEmojiPick'), set: M.STATUS_EMOJIS }),
  );
  emojiClear.addEventListener('click', () => {
    S.status.emoji = null;
    syncStatus();
  });
  statusTextInput.addEventListener('input', () => {
    S.status.text = statusTextInput.value;
    syncStatus();
  });
  mount(emojiBtn, S.status.emoji ? h('span', { class: 'pfe-emoji' }, S.status.emoji) : icon('smile'));
  emojiClear.hidden = !S.status.emoji;
  const statusRow = h('div', { class: 'pfe-status-row' }, emojiBtn, emojiClear, statusTextInput, untilSelect);
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
      socialReady ? h('div', { class: 'full' }, fieldBox(t('social.statusText'), statusRow, { hint: P('statusUntilHint') })) : null,
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
          h('div', { class: 'pfe-code' }, h('span', { class: 'kbd selectable priv' }, code), h('button', { class: 'icon-btn sm', type: 'button', title: t('social.copyCode'), 'aria-label': t('social.copyCode'), onclick: () => copyText(code, t('social.codeCopied')) }, icon('copy'))),
        )
      : null,
  );

  // ===== Estilo =====
  const ns = () => S.draft.custom.nameStyle;
  const sample = (style) => styledName({ displayName: M.cleanText(S.draft.basics.display_name, 32) || S.n.username || 'Steve', nameStyle: style, theme: S.draft.custom.theme, hasStyle: true }, { size: 'md', animate: false });
  // Fade
  const fadeFrom = h('input', { type: 'color', class: 'pfe-color', value: S.fadeMemory.from });
  const fadeTo = h('input', { type: 'color', class: 'pfe-color', value: S.fadeMemory.to });
  const fadeVia = h('input', { type: 'color', class: 'pfe-color', value: S.fadeMemory.via || '#b06bff' });
  let viaOn = Boolean(S.fadeMemory.via);
  const viaSwitch = switchEl(viaOn, (v) => {
    viaOn = v;
    applyFade();
  }, P('fadeVia'));
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
    S.fadeMemory = { from: fadeFrom.value, ...(viaOn ? { via: fadeVia.value } : {}), to: fadeTo.value, angle: Number(angleInput.value) };
    if (fadeOn()) S.draft.custom.theme = { ...S.fadeMemory };
    syncFade();
    refreshSamples();
    schedule();
  };
  fadeFrom.addEventListener('input', applyFade);
  fadeTo.addEventListener('input', applyFade);
  fadeVia.addEventListener('input', applyFade);
  angleInput.addEventListener('input', applyFade);
  const fadePresets = h(
    'div',
    { class: 'pfe-fade-presets', role: 'group', 'aria-label': P('fadePresets') },
    M.FADE_PRESETS.map((f, i) =>
      h('button', {
        type: 'button',
        class: 'pfe-fade-swatch',
        style: { background: `linear-gradient(135deg, ${[f.from, f.via, f.to].filter(Boolean).join(', ')})` },
        title: P('fadePreset', { n: i + 1 }),
        'aria-label': P('fadePreset', { n: i + 1 }),
        onclick: () => {
          fadeFrom.value = f.from;
          fadeTo.value = f.to;
          viaOn = Boolean(f.via);
          viaSwitch.querySelector('input').checked = viaOn;
          if (f.via) fadeVia.value = f.via;
          if (!fadeOn()) {
            S.draft.custom.theme = { from: f.from, ...(f.via ? { via: f.via } : {}), to: f.to, angle: Number(angleInput.value) };
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
    fadeVia.disabled = !on || locked || !viaOn;
    viaSwitch.querySelector('input').disabled = !on || locked;
    angleOut.textContent = P('fadeAngleValue', { angle: angleInput.value });
    fadeControls.style.setProperty('--pfe-fade', `linear-gradient(${angleInput.value}deg, ${[fadeFrom.value, viaOn ? fadeVia.value : null, fadeTo.value].filter(Boolean).join(', ')})`);
  }
  mount(
    fadeControls,
    h('span', { class: 'pfe-fade-bar', 'aria-hidden': 'true' }),
    h('div', { class: 'pfe-fade-row' }, h('label', { class: 'pfe-color-field' }, fadeFrom, h('span', {}, P('fadeFrom'))), h('label', { class: 'pfe-color-field' }, fadeTo, h('span', {}, P('fadeTo')))),
    h('div', { class: 'pfe-fade-via' }, h('label', { class: 'pfe-color-field' }, fadeVia, h('span', {}, P('fadeVia'))), viaSwitch),
    h('label', { class: 'pfe-range-field' }, h('span', {}, P('fadeAngle')), angleInput, angleOut),
    fadePresets,
  );
  if (locked) fadeSwitch.querySelector('input').disabled = true;
  syncFade();

  // Tipografia
  let fontFilter = 'all';
  const fontOf = new Map(EXTRA_FONTS.map((f) => [f.id, f]));
  const fontFilterBox = h('div', { class: 'chips pfe-font-filter', role: 'group', 'aria-label': P('fontFilter') });
  const drawFontFilter = () =>
    mount(
      fontFilterBox,
      ['all', ...FONT_GROUPS].map((g) =>
        h('button', { type: 'button', class: ['chip', fontFilter === g && 'active'], 'aria-pressed': String(fontFilter === g), onclick: () => ((fontFilter = g), drawFontFilter(), fontGroup.refresh()) }, P(`fontGroup_${g}`)),
      ),
    );
  const fontGroup = radioGroup({
    label: P('font'),
    cls: 'pfe-fonts',
    options: M.FONTS.map((f) => {
      const extra = fontOf.get(f);
      const group = extra ? extra.group : 'basic';
      return { id: f, label: extra ? extra.label : P(`font_${f}`), hide: () => fontFilter !== 'all' && fontFilter !== group };
    }),
    value: ns().font,
    render: (o) => [h('span', { class: 'pfe-sample' }, sample({ ...ns(), font: o.id, effect: 'none' })), h('span', { class: 'pfe-radio-label' }, o.label)],
    onPick: (id) => {
      ns().font = id;
      refreshSamples();
      schedule();
    },
  });
  drawFontFilter();
  // Mayusculas, cursiva y contorno
  const styleToggle = (key) =>
    h(
      'div',
      { class: 'toggle-row' },
      h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, P(`nameOpt_${key}`))),
      switchEl(ns()[key] === true, (v) => {
        if (v) ns()[key] = true;
        else delete ns()[key];
        refreshSamples();
        schedule();
      }, P(`nameOpt_${key}`)),
    );
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
  // Tarjeta: dibujo de fondo, forma de la cabeza, disposicion y acento
  const card = () => S.draft.custom.cardStyle;
  const cardRadio = (key, options, cls, render) =>
    radioGroup({
      label: P(`card_${key}`),
      cls,
      options: options.map((id) => ({ id, label: P(`card_${key}_${id}`) })),
      value: card()[key] || options[0],
      render,
      onPick: (id) => {
        card()[key] = id;
        schedule();
      },
    });
  const patternGroup = cardRadio('pattern', M.CARD_PATTERNS, 'pfe-patterns', (o) => [h('span', { class: ['pfe-pattern-art', `pf-pattern-${o.id}`], 'aria-hidden': 'true' }, h('span', { class: 'pf-card-body' })), h('span', { class: 'pfe-radio-label' }, o.label)]);
  const layoutGroup = cardRadio('layout', M.CARD_LAYOUTS, 'pfe-avatars');
  const accentInput = h('input', { type: 'color', class: 'pfe-color', value: card().accent || '#f29a2e', 'aria-label': P('card_accent'), disabled: locked });
  const accentClear = h('button', { class: 'btn ghost sm', type: 'button', disabled: locked, onclick: () => (delete card().accent, schedule()) }, icon('x'), P('card_accentClear'));
  accentInput.addEventListener('input', () => {
    card().accent = accentInput.value.toLowerCase();
    schedule();
  });
  // ----- 3.1: tema completo de la tarjeta -----
  const themeGroup = radioGroup({
    label: P('cardTheme'),
    cls: 'pfe-patterns',
    options: M.CARD_THEMES.map((id) => ({ id, label: P(`cardTheme_${id}`) })),
    value: card().theme.id,
    render: (o) => [h('span', { class: ['pfe-theme-art', o.id !== 'none' && 'pf-card', o.id !== 'none' && 'pf-themed', o.id !== 'none' && `pf-theme-${o.id}`], 'aria-hidden': 'true' }, h('span', { class: 'pf-card-body' })), h('span', { class: 'pfe-radio-label' }, o.label)],
    onPick: (id) => {
      card().theme.id = id;
      schedule();
    },
  });
  const particlesOk = M.canUseParticles(ctx());
  const particlesSwitch = switchEl(card().theme.particles === true && particlesOk, (v) => {
    card().theme.particles = v;
    schedule();
  }, P('themeParticles'));
  if (!particlesOk || locked) particlesSwitch.querySelector('input').disabled = true;
  const particlesRow = h(
    'div',
    { class: 'toggle-row' },
    h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, particlesOk ? null : icon('crown'), P('themeParticles')), h('div', { class: 'tr-sub' }, particlesOk ? P('themeParticlesHint') : P('themeParticlesLocked'))),
    particlesOk ? particlesSwitch : h('button', { class: 'btn tonal sm', type: 'button', onclick: goPlans }, icon('crown'), P('seePlans')),
  );
  // ----- 3.1: burbujas de chat -----
  const bub = () => card().bubble;
  const bubbleSample = h('div', { class: 'pfe-bubble-sample', 'aria-label': P('bubbleSample') });
  function drawBubbleSample() {
    const look = bubbleAttrs({ id: S.uid, cardStyle: card(), hasStyle: true });
    mount(bubbleSample, h('div', { class: 'msg-row mine first last' }, h('div', { class: 'msg-col' }, h('div', { class: ['msg-bubble', ...look.classes], style: look.vars }, P('bubbleSampleText')))));
  }
  const bubbleGroup = radioGroup({
    label: P('bubble'),
    cls: 'pfe-avatars',
    options: M.BUBBLE_STYLES.map((id) => ({ id, label: P(`bubble_${id}`) })),
    value: bub().style,
    onPick: (id) => {
      bub().style = id;
      drawBubbleSample();
      schedule();
    },
  });
  const bubbleColor = h('input', { type: 'color', class: 'pfe-color', value: bub().color || '#f29a2e', 'aria-label': P('bubbleColor'), disabled: locked });
  const bubbleClear = h('button', { class: 'btn ghost sm', type: 'button', disabled: locked, onclick: () => ((bub().color = null), drawBubbleSample(), schedule()) }, icon('x'), P('bubbleColorAuto'));
  bubbleColor.addEventListener('input', () => {
    bub().color = bubbleColor.value.toLowerCase();
    drawBubbleSample();
    schedule();
  });
  drawBubbleSample();
  // ----- 3.1: efecto de entrada en salas de voz -----
  const entryGroup = radioGroup({
    label: P('entry'),
    cls: 'pfe-avatars',
    options: M.ENTRY_EFFECTS.map((id) => ({ id, label: P(`entry_${id}`) })),
    value: card().entry,
    render: (o) => [h('span', { class: ['pfe-entry-art', `is-${o.id}`], 'aria-hidden': 'true' }), h('span', { class: 'pfe-radio-label' }, o.label)],
    onPick: (id) => {
      card().entry = id;
      schedule();
    },
  });
  // Secciones de la pestaña Estilo (4.6): Tarjeta, Nombre y Chat y voz, con un atajo para ir de una a otra
  const SECTIONS = ['card', 'name', 'chat'];
  const section = (id, ...groups) =>
    h('section', { class: 'pfe-section', id: `pfe-sec-${id}`, 'aria-labelledby': `pfe-sec-${id}-t` }, h('div', { class: 'pfe-section-head' }, h('h3', { class: 'pfe-section-title', id: `pfe-sec-${id}-t` }, P(`sec_${id}`)), h('p', { class: 'pfe-section-sub' }, P(`sec_${id}Hint`))), ...groups);
  const sectionNav = h(
    'nav',
    { class: 'chips pfe-secnav', 'aria-label': P('sec_nav') },
    SECTIONS.map((id) => h('button', { type: 'button', class: 'chip', onclick: () => document.getElementById(`pfe-sec-${id}`)?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }) }, P(`sec_${id}`))),
  );
  panel(
    'style',
    locked ? unavailableNote() : null,
    sectionNav,
    section(
      'card',
      h('div', { class: 'pfe-group' }, h('div', { class: 'pfe-group-row' }, groupTitle(P('fade'), P('fadeHint')), fadeSwitch), fadeControls),
      h('div', { class: 'pfe-group' }, groupTitle(P('card_pattern'), P('card_patternHint')), patternGroup.el),
      h('div', { class: 'pfe-group' }, groupTitle(P('cardTheme'), P('cardThemeHint')), themeGroup.el, h('div', { class: 'pfe-toggles' }, particlesRow)),
      h('div', { class: 'pfe-group' }, groupTitle(P('card_layout')), layoutGroup.el),
      h('div', { class: 'pfe-group' }, groupTitle(P('card_accent'), P('card_accentHint')), h('div', { class: 'row' }, accentInput, accentClear)),
    ),
    section(
      'name',
      h('div', { class: 'pfe-group' }, groupTitle(P('font'), P('fontHint', { n: M.FONTS.length })), fontFilterBox, fontGroup.el, h('div', { class: 'pfe-toggles' }, styleToggle('caps'), styleToggle('italic'), styleToggle('outline'))),
      h('div', { class: 'pfe-group' }, groupTitle(P('effect'), P('effectHint')), effectGroup.el),
      h(
        'div',
        { class: 'pfe-group pfe-two' },
        h('div', {}, groupTitle(P('nameColor')), colorGroup, colorNote),
        h('div', {}, groupTitle(P('glow'), P('glowHint')), h('label', { class: 'pfe-range-field compact' }, h('span', { class: 'sr-only' }, P('glow')), glowInput, glowOut)),
      ),
    ),
    section(
      'chat',
      h('div', { class: 'pfe-group' }, groupTitle(P('bubble'), P('bubbleHint')), bubbleGroup.el, h('div', { class: 'row wrap' }, bubbleColor, bubbleClear), bubbleSample),
      h('div', { class: 'pfe-group' }, groupTitle(P('entry'), P('entryHint')), entryGroup.el),
    ),
  );
  if (locked) for (const g of [fontGroup.el, effectGroup.el, patternGroup.el, layoutGroup.el, themeGroup.el, bubbleGroup.el, entryGroup.el]) g.querySelectorAll('button').forEach((b) => (b.disabled = true));

  // ===== Musica (4.6): la cancion se elige de Openverse, ya no se sube (profile-editor/music.js) =====
  panel(
    'music',
    locked ? unavailableNote() : null,
    buildMusicPanel({
      getSong: () => card().song,
      setSong: (song) => {
        card().song = song;
        schedule();
      },
      locked,
    }),
  );

  // ===== Banner =====
  // 4.6: sin diseños prediseñados ni GIF propios. El banner es el color clasico (el de siempre), un GIF de KLIPY o una imagen
  // propia quieta (PNG, JPG o WebP: GIF, APNG y WebP animado se rechazan mirando el contenido del archivo, ver media.js).
  const banner = () => S.draft.custom.banner;
  const bannerKindOf = () => (banner().kind === 'image' ? 'image' : banner().kind === 'klipy' ? 'klipy' : 'color');
  let bannerTab = bannerKindOf();
  const bannerArea = h('div', { class: 'pfe-banner-area' });
  const bannerSeg = h('div', { class: 'segmented pfe-banner-seg', role: 'group', 'aria-label': P('bannerKind') });
  function drawBannerSeg() {
    mount(
      bannerSeg,
      ['color', 'klipy', 'image'].map((k) =>
        h('button', { type: 'button', class: bannerTab === k ? 'active' : '', 'aria-pressed': String(bannerTab === k), onclick: () => ((bannerTab = k), drawBannerSeg(), drawBannerArea()) }, P(`bannerKind_${k}`)),
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
      const src = await readImageFile(file, { still: true });
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
  function drawBannerArea() {
    const b = banner();
    if (bannerTab === 'image') {
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
          // Con una imagen elegida, la tira de arriba ("Así se ve tu banner") ya la muestra; sin imagen, el recuadro vacio
          has ? null : h('div', { class: 'pfe-upload-empty' }, icon('image'), h('span', {}, P('bannerImageHint'))),
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
          h('div', { class: 'pfe-still-note' }, icon('info'), h('span', {}, P('bannerStill'))),
        ),
      );
    } else if (bannerTab === 'klipy') {
      drawKlipyArea();
    } else {
      // Color clasico (columna banner de siempre): se ve cuando no hay imagen ni GIF
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
  // GIF de KLIPY: buscador con sus resultados en el orden en que llegan. "Search KLIPY" es obligatorio en sus condiciones.
  const klipy = { query: '', page: 1, items: [], hasNext: false, loading: false, error: null, req: 0, started: false };
  const klipySearch = h('input', { class: 'input', type: 'search', placeholder: 'Search KLIPY', maxlength: 100, spellcheck: 'false', 'aria-label': 'Search KLIPY', disabled: locked });
  const klipyGrid = h('div', { class: 'pfe-klipy-grid', role: 'listbox', 'aria-label': P('bannerKind_klipy') });
  const klipyFoot = h('div', { class: 'pfe-klipy-foot' });
  let klipyTimer = null;
  klipySearch.addEventListener('input', () => {
    clearTimeout(klipyTimer);
    klipyTimer = setTimeout(() => loadKlipy(klipySearch.value, 1), 350);
  });
  async function loadKlipy(query, page) {
    const req = ++klipy.req;
    klipy.query = query;
    klipy.page = page;
    klipy.loading = true;
    klipy.error = null;
    drawKlipy();
    try {
      const res = S.demo ? S.demo.demoKlipy() : await searchGifs(query, { page, lang: getLanguage() });
      if (req !== klipy.req) return;
      klipy.items = page > 1 ? [...klipy.items, ...res.items] : res.items;
      klipy.hasNext = res.hasNext;
    } catch (err) {
      if (req !== klipy.req) return;
      if (err?.code !== 'no_key') console.warn('[klipy]', err?.code || '', err?.message || err);
      klipy.error = err?.code || 'server';
    } finally {
      if (req === klipy.req) {
        klipy.loading = false;
        drawKlipy();
      }
    }
  }
  function drawKlipy() {
    const cur = banner().kind === 'klipy' ? banner().url : null;
    mount(
      klipyGrid,
      klipy.items.map((g) =>
        h(
          'button',
          {
            type: 'button',
            role: 'option',
            class: ['pfe-klipy-item', cur === g.url && 'active'],
            'aria-selected': String(cur === g.url),
            title: g.title || null,
            'aria-label': g.title || P('bannerKind_klipy'),
            disabled: locked,
            onclick: () => {
              setBanner({ kind: 'klipy', url: g.url, ...(g.still ? { still: g.still } : {}), ...(g.slug ? { slug: g.slug } : {}) });
              S.pending.banner = null;
              drawKlipy();
            },
          },
          h('img', { src: g.thumb, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }),
        ),
      ),
    );
    const moreBtn = klipy.hasNext && !klipy.loading ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => loadKlipy(klipy.query, klipy.page + 1) }, icon('chevronDown'), P('klipyMore')) : null;
    let status = null;
    if (klipy.loading) status = skeleton('line', { width: 180, label: P('klipyLoading') });
    else if (klipy.error) status = h('div', { class: 'notice warn' }, icon('alert'), h('div', {}, P(klipy.error === 'no_key' ? 'klipyNoKey' : klipy.error === 'network' ? 'klipyNetwork' : 'klipyError')));
    else if (!klipy.items.length) status = h('div', { class: 'pfe-empty-line' }, P('klipyEmpty'));
    mount(klipyFoot, status, moreBtn, h('div', { class: 'pfe-klipy-mark' }, 'Powered by KLIPY'));
  }
  function drawKlipyArea() {
    const b = banner();
    mount(
      bannerArea,
      h(
        'div',
        { class: 'pfe-klipy' },
        klipySearch,
        h('div', { class: 'field-help' }, P('klipyHint')),
        b.kind === 'klipy' ? h('button', { class: 'btn ghost sm', type: 'button', disabled: locked, onclick: () => (setBanner({ kind: 'none' }), (bannerTab = 'color'), drawBannerSeg(), drawBannerArea()) }, icon('trash'), P('bannerRemove')) : null,
        klipyGrid,
        klipyFoot,
      ),
    );
    if (!klipy.started) {
      klipy.started = true;
      loadKlipy('', 1);
    } else drawKlipy();
  }
  drawBannerSeg();
  drawBannerArea();
  panel(
    'banner',
    locked ? unavailableNote() : null,
    h('div', { class: 'pfe-group' }, groupTitle(P('bannerPreview')), bannerStrip),
    h('div', { class: 'pfe-group' }, groupTitle(P('bannerKind')), bannerSeg, bannerArea),
  );

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
        ...M.EXTRA_STATS.filter((k) => s[k] > 0).map((k) => [P(`stat_${k}`), nf(s[k], k === 'longestHours' || k === 'distanceKm' ? 1 : 0)]),
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
    loadShowcaseExtras().catch((err) => {
      console.warn('[profile] vitrina:', err?.message || err);
      S.unlocked ||= [];
      S.clips ||= [];
      drawAch();
      drawClips();
      drawRare();
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

  // Redes (solo sitios conocidos)
  const links = () => S.draft.custom.links;
  const linkBox = h('div', { class: 'pfe-links' });
  const linkKinds = Object.keys(M.LINK_KINDS);
  const linkKind = h('select', { class: 'select', disabled: locked, 'aria-label': P('linkKind') }, linkKinds.map((k) => h('option', { value: k }, P(`link_${k}`))));
  const linkUrl = h('input', { class: 'input', type: 'url', placeholder: 'https://', maxlength: M.LIMITS.linkUrl, spellcheck: 'false', disabled: locked, 'aria-label': P('linkUrl') });
  const linkErr = errorLine();
  const linkAdd = h('button', { class: 'btn', type: 'button', disabled: locked }, icon('plus'), P('linkAdd'));
  linkAdd.addEventListener('click', () => {
    const url = linkUrl.value.trim();
    if (links().length >= M.LIMITS.links) return linkErr.set(P('linksFull', { max: M.LIMITS.links }), linkUrl);
    if (!M.isProfileLink(linkKind.value, url)) return linkErr.set(P('linkInvalid', { site: P(`link_${linkKind.value}`) }), linkUrl);
    links().push({ kind: linkKind.value, url });
    linkUrl.value = '';
    linkErr.set('', linkUrl);
    drawLinks();
    schedule();
  });
  function drawLinks() {
    mount(
      linkBox,
      links().length
        ? links().map((l, i) =>
            h(
              'div',
              { class: 'pfe-server' },
              h('span', { class: 'pf-server-icon' }, icon('link')),
              h('div', { class: 'pfe-server-main' }, h('span', { class: 'pfe-server-name ellipsis' }, P(`link_${l.kind}`)), h('span', { class: 'pfe-server-addr ellipsis', title: l.url }, l.url)),
              h('button', { class: 'icon-btn sm danger', type: 'button', disabled: locked, title: P('linkRemove'), 'aria-label': P('linkRemove'), onclick: () => (links().splice(i, 1), drawLinks(), schedule()) }, icon('trash')),
            ),
          )
        : h('div', { class: 'pfe-empty-line' }, P('linksEmpty')),
    );
  }
  drawLinks();

  // Logros destacados (solo los desbloqueados)
  const showcase = () => S.draft.custom.showcase;
  const achBox = h('div', { class: 'pfe-ach-pick', role: 'group', 'aria-label': P('pinnedAch') });
  const achSearch = h('input', { class: 'input', type: 'search', placeholder: P('pinnedAchSearch'), spellcheck: 'false', disabled: locked });
  const achCount = h('span', { class: 'pfe-range-value num' });
  S.unlocked = null;
  achSearch.addEventListener('input', () => drawAch());
  function drawAch() {
    const pinned = showcase().achievements;
    achCount.textContent = `${pinned.length} / ${M.LIMITS.pinnedAchievements}`;
    if (!S.unlocked) return mount(achBox, skeleton('line', { width: 200, label: P('statsLoading') }));
    if (!S.unlocked.length) return mount(achBox, h('div', { class: 'pfe-empty-line' }, P('pinnedAchEmpty')));
    const q = achSearch.value.trim().toLowerCase();
    const list = S.unlocked.filter((id) => !q || achievementName(id).toLowerCase().includes(q));
    mount(
      achBox,
      list.slice(0, 120).map((id) => {
        const on = pinned.includes(id);
        const info = achievementInfo(id);
        return h(
          'button',
          {
            type: 'button',
            class: ['pf-ach', 'pfe-ach-item', on && 'active'],
            dataset: { tier: info.tier },
            'aria-pressed': String(on),
            disabled: locked || (!on && pinned.length >= M.LIMITS.pinnedAchievements),
            onclick: () => {
              if (on) pinned.splice(pinned.indexOf(id), 1);
              else pinned.push(id);
              drawAch();
              schedule();
            },
          },
          h('span', { class: 'pf-ach-icon' }, icon(info.icon)),
          h('span', { class: 'pf-ach-main' }, h('span', { class: 'pf-ach-name' }, info.name), h('span', { class: 'pf-ach-tier' }, info.tierLabel)),
          on ? icon('check') : null,
        );
      }),
    );
  }

  // Clips destacados: los que ya se compartieron desde Clips y capturas
  const clipBox = h('div', { class: 'pfe-links' });
  S.clips = null;
  function drawClips() {
    const pinned = showcase().clips;
    if (!S.clips) return mount(clipBox, skeleton('line', { width: 200, label: P('statsLoading') }));
    if (!S.clips.length) return mount(clipBox, h('div', { class: 'pfe-empty-line' }, P('pinnedClipsEmpty')));
    mount(
      clipBox,
      S.clips.map((c) => {
        const on = pinned.includes(c.id);
        return h(
          'div',
          { class: 'toggle-row' },
          h('div', { class: 'tr-text' }, h('div', { class: 'tr-title ellipsis' }, c.title), h('div', { class: 'tr-sub' }, c.expiresAt ? P('pinnedClipExpires', { date: fmtDate(new Date(c.expiresAt).getTime()) }) : P('pinnedClipForever'))),
          switchEl(on, (v) => {
            if (v && pinned.length >= M.LIMITS.pinnedClips) return drawClips();
            if (v) pinned.push(c.id);
            else pinned.splice(pinned.indexOf(c.id), 1);
            drawClips();
            schedule();
          }, c.title),
        );
      }),
    );
  }
  const skinSwitch = switchEl(showcase().skin === true, (v) => {
    showcase().skin = v;
    schedule();
  }, P('showcaseSkin'));
  if (locked) skinSwitch.querySelector('input').disabled = true;
  // 3.1: pose y fondo de la skin
  const poseGroup = radioGroup({
    label: P('skinPose'),
    cls: 'pfe-avatars',
    options: M.SKIN_POSES.map((id) => ({ id, label: P(`skinPose_${id}`) })),
    value: showcase().skinPose,
    onPick: (id) => {
      showcase().skinPose = id;
      schedule();
    },
  });
  const bgGroup = radioGroup({
    label: P('skinBg'),
    cls: 'pfe-avatars',
    options: M.SKIN_BGS.map((id) => ({ id, label: P(`skinBg_${id}`) })),
    value: showcase().skinBg,
    render: (o) => [h('span', { class: ['pfe-skinbg-art', o.id !== 'none' && `pf-skinbg-${o.id}`], 'aria-hidden': 'true' }), h('span', { class: 'pfe-radio-label' }, o.label)],
    onPick: (id) => {
      showcase().skinBg = id;
      schedule();
    },
  });
  // 3.1: insignias por logros raros (menos del 5 % de los jugadores, segun achievements_me)
  const rareBox = h('div', { class: 'pfe-ach-pick', role: 'group', 'aria-label': P('rareBadges') });
  const rareCount = h('span', { class: 'pfe-range-value num' });
  S.rarity = null;
  S.totalUsers = 0;
  function drawRare() {
    const pinned = showcase().rareBadges;
    rareCount.textContent = `${pinned.length} / ${M.LIMITS.rareBadges}`;
    if (!S.unlocked) return mount(rareBox, skeleton('line', { width: 200, label: P('statsLoading') }));
    if (!S.rarity || S.totalUsers < RARITY_MIN_USERS) return mount(rareBox, h('div', { class: 'pfe-empty-line' }, icon('info'), P('rareBadgesNoData')));
    const rare = S.unlocked.filter((id) => ['epic', 'legendary'].includes(rarityOf(Number(S.rarity[id]), S.totalUsers)) || pinned.includes(id));
    if (!rare.length) return mount(rareBox, h('div', { class: 'pfe-empty-line' }, P('rareBadgesEmpty')));
    mount(
      rareBox,
      rare.map((id) => {
        const on = pinned.includes(id);
        const info = achievementInfo(id);
        const pct = Number(S.rarity[id]) || 0;
        return h(
          'button',
          {
            type: 'button',
            class: ['pf-ach', 'pfe-ach-item', on && 'active'],
            dataset: { tier: info.tier },
            'aria-pressed': String(on),
            title: P('rareBadgeTitle', { name: info.name, pct }),
            disabled: locked || (!on && pinned.length >= M.LIMITS.rareBadges),
            onclick: () => {
              if (on) pinned.splice(pinned.indexOf(id), 1);
              else pinned.push(id);
              drawRare();
              schedule();
            },
          },
          h('span', { class: 'pf-ach-icon' }, icon(info.icon)),
          h('span', { class: 'pf-ach-main' }, h('span', { class: 'pf-ach-name' }, info.name), h('span', { class: 'pf-ach-tier' }, `${pct} %`)),
          on ? icon('check') : null,
        );
      }),
    );
  }
  // 3.1: libro de visitas
  const gbSwitch = switchEl(card().guestbook === true, (v) => {
    card().guestbook = v;
    schedule();
  }, P('guestbook'));
  if (locked) gbSwitch.querySelector('input').disabled = true;
  async function loadShowcaseExtras() {
    if (S.demo) {
      S.unlocked = S.demo.demoUnlocked();
      S.clips = S.demo.demoClips();
      S.rarity = S.demo.demoRarity?.() || null;
      S.totalUsers = S.rarity ? 100 : 0;
    } else {
      const [ach, clips] = await Promise.all([
        cloud.client.rpc('achievements_me').then((r) => r.data).catch(() => null),
        cloud.client.from('shared_media').select('id,url,world,instance_name,file_name,expires_at').eq('owner', S.uid).eq('kind', 'clip').order('created_at', { ascending: false }).limit(30).then((r) => r.data).catch(() => null),
      ]);
      S.unlocked = Object.keys(ach?.unlocked || {});
      S.rarity = ach?.rarity && typeof ach.rarity === 'object' ? ach.rarity : null;
      S.totalUsers = Number(ach?.totalUsers) || 0;
      S.clips = (clips || [])
        .filter((c) => c.url && (!c.expires_at || new Date(c.expires_at).getTime() > Date.now()))
        .map((c) => ({ id: c.id, url: c.url, title: c.world || c.instance_name || c.file_name, expiresAt: c.expires_at }));
    }
    drawAch();
    drawClips();
    drawRare();
    schedule();
  }
  drawAch();
  drawClips();
  drawRare();
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
    h('div', { class: 'pfe-group' }, h('div', { class: 'pfe-group-row' }, groupTitle(P('pinnedAch'), P('pinnedAchHint')), achCount), achSearch, achBox),
    h('div', { class: 'pfe-group' }, groupTitle(P('pinnedClips'), P('pinnedClipsHint', { max: M.LIMITS.pinnedClips })), clipBox),
    h('div', { class: 'pfe-group' }, h('div', { class: 'pfe-group-row' }, groupTitle(P('showcaseSkin'), P('showcaseSkinHint')), skinSwitch), h('div', { class: 'pfe-two' }, h('div', {}, groupTitle(P('skinPose')), poseGroup.el), h('div', {}, groupTitle(P('skinBg')), bgGroup.el))),
    h('div', { class: 'pfe-group' }, h('div', { class: 'pfe-group-row' }, groupTitle(P('rareBadges'), P('rareBadgesHint')), rareCount), rareBox),
    h('div', { class: 'pfe-group' }, h('div', { class: 'pfe-group-row' }, groupTitle(P('guestbook'), P('guestbookHint')), gbSwitch)),
    h('div', { class: 'pfe-group' }, groupTitle(P('featured'), P('featuredHint')), featuredBox),
    h('div', { class: 'pfe-group' }, groupTitle(P('links'), P('linksHint', { max: M.LIMITS.links })), linkBox, h('div', { class: 'pfe-server-add' }, fieldBox(P('linkKind'), linkKind), fieldBox(P('linkUrl'), linkUrl, { error: linkErr }), linkAdd)),
  );

  // ===== Cosmeticos =====
  const itemsBox = h('div', { class: 'pfe-items' });
  const eq = () => S.draft.custom.equipped;
  const itemName = (it) => {
    if (it.kind === 'frame') return has(`rewards.item_${it.id}`) ? t(`rewards.item_${it.id}`) : it.id;
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
  // Selector de marcos: categorias y buscador (la barra se arma una sola vez: no pierde el foco al escribir)
  const frameUi = { cat: 'all', q: '', group: null };
  const frameSearch = h('input', { class: 'input', type: 'search', placeholder: t('rewards.frames_search'), 'aria-label': t('rewards.frames_search'), spellcheck: 'false', maxlength: 40 });
  const frameChips = h('div', { class: 'chips pfe-frame-chips', role: 'group', 'aria-label': t('rewards.frames_filter') });
  const frameBar = h('div', { class: 'pfe-frame-bar' }, frameSearch, frameChips);
  const frameCats = ['all', 'mine', ...FRAME_CATEGORIES, 'pass'];
  function drawFrameChips() {
    mount(
      frameChips,
      frameCats.map((c) => h('button', { type: 'button', class: ['chip', frameUi.cat === c && 'active'], 'aria-pressed': String(frameUi.cat === c), onclick: () => ((frameUi.cat = c), drawFrameChips(), frameUi.group?.refresh()) }, t(`rewards.frames_cat_${c}`))),
    );
  }
  frameSearch.addEventListener('input', () => {
    frameUi.q = frameSearch.value;
    frameUi.group?.refresh();
  });
  drawFrameChips();
  const frameShown = (it) => {
    const fr = frameItem(it.id);
    if (frameUi.cat === 'pass' && it.source !== 'pass') return false;
    if (!['all', 'mine', 'pass'].includes(frameUi.cat) && fr?.category !== frameUi.cat) return false;
    if (frameUi.cat === 'mine' && !M.canEquip('frame', it.id, ctx())) return false;
    return Boolean(filterFrames([it], { query: frameUi.q, nameOf: () => itemName(it) }).length);
  };
  function drawItems() {
    const groups = SLOTS.map(({ slot, kind }) => {
      const list = S.items.filter((i) => i.kind === kind && i.active !== false);
      const options = [{ id: '', label: P('itemNone') }];
      for (const it of list) {
        const usable = M.canEquip(slot, it.id, ctx());
        const premiumLock = !usable && it.premiumOnly;
        const passLock = !usable && it.source === 'pass';
        options.push({
          id: it.id,
          label: itemName(it),
          item: it,
          locked: !usable || locked,
          lockIcon: premiumLock ? 'crown' : passLock ? 'trophy' : 'lock',
          lockText: usable ? null : premiumLock ? P('lockedPremium') : passLock ? t('rewards.lockedPass') : P('lockedShop', { price: it.price }),
          aria: usable ? itemName(it) : premiumLock ? P('lockedPremiumTitle', { name: itemName(it) }) : passLock ? t('rewards.lockedPassTitle', { name: itemName(it) }) : P('lockedShopTitle', { name: itemName(it), price: it.price }),
          hide: kind === 'frame' ? () => !frameShown(it) : undefined,
        });
      }
      const group = radioGroup({
        label: P(`slot_${slot}`),
        cls: 'pfe-item-grid',
        options,
        value: eq()[slot] || '',
        render: (o) => [
          h('span', { class: 'pfe-item-art' }, o.item ? itemPreview(o.item) : icon('x')),
          h('span', { class: 'pfe-radio-label' }, o.label),
          kind === 'frame' && o.item && frameItem(o.item.id) ? h('span', { class: ['fr-rar', `r-${frameItem(o.item.id).rarity}`], title: t(`rewards.rarity_${frameItem(o.item.id).rarity}`) }) : null,
        ],
        onLocked: (o) => (locked ? null : o.item?.premiumOnly ? goPlans() : o.item?.source === 'pass' ? goPass(() => dialog.close()) : goShop(() => dialog.close())),
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
      if (kind === 'frame') frameUi.group = group;
      return h('div', { class: 'pfe-group' }, groupTitle(P(`slot_${slot}`), slot === 'badgeStyle' ? P('badgeStyleHint') : null), kind === 'frame' ? frameBar : null, group.el);
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
    if (c.banner?.kind === 'image' && S.pending.banner?.url === c.banner.url) c.banner.url = `${PLACEHOLDER_HOST}/${S.uid}/banner-pending.webp`;
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
    if (['bad_emoji', 'bad_status', 'bad_until'].includes(code)) selectTab('identity');
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
        // Estado con emoji y vencimiento (3.1): la RPC valida el emoji y guarda hasta cuando vale; el texto va ademas
        // por la tabla, como siempre, para que la lista de amigos lo tome al instante
        if (S.available && ('status_text' in basics || statusChanged())) {
          const until = S.status.choice === 'keep' ? S.status.until : M.statusUntil(S.status.choice);
          const { error } = await cloud.client.rpc('profile_set_status', { p_emoji: S.status.emoji, p_text: S.status.text.trim() || null, p_until: until });
          if (error && !/PGRST202|42883/.test(String(error.code || ''))) throw error;
          if (!error) S.status.until = until;
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
        if (custom.banner?.kind === 'klipy' && custom.banner.url !== S.saved.custom.banner?.url) reportShare(custom.banner.slug);
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
  // Del GIF de KLIPY se dibuja el cuadro fijo
  const bannerUrl = n.banner.kind === 'image' ? n.banner.url : n.banner.kind === 'klipy' ? n.banner.still || null : null;
  const frameUrl = M.frameOf(n) ? frameImageUrl(M.frameOf(n)) : '';
  const [headImgEl, bannerImg, logo, frame] = await Promise.all([
    safe(loadImage(avatarUrl(head, 128), { cors: true })),
    bannerUrl ? safe(loadImage(bannerUrl, { cors: !/^(blob:|data:)/.test(bannerUrl) })) : null,
    safe(loadImage('assets/logo-256.png')),
    frameUrl ? safe(loadImage(frameUrl)) : null,
    loadFonts(n.nameStyle?.font),
  ]);
  return { head: headImgEl, banner: bannerImg, logo, frame };
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
