// Apariencia y marca: "tu logo, tus colores, tu música o tu fondo".
// Color de acento (presets planetarios o propio) aplicado a toda la interfaz, fondo de estrellas o
// imagen/video propio con oscurecer y desenfoque, logo y nombre del launcher (barra lateral y de titulo),
// música de fondo en bucle y la direccion de "Tu servidor" que muestra Inicio.
// Ajustes en settings.appearance y settings.branding. Contrato: startup(), appearancePanel() -> Element.
import { h, icon, mount, ensureCss, switchEl, modal, confirmDialog, fail, toast, skeleton, setBusy, fmtNumber } from './ui.js';
import { store, api } from './store.js';
import { t, loadNs, has, onLanguageChange } from './i18n.js';
import * as engine from './a11y/engine.js';
import { parseColor, toHsl } from './a11y/color.js';
import { registerCommands } from './a11y/palette.js';
import { topDialog } from './a11y/aria.js';
import { dispatchEscape } from './a11y/gamepad.js';
import { navigate } from './app.js';
import { WALLPAPERS, getWallpaper } from './wallpapers.js';

export const PRESETS = [
  { id: 'venus', color: '#f29a2e' },
  { id: 'mars', color: '#f0603c' },
  { id: 'neptune', color: '#3fa2ff' },
  { id: 'jupiter', color: '#f2c14e' },
  { id: 'earth', color: '#58c27d' },
  { id: 'saturn', color: '#a879f2' },
];

export const APPEARANCE_DEFAULTS = {
  accent: 'venus', // id de PRESETS o 'custom'
  customColor: '#f29a2e',
  tint: true, // teñir fondos y textos con el tono del acento
  background: 'stars', // 'stars' | 'wallpaper' | 'image'
  wallpaperId: WALLPAPERS[0]?.id || '',
  bgFile: '',
  bgDim: 45, // 0-90 %
  bgBlur: 0, // 0-24 px
  music: { enabled: false, file: '', volume: 35, pauseInGame: true },
};

export const BRANDING_DEFAULTS = {
  name: '', // vacio = Venus Launcher
  subtitle: 'LAUNCHER',
  logo: '', // imagen en data: (PNG reducido) para que no dependa del archivo original
  logoName: '',
  logoPixel: false,
  server: '', // "Tu servidor" (host[:puerto]), lo usa Inicio
};

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'];
const VIDEO_EXT = ['mp4', 'webm', 'm4v', 'ogv'];
const AUDIO_EXT = ['mp3', 'ogg', 'oga', 'opus', 'wav', 'flac', 'm4a', 'aac', 'weba'];
const LOGO_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico', 'avif'];
const NAME_MAX = 24;

let started = false;
let ap = normalizeAppearance();
let br = normalizeBranding();
let pending = { appearance: {}, branding: {} };
let inFlight = { appearance: {}, branding: {} };
let activeSave = null;
let saveTimer = 0;
const listeners = new Set();
let ORIG = null;
let bgError = false;
const music = { audio: null, src: '', error: false, userPaused: false, fadeTimer: 0, voiceRoom: false };
const reduceQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');

// ---------- Ajustes ----------
function intIn(v, min, max, def) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}
function isHex(s) {
  return /^#[0-9a-f]{6}$/i.test(String(s || ''));
}
function str(v, max = 4096) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function normalizeAppearance(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const m = r.music && typeof r.music === 'object' ? r.music : {};
  const out = { ...APPEARANCE_DEFAULTS, ...r, music: { ...APPEARANCE_DEFAULTS.music, ...m } };
  if (out.accent !== 'custom' && !PRESETS.some((p) => p.id === out.accent)) out.accent = 'venus';
  out.customColor = isHex(out.customColor) ? out.customColor.toLowerCase() : APPEARANCE_DEFAULTS.customColor;
  out.tint = out.tint !== false;
  out.background = ['image', 'wallpaper'].includes(out.background) ? out.background : 'stars';
  out.wallpaperId = getWallpaper(out.wallpaperId)?.id || APPEARANCE_DEFAULTS.wallpaperId;
  if (out.background === 'wallpaper' && !out.wallpaperId) out.background = 'stars';
  out.bgFile = str(out.bgFile);
  out.bgDim = intIn(out.bgDim, 0, 90, 45);
  out.bgBlur = intIn(out.bgBlur, 0, 24, 0);
  out.music = {
    enabled: Boolean(out.music.enabled),
    file: str(out.music.file),
    volume: intIn(out.music.volume, 0, 100, 35),
    pauseInGame: out.music.pauseInGame !== false,
  };
  return out;
}

function normalizeBranding(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { ...BRANDING_DEFAULTS, ...r };
  out.name = str(out.name, NAME_MAX);
  out.subtitle = typeof out.subtitle === 'string' ? out.subtitle.slice(0, NAME_MAX) : BRANDING_DEFAULTS.subtitle;
  out.logo = /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(out.logo || '') ? out.logo : '';
  out.logoName = str(out.logoName, 200);
  out.logoPixel = Boolean(out.logoPixel);
  out.server = str(out.server, 260).trim();
  return out;
}

function fromStore() {
  const s = store.settings || {};
  const a = normalizeAppearance({ ...(s.appearance || {}), ...inFlight.appearance, ...pending.appearance, music: { ...(s.appearance?.music || {}), ...(inFlight.appearance.music || {}), ...(pending.appearance.music || {}) } });
  const b = normalizeBranding({ ...(s.branding || {}), ...inFlight.branding, ...pending.branding });
  return { a, b };
}

export function appearanceSettings() {
  return { appearance: { ...ap, music: { ...ap.music } }, branding: { ...br } };
}

// Guarda cambios: se aplican al instante y se escriben con una pequeña espera (deslizadores, textos)
function save({ appearance, branding } = {}, delay = 0) {
  if (appearance) {
    if (appearance.background !== undefined || appearance.bgFile !== undefined || appearance.wallpaperId !== undefined) bgError = false;
    const { music: m, ...rest } = appearance;
    ap = normalizeAppearance({ ...ap, ...rest, music: { ...ap.music, ...(m || {}) } });
    Object.assign(pending.appearance, rest);
    if (m) pending.appearance.music = { ...(pending.appearance.music || {}), ...m };
  }
  if (branding) {
    br = normalizeBranding({ ...br, ...branding });
    Object.assign(pending.branding, branding);
  }
  applyAll();
  emit();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    flush().catch((err) => fail(t('appearance.saveFailed'), err));
  }, delay);
}

function flush() {
  if (activeSave) return activeSave;
  // Serializar evita que una respuesta vieja revierta una elección más reciente.
  activeSave = (async () => {
    while (Object.keys(pending.appearance).length || Object.keys(pending.branding).length) {
      const p = pending;
      inFlight = p;
      pending = { appearance: {}, branding: {} };
      const patch = {};
      if (Object.keys(p.appearance).length) patch.appearance = p.appearance;
      if (Object.keys(p.branding).length) patch.branding = p.branding;
      try {
        await store.setSettings(patch);
      } catch (err) {
        pending = {
          appearance: { ...p.appearance, ...pending.appearance, ...(p.appearance.music || pending.appearance.music ? { music: { ...p.appearance.music, ...pending.appearance.music } } : {}) },
          branding: { ...p.branding, ...pending.branding },
        };
        throw err;
      } finally {
        inFlight = { appearance: {}, branding: {} };
      }
    }
  })().finally(() => { activeSave = null; });
  return activeSave;
}

// La bienvenida espera este guardado antes de terminar. Un error conserva los cambios para reintentar.
export function flushAppearance() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  return flush();
}

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.error('[appearance]', err);
    }
  }
}

function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------- Utilidades ----------
// Ruta local -> URL file:// (C:\Fotos\fondo 1.png -> file:///C:/Fotos/fondo%201.png)
export function fileUrl(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (!s) return '';
  if (/^file:\/\//i.test(s)) return s;
  const unc = s.startsWith('//');
  const parts = s
    .replace(/^\/+/, '')
    .split('/')
    .map((seg, i) => (i === 0 && /^[a-zA-Z]:$/.test(seg) ? seg : encodeURIComponent(seg)));
  return unc ? `file://${parts.join('/')}` : `file:///${parts.join('/')}`;
}

function baseName(p) {
  return String(p || '').split(/[\\/]/).pop() || '';
}

function extOf(p) {
  const m = /\.([a-z0-9]+)$/i.exec(String(p || ''));
  return m ? m[1].toLowerCase() : '';
}

const isVideo = (p) => VIDEO_EXT.includes(extOf(p));

export function accentColor(a = ap) {
  if (a.accent === 'custom') return a.customColor;
  return PRESETS.find((p) => p.id === a.accent)?.color || PRESETS[0].color;
}

function reducedMotion() {
  return document.body.classList.contains('reduce-motion') || Boolean(reduceQuery?.matches);
}

function gameRunning() {
  return Object.values(store.running || {}).some((r) => r && r.state === 'running');
}

// ---------- Aplicar: color ----------
function applyTheme() {
  const color = accentColor();
  const isDefault = color.toLowerCase() === PRESETS[0].color;
  engine.setTheme(isDefault ? null : { accent: color, tint: ap.tint });
  // el planeta del logo gira su tono para acompañar al acento (filtro hue-rotate)
  const root = document.documentElement;
  if (isDefault) {
    root.style.removeProperty('--ap-hue');
    root.style.removeProperty('--ap-sat');
  } else {
    const target = toHsl(parseColor(engine.legibleAccent(color)));
    const base = toHsl(parseColor(PRESETS[0].color));
    root.style.setProperty('--ap-hue', `${Math.round(target.h - base.h)}deg`);
    root.style.setProperty('--ap-sat', String(Math.round(Math.min(1.3, Math.max(0, target.s / base.s)) * 100) / 100));
  }
}

// ---------- Aplicar: fondo ----------
function makeMedia(url, video) {
  if (video) {
    const v = document.createElement('video');
    v.className = 'ap-bg-media';
    v.muted = true;
    v.defaultMuted = true;
    v.loop = true;
    v.playsInline = true;
    v.autoplay = true;
    v.setAttribute('aria-hidden', 'true');
    v.src = url;
    return v;
  }
  const img = document.createElement('img');
  img.className = 'ap-bg-media';
  img.alt = '';
  img.decoding = 'async';
  img.src = url;
  return img;
}

function applyBackground() {
  const host = document.querySelector('.space-bg');
  if (!host) return;
  const wallpaper = ap.background === 'wallpaper' ? getWallpaper(ap.wallpaperId) : null;
  const url = wallpaper?.src || (ap.background === 'image' && ap.bgFile ? fileUrl(ap.bgFile) : '');
  const want = Boolean(url) && !bgError;
  let layer = host.querySelector('.ap-bg');
  host.classList.toggle('ap-has-image', Boolean(want));
  if (!want) {
    layer?.remove();
    return;
  }
  if (!layer) {
    layer = h('div', { class: 'ap-bg', 'aria-hidden': 'true' });
    host.prepend(layer);
  }
  if (layer.dataset.src !== url) {
    layer.dataset.src = url;
    const media = makeMedia(url, ap.background === 'image' && isVideo(ap.bgFile));
    media.addEventListener(
      'error',
      () => {
        if (layer.dataset.src !== url) return;
        bgError = true;
        console.warn('[appearance] fondo no disponible', url);
        applyBackground();
        emit();
      },
      { once: true },
    );
    mount(layer, media, h('div', { class: 'ap-bg-dim' }));
  }
  layer.style.setProperty('--ap-bg-dim', String(ap.bgDim / 100));
  layer.style.setProperty('--ap-bg-blur', `${ap.bgBlur}px`);
  updateVideo();
}

function updateVideo() {
  const v = document.querySelector('.space-bg .ap-bg video');
  if (!v) return;
  const play = !reducedMotion() && !gameRunning() && !document.hidden;
  if (play && v.paused) v.play().catch(() => {});
  else if (!play && !v.paused) v.pause();
}

// ---------- Aplicar: marca ----------
function captureOriginal() {
  if (ORIG) return;
  const brandImg = document.querySelector('.brand img');
  const tbTitle = document.querySelector('.titlebar .tb-title');
  const tbText = [...(tbTitle?.childNodes || [])].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
  ORIG = {
    brandSrc: brandImg?.getAttribute('src') || 'assets/logo-256.png',
    brandAlt: brandImg?.getAttribute('alt') || 'Venus Launcher',
    name: document.querySelector('.brand .brand-name')?.textContent || 'VENUS',
    sub: document.querySelector('.brand .brand-sub')?.textContent || 'LAUNCHER',
    tbSrc: tbTitle?.querySelector('img')?.getAttribute('src') || 'assets/logo-64.png',
    tbText: tbText?.textContent || 'VENUS LAUNCHER',
    title: document.title || 'Venus Launcher',
  };
}

export function brandingView(b = br) {
  captureOriginal();
  const custom = b.name.trim();
  const sub = custom ? b.subtitle.trim() : ORIG.sub;
  return {
    custom: Boolean(custom),
    name: custom || ORIG.name,
    sub,
    logo: b.logo || '',
    logoSrc: b.logo || ORIG.brandSrc,
    smallLogoSrc: b.logo || ORIG.tbSrc,
    full: custom ? [custom, b.subtitle.trim()].filter(Boolean).join(' ') : ORIG.title,
    title: custom ? [custom, b.subtitle.trim()].filter(Boolean).join(' ') : ORIG.tbText,
    pixel: b.logoPixel,
  };
}

// Achica la letra del nombre hasta que entre en la barra lateral
function fitName(el, max = 24, min = 13) {
  if (!el) return;
  el.style.fontSize = '';
  if (!el.clientWidth) return;
  let size = max;
  while (el.scrollWidth > el.clientWidth + 1 && size > min) {
    size -= 1;
    el.style.fontSize = `${size}px`;
  }
}

function applyBranding() {
  captureOriginal();
  const v = brandingView();
  const root = document.documentElement;
  root.classList.toggle('ap-branded', v.custom || Boolean(v.logo));
  root.classList.toggle('ap-logo', Boolean(v.logo));
  const brandImg = document.querySelector('.brand img');
  if (brandImg) {
    if (brandImg.getAttribute('src') !== v.logoSrc) brandImg.src = v.logoSrc;
    brandImg.alt = v.custom ? v.full : ORIG.brandAlt;
    brandImg.classList.toggle('ap-logo-custom', Boolean(v.logo));
    brandImg.classList.toggle('ap-logo-pixel', Boolean(v.logo) && v.pixel);
    brandImg.classList.toggle('ap-tintable', !v.logo);
  }
  const nameEl = document.querySelector('.brand .brand-name');
  const subEl = document.querySelector('.brand .brand-sub');
  if (nameEl && nameEl.textContent !== v.name) nameEl.textContent = v.name;
  if (subEl) {
    if (subEl.textContent !== v.sub) subEl.textContent = v.sub;
    subEl.hidden = !v.sub;
  }
  const tbTitle = document.querySelector('.titlebar .tb-title');
  if (tbTitle) {
    const img = tbTitle.querySelector('img');
    if (img && img.getAttribute('src') !== v.smallLogoSrc) img.src = v.smallLogoSrc;
    img?.classList.toggle('ap-logo-custom', Boolean(v.logo));
    img?.classList.toggle('ap-tintable', !v.logo);
    let text = [...tbTitle.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
    if (!text) {
      text = document.createTextNode('');
      tbTitle.append(text);
    }
    if (text.textContent !== v.title) text.textContent = v.title;
  }
  if (document.title !== v.full) document.title = v.full;
  fitName(nameEl);
}

// ---------- Aplicar: musica ----------
function musicShouldPlay() {
  const m = ap.music;
  if (!m.enabled || !m.file || music.userPaused || music.error) return false;
  if (m.pauseInGame && (gameRunning() || music.voiceRoom)) return false;
  return true;
}

function targetVolume() {
  return Math.pow(ap.music.volume / 100, 1.6);
}

function fadeTo(target, after) {
  const a = music.audio;
  if (!a) return;
  clearInterval(music.fadeTimer);
  const from = a.volume;
  if (document.hidden || Math.abs(from - target) < 0.01) {
    a.volume = Math.min(1, Math.max(0, target));
    after?.();
    return;
  }
  const start = performance.now();
  const dur = 450;
  music.fadeTimer = setInterval(() => {
    const k = Math.min(1, (performance.now() - start) / dur);
    a.volume = Math.min(1, Math.max(0, from + (target - from) * k));
    if (k >= 1) {
      clearInterval(music.fadeTimer);
      after?.();
    }
  }, 30);
}

function releaseAudio() {
  clearInterval(music.fadeTimer);
  if (music.audio) {
    music.audio.pause();
    music.audio.removeAttribute('src');
    music.audio.load();
  }
  music.audio = null;
  music.src = '';
}

function updateMusic() {
  const m = ap.music;
  if (!m.enabled || !m.file) {
    if (music.audio) fadeTo(0, releaseAudio);
    music.error = false;
    return;
  }
  const url = fileUrl(m.file);
  if (music.src !== url) {
    releaseAudio();
    music.error = false;
    const a = new Audio();
    a.loop = true;
    a.preload = 'auto';
    a.volume = 0;
    a.addEventListener('error', () => {
      if (music.audio !== a) return;
      music.error = true;
      console.warn('[appearance] musica no disponible', m.file);
      emit();
    });
    a.addEventListener('play', emit);
    a.addEventListener('pause', emit);
    a.src = url;
    music.audio = a;
    music.src = url;
  }
  const a = music.audio;
  if (musicShouldPlay()) {
    if (a.paused) {
      a.play()
        .then(() => fadeTo(targetVolume()))
        .catch((err) => {
          if (err?.name !== 'AbortError') console.warn('[appearance] musica', err);
        });
    } else fadeTo(targetVolume());
  } else if (!a.paused) fadeTo(0, () => a.pause());
}

export function musicPlaying() {
  return Boolean(music.audio && !music.audio.paused);
}

export function toggleMusicPause() {
  if (!ap.music.enabled || !ap.music.file) return;
  music.userPaused = musicPlaying();
  updateMusic();
  emit();
}

// ---------- Aplicar todo ----------
function applyAll() {
  applyTheme();
  applyBackground();
  applyBranding();
  updateMusic();
}

export async function startup() {
  if (started) return;
  started = true;
  ensureCss('a11y');
  try {
    await loadNs('appearance');
  } catch (err) {
    console.warn('[appearance] i18n', err);
  }
  document.querySelector('link[href="styles/a11y.css"]')?.setAttribute('data-ax-skip', '');
  captureOriginal();
  ({ a: ap, b: br } = fromStore());
  applyAll();
  engine.applyNow();
  registerCommands(appearanceCommands);

  store.on('settings', () => {
    const { a, b } = fromStore();
    const changed = JSON.stringify(a) !== JSON.stringify(ap) || JSON.stringify(b) !== JSON.stringify(br);
    if (!changed) return;
    if (a.bgFile !== ap.bgFile || a.background !== ap.background || a.wallpaperId !== ap.wallpaperId) bgError = false;
    ap = a;
    br = b;
    applyAll();
    emit();
  });
  store.on('running', () => {
    updateMusic();
    updateVideo();
  });
  document.addEventListener('visibilitychange', updateVideo);
  new MutationObserver(updateVideo).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  try {
    const { voice } = await import('./voice.js');
    music.voiceRoom = Boolean(voice.room);
    voice.on?.('room', (room) => {
      music.voiceRoom = Boolean(room);
      updateMusic();
    });
  } catch (err) {
    console.warn('[appearance] voice', err);
  }
  // el nombre se reajusta cuando la barra lateral aparece (bienvenida) o cambia el tamaño
  const brand = document.querySelector('.brand');
  if (brand && 'ResizeObserver' in window) new ResizeObserver(() => fitName(document.querySelector('.brand .brand-name'))).observe(brand);
  // los textos del panel se recargan solos (setLanguage); solo hay que refrescar los comandos y el panel abierto
  onLanguageChange(() => emit());
}

// ---------- Comandos de la paleta ----------
function appearanceCommands() {
  const cmds = PRESETS.map((p) => ({
    id: `ap:accent:${p.id}`,
    group: 'appearance',
    title: t('appearance.cmdAccent', { name: t(`appearance.preset_${p.id}`) }),
    icon: swatchIcon(p.color),
    state: ap.accent === p.id,
    radio: true,
    keywords: t('appearance.kwAccent'),
    run: () => save({ appearance: { accent: p.id } }),
  }));
  cmds.push({ id: 'ap:bg:stars', group: 'appearance', title: t('appearance.cmdBgStars'), icon: 'sparkles', state: ap.background === 'stars', radio: true, keywords: t('appearance.kwBackground'), run: () => save({ appearance: { background: 'stars' } }) });
  if (getWallpaper(ap.wallpaperId)) cmds.push({ id: 'ap:bg:wallpaper', group: 'appearance', title: t('appearance.cmdBgGallery'), sub: getWallpaper(ap.wallpaperId).name, icon: 'image', state: ap.background === 'wallpaper', radio: true, keywords: t('appearance.kwBackground'), run: () => save({ appearance: { background: 'wallpaper' } }) });
  if (ap.bgFile) cmds.push({ id: 'ap:bg:image', group: 'appearance', title: t('appearance.cmdBgImage'), sub: baseName(ap.bgFile), icon: 'image', state: ap.background === 'image', radio: true, keywords: t('appearance.kwBackground'), run: () => save({ appearance: { background: 'image' } }) });
  if (ap.music.enabled && ap.music.file) {
    cmds.push({ id: 'ap:music', group: 'appearance', title: musicPlaying() ? t('appearance.cmdMusicPause') : t('appearance.cmdMusicPlay'), sub: baseName(ap.music.file), icon: musicPlaying() ? 'pause' : 'play', keywords: t('appearance.kwMusic'), run: () => toggleMusicPause() });
  }
  cmds.push({
    id: 'ap:panel',
    group: 'appearance',
    title: t('appearance.cmdOpenPanel'),
    icon: 'palette',
    keywords: t('appearance.kwPanel'),
    run: () => {
      // la seccion de Ajustes; si hay un dialogo abierto se cierra antes
      if (topDialog()) dispatchEscape();
      navigate('settings/appearance');
    },
  });
  return cmds;
}

function swatchIcon(color) {
  const el = h('span', { class: 'ap-cmd-swatch', style: { '--sw': color } });
  return el;
}

export function openAppearanceModal() {
  modal({ title: t('appearance.panelTitle'), body: appearancePanel(), size: 'wide' });
}

// ---------- Panel ----------
function toggleRow(title, sub, checked, onChangeFn) {
  const sw = switchEl(checked, onChangeFn, title);
  const input = sw.querySelector('input');
  return {
    el: h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), sub ? h('div', { class: 'tr-sub' }, sub) : null), sw),
    set: (v) => {
      input.checked = Boolean(v);
    },
  };
}

function card(iconName, title, sub, ...children) {
  return h(
    'section',
    { class: 'card ax-card' },
    h('div', { class: 'ax-card-head' }, h('span', { class: 'ax-card-icon' }, icon(iconName)), h('div', {}, h('h3', { class: 'ax-card-title' }, title), sub ? h('p', { class: 'ax-card-sub' }, sub) : null)),
    ...children,
  );
}

let fieldSeq = 0;
// Id propio por control: el panel puede estar a la vez en Ajustes y en el dialogo de Apariencia.
const fieldId = (name) => `ap-${name}-${++fieldSeq}`;

function rangeField(label, { min, max, step, value, format, onInput }) {
  const id = fieldId('range');
  const input = h('input', { type: 'range', class: 'range', id, min, max, step, value, 'aria-label': label });
  const out = h('span', { class: 'ax-value', 'aria-hidden': 'true' }, format(value));
  input.addEventListener('input', () => {
    out.textContent = format(Number(input.value));
    input.setAttribute('aria-valuetext', format(Number(input.value)));
    onInput(Number(input.value));
  });
  input.setAttribute('aria-valuetext', format(value));
  const el = h('div', { class: 'ax-field' }, h('div', { class: 'ax-field-head' }, h('label', { class: 'label', for: id }, label), out), input);
  return {
    el,
    set(v) {
      if (document.activeElement !== input) input.value = v;
      out.textContent = format(v);
      input.setAttribute('aria-valuetext', format(v));
    },
  };
}

async function pickFile(titleKey, filterKey, exts) {
  try {
    const files = await api.app.selectFiles({ title: t(titleKey), filters: [{ name: t(filterKey), extensions: exts }] });
    const file = Array.isArray(files) ? files[0] : null;
    if (!file) return null;
    if (!exts.includes(extOf(file))) {
      toast('bad', t('appearance.errFormat'), t('appearance.errFormatText', { formats: exts.join(', ').toUpperCase() }));
      return null;
    }
    return file;
  } catch (err) {
    fail(t('appearance.errPick'), err);
    return null;
  }
}

// Convierte el logo elegido en un PNG chico (data:) para que no dependa del archivo original
function rasterizeLogo(url, max = 160) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth || max;
        const hgt = img.naturalHeight || max;
        const scale = Math.min(1, max / Math.max(w, hgt));
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(hgt * scale));
        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        const pixel = Math.max(w, hgt) <= 64;
        ctx.imageSmoothingEnabled = !pixel;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, cw, ch);
        let data = canvas.toDataURL('image/png');
        if (data.length > 300000) data = canvas.toDataURL('image/webp', 0.9);
        resolve({ data, pixel });
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error(t('appearance.errImage')));
    img.src = url;
  });
}

const SERVER_RE = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::(\d{1,5}))?$/i;
export function validServer(address) {
  const s = String(address || '').trim();
  if (!s) return true;
  const m = SERVER_RE.exec(s);
  if (!m) return false;
  return !m[1] || (Number(m[1]) >= 1 && Number(m[1]) <= 65535);
}

export function appearancePanel() {
  ensureCss('a11y');
  const root = h('div', { class: 'ax-panel ap-panel' });
  if (has('appearance.panelColor')) buildPanel(root);
  else {
    mount(root, skeleton('card', { lines: 4 }));
    loadNs('appearance')
      .then(() => buildPanel(root))
      .catch((err) => mount(root, h('div', { class: 'notice bad' }, icon('alert'), String(err?.message || err))));
  }
  return root;
}

// Los mismos controles de color y fondo en la bienvenida y en Configuración.
// Quien lo monte debe llamar destroy() al cambiar de paso o cerrar la bienvenida.
export function appearancePicker({ compact = true } = {}) {
  ensureCss('a11y');
  const root = h('div', { class: ['ax-panel ap-panel ap-picker', compact && 'ap-picker-compact'] });
  let destroyed = false;
  let off = () => {};
  root.destroy = () => {
    destroyed = true;
    off();
    flushAppearance().catch((err) => fail(t('appearance.saveFailed'), err));
  };
  const build = () => {
    if (destroyed) return;
    if (!started) ({ a: ap, b: br } = fromStore());
    const { colorCard, bgCard, sync } = createAppearanceControls({ compact });
    mount(root, colorCard, bgCard);
    off = onChange(sync);
  };
  if (has('appearance.panelColor')) build();
  else {
    mount(root, skeleton('card', { lines: 4 }));
    loadNs('appearance').then(build).catch((err) => {
      if (!destroyed) mount(root, h('div', { class: 'notice bad' }, icon('alert'), String(err?.message || err)));
    });
  }
  return root;
}

function createAppearanceControls({ compact = false } = {}) {
  // --- Color ---
  const colorInput = h('input', { type: 'color', class: 'ap-color-native', value: ap.customColor, 'aria-label': t('appearance.customPick'), tabindex: -1 });
  const hexInput = h('input', { class: 'input ap-hex', value: ap.customColor, maxlength: 7, spellcheck: 'false', 'aria-label': t('appearance.customHex') });
  const legibility = h('div', { class: 'ax-hint ap-legible' });
  const swatches = [...PRESETS.map((p) => ({ id: p.id, color: p.color, label: t(`appearance.preset_${p.id}`) })), { id: 'custom', color: null, label: t('appearance.custom') }];
  const swatchBtns = swatches.map((sw) => {
    const btn = h(
      'button',
      {
        type: 'button',
        class: ['ap-swatch', sw.id === 'custom' && 'ap-swatch-custom'],
        role: 'radio',
        title: sw.label,
        dataset: { id: sw.id },
        onclick: () => {
          if (sw.id === 'custom') {
            if (ap.accent === 'custom') colorInput.click();
            save({ appearance: { accent: 'custom' } });
          } else save({ appearance: { accent: sw.id } });
        },
      },
      h('span', { class: 'ap-planet', style: { '--sw': sw.color || ap.customColor }, 'aria-hidden': 'true' }, sw.id === 'custom' ? icon('palette') : null),
      h('span', { class: 'ap-swatch-name' }, sw.label),
      h('span', { class: 'ap-swatch-check', 'aria-hidden': 'true' }, icon('check')),
    );
    return btn;
  });
  const swatchGroup = h('div', { class: 'ap-swatches', role: 'radiogroup', 'aria-label': t('appearance.accent') }, swatchBtns);
  swatchGroup.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const i = swatchBtns.indexOf(document.activeElement);
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? swatchBtns.length - 1 : (i < 0 ? 0 : i + d + swatchBtns.length) % swatchBtns.length;
    const next = swatchBtns[n];
    next.focus();
    save({ appearance: { accent: next.dataset.id } });
  });
  colorInput.addEventListener('input', () => save({ appearance: { accent: 'custom', customColor: colorInput.value.toLowerCase() } }, 400));
  // Se aplica en cuanto el codigo es valido; el error se marca al salir del campo (no en cada tecla).
  const hexValue = () => {
    const v = hexInput.value.trim();
    return v && !v.startsWith('#') ? `#${v}` : v;
  };
  hexInput.addEventListener('input', () => {
    const v = hexValue();
    if (!isHex(v)) return;
    hexInput.classList.remove('ap-invalid');
    hexInput.removeAttribute('aria-invalid');
    save({ appearance: { accent: 'custom', customColor: v.toLowerCase() } }, 400);
  });
  hexInput.addEventListener('blur', () => {
    const bad = Boolean(hexInput.value.trim()) && !isHex(hexValue());
    hexInput.classList.toggle('ap-invalid', bad);
    if (bad) hexInput.setAttribute('aria-invalid', 'true');
    else hexInput.removeAttribute('aria-invalid');
  });
  const customRow = h(
    'div',
    { class: 'ap-custom-row' },
    h('button', { type: 'button', class: 'btn sm', onclick: () => colorInput.click() }, icon('palette'), t('appearance.customPick')),
    hexInput,
    colorInput,
    legibility,
  );
  const tint = toggleRow(t('appearance.tint'), t('appearance.tintSub'), ap.tint, (v) => save({ appearance: { tint: v } }));
  const previewSwitch = switchEl(true, () => {}, t('appearance.previewSwitch'));
  previewSwitch.querySelector('input').tabIndex = -1;
  const preview = h(
    'div',
    { class: 'ap-preview', 'aria-hidden': 'true', inert: '' },
    h('div', { class: 'ap-preview-row' }, h('span', { class: 'btn primary sm' }, icon('play'), t('appearance.previewPlay')), h('span', { class: 'btn sm' }, t('appearance.previewButton')), h('span', { class: 'chip active' }, icon('check'), t('appearance.previewChip')), h('span', { class: 'badge accent' }, t('appearance.previewBadge')), previewSwitch),
    h('div', { class: 'ap-preview-row' }, h('div', { class: 'progress ap-preview-progress' }, h('i', { style: { width: '62%' } })), h('span', { class: 'ap-preview-link' }, t('appearance.previewLink'))),
  );
  const colorCard = card('palette', t('appearance.panelColor'), compact ? null : t('appearance.panelColorSub'), swatchGroup, customRow, compact ? null : preview, compact ? null : h('div', { class: 'ax-toggles' }, tint.el));
  colorCard.classList.add('ap-color-card');

  // --- Fondo ---
  const bgSeg = h('div', { class: 'segmented ax-seg', role: 'radiogroup', 'aria-label': t('appearance.background') });
  // La galería solo aparece si el launcher trae fondos (wallpapers.js; hoy ninguno).
  const bgOptions = [
    { value: 'stars', label: t('appearance.bgStars'), icon: 'sparkles' },
    WALLPAPERS.length ? { value: 'wallpaper', label: t('appearance.bgGallery'), icon: 'image' } : null,
    { value: 'image', label: t('appearance.bgImage'), icon: 'image' },
  ].filter(Boolean);
  const bgBtns = bgOptions.map((o) =>
    h(
      'button',
      {
        type: 'button',
        role: 'radio',
        dataset: { background: o.value },
        onclick: async () => {
          if (o.value === 'image' && !ap.bgFile) {
            const file = await pickFile('appearance.pickBgTitle', 'appearance.filterMedia', [...IMAGE_EXT, ...VIDEO_EXT]);
            if (!file) return;
            bgError = false;
            save({ appearance: { background: 'image', bgFile: file } });
          } else save({ appearance: { background: o.value } });
        },
      },
      icon(o.icon),
      o.label,
    ),
  );
  bgSeg.append(...bgBtns);
  // Solo la opcion elegida entra en el orden de Tab: las flechas mueven el foco y Enter o Espacio eligen
  // (elegir "Imagen o video" abre el selector de archivos, por eso no se elige solo con moverse).
  bgSeg.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    const i = bgBtns.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    let n = (i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + bgBtns.length) % bgBtns.length;
    if (e.key === 'Home') n = 0;
    if (e.key === 'End') n = bgBtns.length - 1;
    bgBtns.forEach((b, j) => (b.tabIndex = j === n ? 0 : -1));
    bgBtns[n].focus();
  });
  const galleryLabel = fieldId('gallery-label');
  const galleryStatus = h('span', { class: 'ax-hint ap-gallery-status', role: 'status', 'aria-live': 'polite' });
  const gallery = h('div', { class: 'ap-wallpapers', role: 'radiogroup', 'aria-labelledby': galleryLabel });
  const wallpaperBtns = WALLPAPERS.map((wallpaper, i) => h('button', {
    type: 'button', class: 'ap-wallpaper', role: 'radio', title: wallpaper.name,
    'aria-label': wallpaper.name, 'aria-checked': 'false', tabindex: i === 0 ? 0 : -1,
    dataset: { id: wallpaper.id },
    onclick: () => save({ appearance: { background: 'wallpaper', wallpaperId: wallpaper.id } }),
  },
  h('img', { src: wallpaper.thumb, alt: '', loading: 'lazy', decoding: 'async', width: 320, height: 180 }),
  h('span', { class: 'ap-wallpaper-name', 'aria-hidden': 'true' }, wallpaper.name),
  h('span', { class: 'ap-wallpaper-check', 'aria-hidden': 'true' }, icon('check'))));
  gallery.append(...wallpaperBtns);
  gallery.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    const i = wallpaperBtns.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const columns = Math.max(1, getComputedStyle(gallery).gridTemplateColumns.split(' ').length);
    const delta = e.key === 'ArrowUp' ? -columns : e.key === 'ArrowDown' ? columns : e.key === 'ArrowLeft' ? -1 : 1;
    const n = e.key === 'Home' ? 0 : e.key === 'End' ? wallpaperBtns.length - 1 : (i + delta + wallpaperBtns.length) % wallpaperBtns.length;
    const next = wallpaperBtns[n];
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    save({ appearance: { background: 'wallpaper', wallpaperId: next.dataset.id } });
  });
  const galleryWrap = h('div', { class: 'ap-gallery-wrap' },
    h('div', { class: 'ap-gallery-head' }, h('span', { class: 'label', id: galleryLabel }, t('appearance.galleryTitle', { count: WALLPAPERS.length })), galleryStatus),
    gallery,
  );
  const bgThumb = h('div', { class: 'ap-bg-thumb' });
  const bgName = h('div', { class: 'ap-file-name ellipsis' });
  const bgError_ = h('div', { class: 'notice bad ap-file-error' }, icon('alert'), h('span', {}, t('appearance.bgMissing')));
  const pickBg = async () => {
    const file = await pickFile('appearance.pickBgTitle', 'appearance.filterMedia', [...IMAGE_EXT, ...VIDEO_EXT]);
    if (!file) return;
    bgError = false;
    save({ appearance: { background: 'image', bgFile: file } });
  };
  const bgDim = rangeField(t('appearance.bgDim'), { min: 0, max: 90, step: 5, value: ap.bgDim, format: (v) => t('appearance.percent', { value: v }), onInput: (v) => save({ appearance: { bgDim: v } }, 400) });
  const bgBlur = rangeField(t('appearance.bgBlur'), { min: 0, max: 24, step: 1, value: ap.bgBlur, format: (v) => t('appearance.pixels', { value: v }), onInput: (v) => save({ appearance: { bgBlur: v } }, 400) });
  bgDim.el.querySelector('input').dataset.setting = 'bgDim';
  bgBlur.el.querySelector('input').dataset.setting = 'bgBlur';
  const fileActions = h('div', { class: 'row wrap' },
    h('button', { type: 'button', class: 'btn sm', onclick: pickBg }, icon('folderOpen'), t('appearance.pickBg')),
    h('button', { type: 'button', class: 'btn sm ghost', onclick: () => save({ appearance: { background: 'stars', bgFile: '' } }) }, icon('trash'), t('appearance.removeBg')),
  );
  const bgControls = h(
    'div',
    { class: 'ap-bg-controls' },
    bgThumb,
    h(
      'div',
      { class: 'ap-bg-side' },
      h('div', { class: 'ap-file-row' }, icon('image'), bgName),
      fileActions,
      bgDim.el,
      bgBlur.el,
    ),
  );
  const bgHint = h('div', { class: 'ax-hint' }, t('appearance.bgHint'));
  const bgCard = card('image', t('appearance.panelBackground'), compact ? null : t('appearance.panelBackgroundSub'), bgSeg, galleryWrap, bgError_, bgControls, compact ? null : bgHint);
  bgCard.classList.add('ap-background-card');
  let lastGallerySelection = null;

  const sync = () => {
    swatchBtns.forEach((b) => {
      const on = b.dataset.id === ap.accent;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    swatchBtns[swatchBtns.length - 1].querySelector('.ap-planet').style.setProperty('--sw', ap.customColor);
    customRow.hidden = ap.accent !== 'custom';
    if (document.activeElement !== hexInput) {
      hexInput.value = ap.customColor;
      hexInput.classList.remove('ap-invalid');
    }
    if (colorInput.value.toLowerCase() !== ap.customColor) colorInput.value = ap.customColor;
    const applied = engine.legibleAccent(ap.customColor);
    legibility.hidden = ap.accent !== 'custom' || applied.toLowerCase() === ap.customColor.toLowerCase();
    legibility.replaceChildren(icon('info'), t('appearance.legibleAdjusted', { color: applied }));
    tint.set(ap.tint);

    bgBtns.forEach((b, i) => {
      const on = bgOptions[i].value === ap.background;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    const wallpaper = ap.background === 'wallpaper' ? getWallpaper(ap.wallpaperId) : null;
    wallpaperBtns.forEach((btn, i) => {
      const selected = wallpaper?.id === btn.dataset.id;
      btn.classList.toggle('active', selected);
      btn.setAttribute('aria-checked', String(selected));
      btn.tabIndex = selected || (!wallpaper && i === 0) ? 0 : -1;
    });
    galleryWrap.hidden = !WALLPAPERS.length || (!compact && ap.background !== 'wallpaper');
    const galleryText = wallpaper ? t('appearance.gallerySelected', { name: wallpaper.name }) : t('appearance.galleryChoose');
    if (galleryStatus.textContent !== galleryText) galleryStatus.textContent = galleryText;
    const gallerySelection = !galleryWrap.hidden ? wallpaper?.id || '' : null;
    if (gallerySelection && gallerySelection !== lastGallerySelection) {
      requestAnimationFrame(() => {
        if (!gallery.isConnected || galleryWrap.hidden) return;
        const selected = wallpaperBtns.find((btn) => btn.dataset.id === ap.wallpaperId);
        if (!selected) return;
        const view = gallery.getBoundingClientRect();
        const item = selected.getBoundingClientRect();
        // Solo mover el scroll de la galería; no desplazar toda la bienvenida.
        if (item.top < view.top || item.bottom > view.bottom) gallery.scrollTop += item.top - view.top - 4;
      });
    }
    lastGallerySelection = gallerySelection;
    const showBg = Boolean(wallpaper) || (ap.background === 'image' && Boolean(ap.bgFile));
    bgControls.hidden = !showBg;
    bgHint.hidden = showBg;
    bgError_.hidden = !(showBg && bgError);
    fileActions.hidden = ap.background !== 'image';
    if (showBg) {
      const url = wallpaper?.src || fileUrl(ap.bgFile);
      const video = !wallpaper && isVideo(ap.bgFile);
      if (bgThumb.dataset.src !== url) {
        bgThumb.dataset.src = url;
        const media = makeMedia(url, video);
        if (media.tagName === 'VIDEO') media.autoplay = false;
        mount(bgThumb, media, h('div', { class: 'ap-bg-dim' }), h('span', { class: 'ap-thumb-tag' }, t('appearance.livePreview')));
      }
      bgThumb.style.setProperty('--ap-bg-dim', String(ap.bgDim / 100));
      bgThumb.style.setProperty('--ap-bg-blur', `${Math.round(ap.bgBlur / 3)}px`);
      bgName.textContent = wallpaper?.name || baseName(ap.bgFile);
      bgName.title = wallpaper?.name || ap.bgFile;
    }
    bgDim.set(ap.bgDim);
    bgBlur.set(ap.bgBlur);

  };
  sync();
  return { colorCard, bgCard, sync };
}

function buildPanel(root) {
  if (!started) ({ a: ap, b: br } = fromStore());

  const { colorCard, bgCard, sync: syncVisuals } = createAppearanceControls();

  // --- Marca ---
  const miniLogo = h('img', { class: 'ap-mini-logo', alt: '' });
  const miniName = h('div', { class: 'ap-mini-name' });
  const miniSub = h('div', { class: 'ap-mini-sub' });
  const miniTbLogo = h('img', { class: 'ap-mini-tb-logo', alt: '' });
  const miniTbText = h('span', { class: 'ap-mini-tb-text' });
  const brandPreview = h(
    'div',
    { class: 'ap-brand-preview', 'aria-hidden': 'true' },
    h('div', { class: 'ap-mini-tb' }, miniTbLogo, miniTbText, h('span', { class: 'spacer' }), h('i'), h('i'), h('i')),
    h('div', { class: 'ap-mini-side' }, miniLogo, h('div', { class: 'ap-mini-texts' }, miniName, miniSub)),
  );
  const logoName = h('div', { class: 'ax-hint ap-logo-name' });
  const ids = { name: fieldId('brand-name'), sub: fieldId('brand-sub'), server: fieldId('server'), serverHint: fieldId('server-hint'), serverErr: fieldId('server-err') };
  const nameInput = h('input', { class: 'input', id: ids.name, maxlength: NAME_MAX, placeholder: 'VENUS', value: br.name, autocomplete: 'off', spellcheck: 'false' });
  const subInput = h('input', { class: 'input', id: ids.sub, maxlength: NAME_MAX, placeholder: 'LAUNCHER', value: br.subtitle, autocomplete: 'off', spellcheck: 'false' });
  nameInput.addEventListener('input', () => save({ branding: { name: nameInput.value } }, 500));
  subInput.addEventListener('input', () => save({ branding: { subtitle: subInput.value } }, 500));
  const pickLogo = async () => {
    const file = await pickFile('appearance.pickLogoTitle', 'appearance.filterImages', LOGO_EXT);
    if (!file) return;
    try {
      const { data, pixel } = await rasterizeLogo(fileUrl(file));
      save({ branding: { logo: data, logoName: baseName(file), logoPixel: pixel } });
    } catch (err) {
      fail(t('appearance.errImage'), err);
    }
  };
  const serverInput = h('input', { class: 'input', id: ids.server, placeholder: t('appearance.serverPlaceholder'), value: br.server, maxlength: 260, spellcheck: 'false', autocomplete: 'off', 'aria-describedby': ids.serverHint });
  const serverHint = h('div', { class: 'ax-hint', id: ids.serverHint }, t('appearance.serverHint'));
  const serverError = h('div', { class: 'field-error', id: ids.serverErr, role: 'alert', hidden: true }, icon('alert'), h('span', {}, t('appearance.serverInvalid')));
  const serverResult = h('div', { class: 'ap-server-result', role: 'status', 'aria-live': 'polite' });
  const testBtn = h('button', { type: 'button', class: 'btn sm' }, icon('wifi'), t('appearance.serverTest'));
  const markServer = (bad) => {
    serverInput.classList.toggle('ap-invalid', bad);
    serverError.hidden = !bad;
    if (bad) {
      serverInput.setAttribute('aria-invalid', 'true');
      serverInput.setAttribute('aria-describedby', `${ids.serverHint} ${ids.serverErr}`);
    } else {
      serverInput.removeAttribute('aria-invalid');
      serverInput.setAttribute('aria-describedby', ids.serverHint);
    }
  };
  // Se guarda en cuanto la direccion es valida; el error se muestra al salir del campo (no en cada tecla).
  serverInput.addEventListener('input', () => {
    const v = serverInput.value.trim();
    serverResult.replaceChildren();
    testBtn.disabled = !v || !validServer(v);
    if (!validServer(v)) return;
    markServer(false);
    save({ branding: { server: v } }, 600);
  });
  serverInput.addEventListener('blur', () => markServer(!validServer(serverInput.value.trim())));
  testBtn.addEventListener('click', () => testServer(serverInput.value.trim(), serverResult, testBtn));
  const brandCard = card(
    'crown',
    t('appearance.panelBrand'),
    t('appearance.panelBrandSub'),
    h(
      'div',
      { class: 'ap-brand-grid' },
      brandPreview,
      h(
        'div',
        { class: 'stack ap-brand-fields' },
        h(
          'div',
          { class: 'ax-field', role: 'group', 'aria-label': t('appearance.logo') },
          h('div', { class: 'label' }, t('appearance.logo')),
          h(
            'div',
            { class: 'row wrap' },
            h('button', { type: 'button', class: 'btn sm', onclick: pickLogo }, icon('upload'), t('appearance.pickLogo')),
            h('button', { type: 'button', class: 'btn sm ghost ap-logo-reset', onclick: () => save({ branding: { logo: '', logoName: '', logoPixel: false } }) }, icon('undo'), t('appearance.logoDefault')),
          ),
          logoName,
        ),
        h(
          'div',
          { class: 'form-grid' },
          h('div', { class: 'field' }, h('label', { for: ids.name }, t('appearance.brandName')), nameInput),
          h('div', { class: 'field' }, h('label', { for: ids.sub }, t('appearance.brandSub')), subInput),
        ),
        h('div', { class: 'ax-hint' }, t('appearance.brandHint')),
      ),
    ),
    h('div', { class: 'divider' }),
    h('div', { class: 'ax-field' }, h('label', { class: 'label', for: ids.server }, t('appearance.server')), h('div', { class: 'ap-server-row' }, serverInput, testBtn), serverHint, serverError, serverResult),
  );

  // --- Musica ---
  const musicToggle = toggleRow(t('appearance.musicEnable'), t('appearance.musicSub'), ap.music.enabled, async (v) => {
    if (v && !ap.music.file) {
      const file = await pickFile('appearance.pickMusicTitle', 'appearance.filterAudio', AUDIO_EXT);
      if (!file) {
        musicToggle.set(false);
        return;
      }
      music.userPaused = false;
      save({ appearance: { music: { enabled: true, file } } });
      return;
    }
    music.userPaused = false;
    save({ appearance: { music: { enabled: v } } });
  });
  const musicName = h('div', { class: 'ap-file-name ellipsis' });
  const playBtn = h('button', { type: 'button', class: 'icon-btn sm', onclick: () => toggleMusicPause() });
  const pickMusic = async () => {
    const file = await pickFile('appearance.pickMusicTitle', 'appearance.filterAudio', AUDIO_EXT);
    if (!file) return;
    music.userPaused = false;
    save({ appearance: { music: { enabled: true, file } } });
  };
  const volume = rangeField(t('appearance.volume'), { min: 0, max: 100, step: 5, value: ap.music.volume, format: (v) => t('appearance.percent', { value: v }), onInput: (v) => save({ appearance: { music: { volume: v } } }, 400) });
  const pauseInGame = toggleRow(t('appearance.pauseInGame'), t('appearance.pauseInGameSub'), ap.music.pauseInGame, (v) => save({ appearance: { music: { pauseInGame: v } } }));
  const musicError = h('div', { class: 'notice bad ap-file-error' }, icon('alert'), h('span', {}, t('appearance.musicMissing')));
  const musicState = h('span', { class: 'pill ap-music-state' });
  const musicBody = h(
    'div',
    { class: 'stack ap-music-body' },
    h(
      'div',
      { class: 'ap-music-row' },
      playBtn,
      h('div', { class: 'ap-music-main' }, musicName, musicState),
      h('button', { type: 'button', class: 'btn sm', onclick: pickMusic }, icon('folderOpen'), t('appearance.pickMusic')),
      h('button', { type: 'button', class: 'icon-btn sm danger', title: t('appearance.removeMusic'), 'aria-label': t('appearance.removeMusic'), onclick: () => save({ appearance: { music: { enabled: false, file: '' } } }) }, icon('trash')),
    ),
    musicError,
    volume.el,
    h('div', { class: 'ax-toggles' }, pauseInGame.el),
  );
  const musicCard = card('music', t('appearance.panelMusic'), t('appearance.panelMusicSub'), h('div', { class: 'ax-toggles' }, musicToggle.el), musicBody);

  const resetBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn ghost sm',
      onclick: async () => {
        if (!(await confirmDialog(t('appearance.resetTitle'), t('appearance.resetText'), { okText: t('appearance.resetOk'), danger: true }))) return;
        music.userPaused = false;
        bgError = false;
        const { server } = br;
        save({ appearance: { ...APPEARANCE_DEFAULTS, music: { ...APPEARANCE_DEFAULTS.music } }, branding: { ...BRANDING_DEFAULTS, server } });
        nameInput.value = '';
        subInput.value = BRANDING_DEFAULTS.subtitle;
      },
    },
    icon('undo'),
    t('appearance.reset'),
  );

  mount(root, colorCard, bgCard, brandCard, musicCard, h('div', { class: 'ax-panel-foot' }, h('span', { class: 'ax-hint' }, t('appearance.liveNote')), resetBtn));

  // --- Sincronizar ---
  const sync = () => {
    syncVisuals();

    const v = brandingView();
    miniLogo.src = v.logoSrc;
    miniLogo.classList.toggle('ap-logo-pixel', Boolean(v.logo) && v.pixel);
    miniLogo.classList.toggle('ap-tintable', !v.logo);
    miniTbLogo.classList.toggle('ap-tintable', !v.logo);
    miniName.textContent = v.name;
    miniSub.textContent = v.sub;
    miniSub.hidden = !v.sub;
    miniTbLogo.src = v.smallLogoSrc;
    miniTbText.textContent = v.title;
    logoName.replaceChildren(icon('image'), h('span', { class: 'ellipsis' }, br.logo ? t('appearance.logoCustom', { name: br.logoName || t('appearance.image') }) : t('appearance.logoVenus')));
    root.querySelector('.ap-logo-reset').disabled = !br.logo;
    if (document.activeElement !== nameInput) nameInput.value = br.name;
    if (document.activeElement !== subInput) subInput.value = br.subtitle;
    // una direccion invalida a medio escribir se deja como esta (con su error) hasta que la corrijan
    if (document.activeElement !== serverInput && serverInput.getAttribute('aria-invalid') !== 'true') serverInput.value = br.server;
    if (!testBtn.classList.contains('loading')) testBtn.disabled = !serverInput.value.trim() || !validServer(serverInput.value.trim());

    musicToggle.set(ap.music.enabled);
    musicBody.hidden = !ap.music.enabled || !ap.music.file;
    musicName.textContent = baseName(ap.music.file);
    musicName.title = ap.music.file;
    musicError.hidden = !music.error;
    const playing = musicPlaying();
    mount(playBtn, icon(playing ? 'pause' : 'play'));
    playBtn.title = playing ? t('appearance.musicPause') : t('appearance.musicPlay');
    playBtn.setAttribute('aria-label', playBtn.title);
    playBtn.disabled = music.error;
    const reason = music.error ? 'error' : playing ? 'playing' : music.userPaused ? 'paused' : ap.music.pauseInGame && (gameRunning() || music.voiceRoom) ? 'auto' : 'paused';
    musicState.className = `pill ap-music-state ${reason === 'playing' ? 'good' : reason === 'error' ? 'bad' : ''}`;
    musicState.textContent = t(`appearance.musicState_${reason}`);
    volume.set(ap.music.volume);
    pauseInGame.set(ap.music.pauseInGame);
  };
  sync();
  let wasConnected = false;
  const offs = [];
  root.destroy = () => {
    offs.splice(0).forEach((off) => off());
    flushAppearance().catch((err) => fail(t('appearance.saveFailed'), err));
  };
  const guard = () => {
    if (root.isConnected) {
      wasConnected = true;
      sync();
    } else if (wasConnected) root.destroy();
  };
  offs.push(onChange(guard), store.on('running', guard));
}

async function testServer(address, out, btn) {
  if (!address || !validServer(address)) return;
  const done = setBusy(btn);
  mount(out, h('span', { class: 'muted' }, t('appearance.serverTesting')));
  try {
    const d = await api.invoke('serverlist:ping', address);
    const online = d && d.online !== false;
    if (!online) {
      // el motivo (si lo hay) se lee completo; el boton Probar sirve para reintentar
      mount(out, h('span', { class: 'pill bad' }, icon('x'), t('appearance.serverOffline')), d?.errorText ? h('span', { class: 'small text-2 wrap-anywhere' }, d.errorText) : null);
    } else {
      const players = d.players && typeof d.players === 'object' ? d.players : {};
      const version = typeof d.version === 'string' ? d.version : d.version?.name;
      const latency = d.latency ?? d.ping;
      const favicon = typeof d.favicon === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(d.favicon) ? d.favicon : null;
      mount(
        out,
        favicon ? h('img', { class: 'ap-server-icon', src: favicon, alt: '' }) : null,
        h('span', { class: 'pill good' }, icon('check'), t('appearance.serverOnline')),
        Number.isFinite(Number(players.online)) ? h('span', { class: 'ap-server-meta' }, icon('users'), players.max ? t('appearance.serverPlayers', { online: fmtNumber(Number(players.online)), max: fmtNumber(Number(players.max)) }) : fmtNumber(Number(players.online))) : null,
        Number.isFinite(Number(latency)) ? h('span', { class: 'ap-server-meta' }, icon('activity'), t('appearance.serverLatency', { ms: Math.round(Number(latency)) })) : null,
        version ? h('span', { class: 'ap-server-meta ellipsis', title: String(version).replace(/§./g, '') }, icon('box'), String(version).replace(/§./g, '').slice(0, 40)) : null,
      );
    }
  } catch (err) {
    const missing = /no handler registered/i.test(err?.message || '');
    if (missing) mount(out, h('span', { class: 'small muted' }, t('appearance.serverTestUnavailable')));
    else mount(out, h('div', { class: 'field-error' }, icon('alert'), h('span', { class: 'wrap-anywhere' }, t('appearance.serverTestFailed', { error: err?.message || String(err) }))));
  } finally {
    done();
  }
}
