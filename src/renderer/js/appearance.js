// Apariencia y marca: "tu logo, tus colores, tu música o tu fondo".
// Color de acento (presets planetarios o propio) aplicado a toda la interfaz, fondo de estrellas o
// imagen/video propio con oscurecer y desenfoque, logo y nombre del launcher (barra lateral y de titulo),
// música de fondo en bucle y la direccion de "Tu servidor" que muestra Inicio.
// Ajustes en settings.appearance y settings.branding. Contrato: startup(), appearancePanel() -> Element.
// 3.1: looks guardados (settings.looks), editor de colores (appearance.palette), tema claro (appearance.scheme),
// temas de temporada (appearance.seasonal), fondos rotativos (appearance.rotation) y boton Jugar a gusto
// (appearance.playButton). La logica pura esta en a11y/appearance-logic.js y features/themes/looks.js.
import { h, icon, mount, ensureCss, switchEl, modal, confirmDialog, promptDialog, fail, ok, toast, skeleton, setBusy, copyText, fmtNumber, fmtDate } from './ui.js';
import { store, api } from './store.js';
import { t, loadNs, has, onLanguageChange } from './i18n.js';
import * as engine from './a11y/engine.js';
import { parseColor, toHsl, toHex, contrast } from './a11y/color.js';
import { registerCommands } from './a11y/palette.js';
import { topDialog } from './a11y/aria.js';
import { dispatchEscape } from './a11y/gamepad.js';
import { navigate } from './app.js';
import { WALLPAPERS, getWallpaper } from './wallpapers.js';
import { openWallpapersPage } from './community.js';
import {
  PRESETS,
  APPEARANCE_DEFAULTS,
  BRANDING_DEFAULTS,
  NAME_MAX,
  PALETTE_KEYS,
  PLAY_ANIMATIONS,
  PLAY_SOUNDS,
  PLAY_LABEL_MAX,
  ROTATION_PRESETS,
  SEASONS,
  isHex,
  normalizeAppearance,
  normalizeBranding,
  appearanceDefaults,
  accentColor as accentOf,
  effectiveScheme,
  seasonFor,
  seasonById,
  nextRotation,
  legiblePalette,
  paletteActive,
  cleanLabel,
} from './a11y/appearance-logic.js';
import * as looksCodec from './features/themes/looks.js';

export { PRESETS, APPEARANCE_DEFAULTS, BRANDING_DEFAULTS };

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'];
const VIDEO_EXT = ['mp4', 'webm', 'm4v', 'ogv'];
const AUDIO_EXT = ['mp3', 'ogg', 'oga', 'opus', 'wav', 'flac', 'm4a', 'aac', 'weba'];
const LOGO_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico', 'avif'];

let started = false;
let ap = normalizeAppearance();
let br = normalizeBranding();
let looks = [];
let pending = { appearance: {}, branding: {} };
let inFlight = { appearance: {}, branding: {} };
let activeSave = null;
let saveTimer = 0;
const listeners = new Set();
let ORIG = null;
let bgError = false;
const music = { audio: null, src: '', error: false, userPaused: false, fadeTimer: 0, voiceRoom: false };
const reduceQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
// Esquema aplicado ('dark' | 'light'), temporada anunciada (venus:season) y temporizadores
let scheme = 'dark';
let seasonAnnounced;
let minuteTimer = 0;
const rotation = { timer: 0, key: '' };

// ---------- Ajustes ----------
function fromStore() {
  const s = store.settings || {};
  const a = normalizeAppearance({ ...(s.appearance || {}), ...inFlight.appearance, ...pending.appearance, music: { ...(s.appearance?.music || {}), ...(inFlight.appearance.music || {}), ...(pending.appearance.music || {}) } });
  const b = normalizeBranding({ ...(s.branding || {}), ...inFlight.branding, ...pending.branding });
  return { a, b, l: looksCodec.normalizeLooks(s.looks) };
}

// Tarjetas de otros módulos (decoración, etc.): registerAppearanceCard(() => Element | null) antes de abrir el panel.
const extraCards = [];
export function registerAppearanceCard(fn) {
  if (typeof fn === 'function' && !extraCards.includes(fn)) extraCards.push(fn);
}

export function appearanceSettings() {
  return { appearance: normalizeAppearance(ap), branding: { ...br } };
}

// Looks guardados (copia) y esquema aplicado ahora ('dark' | 'light'), para otros modulos
export function savedLooks() {
  return looks.map((l) => looksCodec.normalizeLook(l));
}

export function currentScheme() {
  return scheme;
}

// Para otras paginas (Venus > Fondos): el fondo de la galeria elegido, cambiarlo y enterarse de los cambios.
export function currentWallpaperId() {
  return ap.background === 'wallpaper' ? ap.wallpaperId || null : null;
}

export function useWallpaper(id) {
  if (!getWallpaper(id)) return false;
  live.errors.delete(id);
  save({ appearance: { background: 'wallpaper', wallpaperId: id } });
  applyBackground();
  return true;
}

export function isLite() {
  return ap.lite;
}

// ---------- Fondos animados a demanda (modules/wallpapers.js) ----------
// No vienen en el instalador: el elegido se baja una vez. Mientras tanto, sin internet o en el modo liviano se ve su
// miniatura difuminada.
const live = { files: {}, downloads: new Map(), errors: new Set(), timer: 0 };

async function loadLiveFiles() {
  try {
    live.files = (await api.invoke('wallpapers:status')) || {};
  } catch (err) {
    console.warn('[appearance] fondos animados', err?.message || err);
  }
}

// state: 'ready' (con url), 'downloading' (con percent), 'error' o 'missing'; size en bytes si se conoce.
export function liveWallpaperState(id) {
  const info = live.files[id];
  const size = info?.size || 0;
  if (info?.path) return { state: 'ready', url: fileUrl(info.path), size };
  if (live.downloads.has(id)) return { state: 'downloading', percent: live.downloads.get(id), size };
  return { state: live.errors.has(id) ? 'error' : 'missing', size };
}

// Espera un momento: el que pasa por varios con las flechas no baja uno por cada uno.
function requestLiveWallpaper(id) {
  clearTimeout(live.timer);
  if (live.files[id]?.path || live.downloads.has(id) || live.errors.has(id)) return;
  live.timer = setTimeout(() => {
    if (currentWallpaperId() === id && !ap.lite) startLiveDownload(id);
  }, 500);
}

function startLiveDownload(id) {
  live.downloads.set(id, 0);
  api
    .invoke('wallpapers:ensure', id)
    .then(({ path }) => {
      live.files[id] = { ...live.files[id], path };
    })
    .catch((err) => {
      console.warn('[appearance] no se pudo bajar el fondo', id, err?.message || err);
      live.errors.add(id);
    })
    .finally(() => {
      live.downloads.delete(id);
      applyBackground();
      emit();
    });
  emit();
}

// Lo que se muestra de un fondo de la galería.
function wallpaperMedia(wallpaper) {
  if (!wallpaper.video) return { url: wallpaper.src, video: false };
  const state = ap.lite ? null : liveWallpaperState(wallpaper.id);
  if (state?.state === 'ready') return { url: state.url, video: true };
  return { url: wallpaper.thumb, video: false, soft: true };
}

export function useStars() {
  save({ appearance: { background: 'stars' } });
}

export function onAppearanceChange(fn) {
  return onChange(fn);
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
  return accentOf(a);
}

function reducedMotion() {
  return ap.lite || document.body.classList.contains('reduce-motion') || Boolean(reduceQuery?.matches);
}

function gameRunning() {
  return Object.values(store.running || {}).some((r) => r && r.state === 'running');
}

// ---------- Aplicar: color, esquema y paleta ----------
// Fondo sobre el que se comprueba la legibilidad del texto de la paleta: el elegido o el del esquema
function paletteBaseBg(sch = scheme) {
  return ap.palette.bg || engine.baseTokens(sch)['--bg-0'];
}

// Paleta lista para el motor (texto corregido si no se lee) y el hex corregido, si hizo falta
function effectivePalette(sch = scheme) {
  return legiblePalette(ap.palette, paletteBaseBg(sch));
}

function applyTheme() {
  scheme = effectiveScheme(ap);
  const root = document.documentElement;
  if (scheme === 'light') root.setAttribute('data-scheme', 'light');
  else root.removeAttribute('data-scheme');
  const { palette } = effectivePalette(scheme);
  const color = palette.accent || accentColor();
  const isDefault = color.toLowerCase() === PRESETS[0].color;
  const plain = isDefault && scheme === 'dark' && !paletteActive(palette);
  engine.setTheme(plain ? null : { accent: isDefault ? null : color, tint: ap.tint, scheme, palette: paletteActive(palette) ? palette : null });
  // el planeta del logo gira su tono para acompañar al acento (filtro hue-rotate)
  if (isDefault) {
    root.style.removeProperty('--ap-hue');
    root.style.removeProperty('--ap-sat');
  } else {
    const target = toHsl(parseColor(engine.legibleAccent(color, scheme === 'light')));
    const base = toHsl(parseColor(PRESETS[0].color));
    root.style.setProperty('--ap-hue', `${Math.round(target.h - base.h)}deg`);
    root.style.setProperty('--ap-sat', String(Math.round(Math.min(1.3, Math.max(0, target.s / base.s)) * 100) / 100));
  }
}

// ---------- Aplicar: boton Jugar ----------
// Color, texto y animacion con variables y atributos en <html> (styles/a11y.css); el sonido se avisa con el
// evento venus:ui-sound al hacer clic en .play-btn (otro modulo lo hace sonar).
function playInk(hex) {
  const c = parseColor(hex);
  const dark = parseColor('#2b1405');
  const light = parseColor('#fff8ee');
  return !c || contrast(c, dark) >= contrast(c, light) ? '#2b1405' : '#fff8ee';
}

function applyPlayButton() {
  const pb = ap.playButton;
  const root = document.documentElement;
  const custom = pb.color !== 'accent';
  root.toggleAttribute('data-play-color', custom);
  if (custom) {
    root.style.setProperty('--play-color', pb.color);
    root.style.setProperty('--play-ink', playInk(pb.color));
  } else {
    root.style.removeProperty('--play-color');
    root.style.removeProperty('--play-ink');
  }
  if (pb.label) {
    root.style.setProperty('--play-label', JSON.stringify(pb.label)); // cadena CSS con comillas y escapes validos
    root.setAttribute('data-play-label', '');
  } else {
    root.style.removeProperty('--play-label');
    root.removeAttribute('data-play-label');
  }
  const anim = ap.lite || pb.animation === 'none' ? '' : pb.animation;
  if (anim) root.setAttribute('data-play-anim', anim);
  else root.removeAttribute('data-play-anim');
}

function playSound() {
  const id = ap.playButton.sound;
  if (id === 'none') return;
  window.dispatchEvent(new CustomEvent('venus:ui-sound', { detail: { id } }));
}

// ---------- Temporadas ----------
// Al entrar en una fecha se guarda lo que habia (seasonalBackup) y se aplican el acento y el fondo de la
// temporada; al salir (o al apagar el ajuste) se restaura. venus:season avisa al arrancar y en cada cambio.
function checkSeason() {
  const want = ap.seasonal ? seasonFor(new Date()) : null;
  const backup = ap.seasonalBackup;
  const have = backup?.season || null;
  if (want !== have) {
    if (want) {
      const s = seasonById(want);
      const keep = backup || { accent: ap.accent, customColor: ap.customColor, background: ap.background, wallpaperId: ap.wallpaperId };
      const patch = { accent: 'custom', customColor: s.accent, seasonalBackup: { ...keep, season: want } };
      if (getWallpaper(s.wallpaper)) {
        patch.background = 'wallpaper';
        patch.wallpaperId = s.wallpaper;
      }
      save({ appearance: patch });
    } else {
      save({ appearance: { accent: backup.accent, customColor: backup.customColor, background: backup.background, wallpaperId: backup.wallpaperId, seasonalBackup: null } });
    }
  }
  if (want !== seasonAnnounced) {
    seasonAnnounced = want;
    window.dispatchEvent(new CustomEvent('venus:season', { detail: { id: want } }));
  }
}

// id de la temporada aplicada ahora (null si no hay o el ajuste esta apagado)
export function currentSeason() {
  return ap.seasonal ? ap.seasonalBackup?.season || null : null;
}

// ---------- Fondos rotativos ----------
export function rotateWallpaper() {
  const next = nextRotation(ap.rotation.ids, ap.wallpaperId);
  if (!next) return false;
  return useWallpaper(next);
}

function scheduleRotation() {
  const r = ap.rotation;
  const key = r.enabled && r.ids.length ? String(r.everyMin) : '';
  if (key === rotation.key) return;
  rotation.key = key;
  clearInterval(rotation.timer);
  rotation.timer = 0;
  if (key) {
    rotation.timer = setInterval(() => {
      if (ap.rotation.enabled) rotateWallpaper();
    }, r.everyMin * 60000);
  }
}

// Cada minuto: el modo automatico del tema claro y las fechas de temporada
function tick() {
  if (effectiveScheme(ap) !== scheme) {
    applyTheme();
    emit();
  }
  checkSeason();
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
    v.autoplay = !reducedMotion();
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
  const shown = wallpaper ? wallpaperMedia(wallpaper) : null;
  const url = shown?.url || (ap.background === 'image' && ap.bgFile ? fileUrl(ap.bgFile) : '');
  if (wallpaper?.video && !ap.lite) requestLiveWallpaper(wallpaper.id);
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
    const media = makeMedia(url, shown ? shown.video : isVideo(ap.bgFile));
    media.classList.toggle('ap-bg-soft', Boolean(shown?.soft));
    media.addEventListener(
      'error',
      () => {
        if (layer.dataset.src !== url) return;
        if (shown?.video && live.files[wallpaper.id]) {
          // El video ya no está (se limpió la caché, por ejemplo): se vuelve a bajar.
          live.files[wallpaper.id].path = null;
          applyBackground();
          emit();
          return;
        }
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
// Interfaz: atributos en <html> que cambian los tokens de main.css
function applyInterface() {
  const root = document.documentElement;
  root.dataset.uiRadius = ap.uiRadius;
  root.dataset.uiDensity = ap.uiDensity;
  root.dataset.uiSidebar = ap.uiSidebar;
  root.dataset.uiFont = ap.uiFont;
  root.style.setProperty('--ui-glass', String(ap.uiGlass / 100));
  root.toggleAttribute('data-ui-glassy', ap.uiGlass < 100);
  root.toggleAttribute('data-ui-lite', ap.lite);
  if (ap.uiFont === 'rounded') ensureCss('features/profile-fonts'); // Fredoka viene con las tipografias del perfil
}

function applyAll() {
  applyInterface();
  applyTheme();
  applyBackground();
  applyBranding();
  applyPlayButton();
  scheduleRotation();
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
  ({ a: ap, b: br, l: looks } = fromStore());
  await loadLiveFiles();
  api.on('wallpapers:progress', ({ id, percent }) => {
    if (!live.downloads.has(id)) return;
    live.downloads.set(id, percent);
    emit();
  });
  applyAll();
  engine.applyNow();
  registerCommands(appearanceCommands);
  // Temporada (avisa siempre al arrancar), fondo rotativo al abrir y revision por minuto
  checkSeason();
  if (ap.rotation.enabled && ap.rotation.onLaunch) rotateWallpaper();
  minuteTimer = setInterval(tick, 60000);
  // Sonido del boton Jugar (delegado: el boton lo dibuja pages/home.js)
  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target?.closest?.('.play-btn');
      if (!btn || btn.disabled || btn.classList.contains('stop') || btn.closest('.ap-play-preview')) return;
      playSound();
    },
    true,
  );

  store.on('settings', () => {
    const { a, b, l } = fromStore();
    const looksChanged = JSON.stringify(l) !== JSON.stringify(looks);
    if (looksChanged) looks = l;
    const changed = JSON.stringify(a) !== JSON.stringify(ap) || JSON.stringify(b) !== JSON.stringify(br);
    if (!changed) {
      if (looksChanged) emit();
      return;
    }
    if (a.bgFile !== ap.bgFile || a.background !== ap.background || a.wallpaperId !== ap.wallpaperId) bgError = false;
    const seasonalWas = ap.seasonal;
    ap = a;
    br = b;
    applyAll();
    if (seasonalWas !== ap.seasonal) checkSeason();
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
  for (const id of ['dark', 'light', 'auto']) {
    cmds.push({ id: `ap:scheme:${id}`, group: 'appearance', title: t('appearance.cmdScheme', { name: t(`appearance.scheme_${id}`) }), icon: id === 'light' ? 'sun' : id === 'dark' ? 'moon' : 'clock', state: ap.scheme === id, radio: true, keywords: t('appearance.kwScheme'), run: () => save({ appearance: { scheme: id } }) });
  }
  if (ap.rotation.enabled && ap.rotation.ids.length) cmds.push({ id: 'ap:rotate', group: 'appearance', title: t('appearance.cmdRotate'), icon: 'refresh', keywords: t('appearance.kwBackground'), run: () => rotateWallpaper() });
  for (const look of looks) {
    cmds.push({ id: `ap:look:${look.id}`, group: 'appearance', title: t('appearance.cmdLook', { name: look.name }), icon: 'sparkles', keywords: t('appearance.kwLook'), run: () => applyLook(look) });
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

// ---------- Looks guardados (settings.looks) ----------
function setLooks(list) {
  looks = looksCodec.normalizeLooks(list);
  emit();
  return store.setSettings({ looks }).catch((err) => fail(t('appearance.saveFailed'), err));
}

export function applyLook(look) {
  const l = looksCodec.normalizeLook(look);
  if (!l) return false;
  music.userPaused = false;
  bgError = false;
  save({ appearance: l.appearance, branding: l.branding });
  ok(t('appearance.lookApplied', { name: l.name }));
  return true;
}

async function saveCurrentLook() {
  if (looks.length >= looksCodec.MAX_LOOKS) {
    toast('info', t('appearance.looksFullTitle'), t('appearance.looksFullText', { max: looksCodec.MAX_LOOKS }));
    return;
  }
  const name = await promptDialog(t('appearance.lookSaveTitle'), t('appearance.lookName'), { placeholder: t('appearance.lookNamePlaceholder'), hint: t('appearance.lookSaveHint'), okText: t('appearance.lookSaveOk') });
  if (name === null) return;
  const look = looksCodec.lookFromSettings(appearanceSettings(), name);
  if (!look) {
    toast('bad', t('appearance.lookNameRequired'));
    return;
  }
  await setLooks([look, ...looks]);
  ok(t('appearance.lookSaved', { name: look.name }));
}

async function renameLook(look) {
  const name = await promptDialog(t('appearance.lookRenameTitle'), t('appearance.lookName'), { value: look.name, okText: t('appearance.lookRenameOk') });
  if (name === null) return;
  const clean = looksCodec.cleanLookName(name);
  if (!clean) {
    toast('bad', t('appearance.lookNameRequired'));
    return;
  }
  await setLooks(looks.map((l) => (l.id === look.id ? { ...l, name: clean } : l)));
}

async function deleteLook(look) {
  if (!(await confirmDialog(t('appearance.lookDeleteTitle'), t('appearance.lookDeleteText', { name: look.name }), { okText: t('appearance.lookDeleteOk'), danger: true }))) return;
  await setLooks(looks.filter((l) => l.id !== look.id));
}

async function shareLook(look) {
  try {
    await copyText(looksCodec.encodeLook(look), t('appearance.lookCopied'));
    if (look.appearance.background === 'image' || look.appearance.music.file) toast('info', t('appearance.lookShareLocalTitle'), t('appearance.lookShareLocalText'), 6000);
  } catch (err) {
    fail(t('appearance.lookShareFailed'), err);
  }
}

async function pasteLook() {
  const code = await promptDialog(t('appearance.lookPasteTitle'), t('appearance.lookPasteLabel'), { placeholder: `${looksCodec.PREFIX}…`, hint: t('appearance.lookPasteHint'), okText: t('appearance.lookPasteOk') });
  if (code === null) return;
  const r = looksCodec.decodeLook(code);
  if (!r.ok) {
    toast('bad', t('appearance.lookPasteFailed'), t(`appearance.lookCode_${r.code}`));
    return;
  }
  if (looks.length >= looksCodec.MAX_LOOKS) {
    toast('info', t('appearance.looksFullTitle'), t('appearance.looksFullText', { max: looksCodec.MAX_LOOKS }));
    return;
  }
  const look = looksCodec.normalizeLook({ ...r.look, id: looksCodec.newLookId(), createdAt: Date.now() });
  await setLooks([look, ...looks]);
  applyLook(look);
}

export function openAppearanceModal() {
  modal({ title: t('appearance.panelTitle'), body: appearancePanel(), size: 'wide' });
}

// ---------- Panel ----------
// El overlay es una ventana aparte con su propio ajuste: se apaga al activar el modo liviano y, si estaba prendido,
// vuelve a prenderse al salir. Mientras tanto se puede prender a mano en su página.
function setLite(on) {
  const overlayOn = store.settings?.overlay?.enabled !== false;
  const restore = !on && ap.liteOverlay;
  save({ appearance: on ? { lite: true, liteOverlay: overlayOn } : { lite: false, liteOverlay: false } });
  if ((on && overlayOn) || restore) store.setSettings({ overlay: { enabled: restore } }).catch((err) => console.warn('[appearance] overlay', err?.message || err));
}

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
  // La galería solo aparece si el launcher trae fondos (wallpapers.js: imágenes y animados).
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
    'aria-label': wallpaper.video ? `${wallpaper.name}, ${t('appearance.liveBadge')}` : wallpaper.name, 'aria-checked': 'false', tabindex: i === 0 ? 0 : -1,
    dataset: { id: wallpaper.id },
    onclick: () => useWallpaper(wallpaper.id),
  },
  h('img', { src: wallpaper.thumb, alt: '', loading: 'lazy', decoding: 'async', width: 320, height: 180 }),
  wallpaper.video ? h('span', { class: 'ap-wallpaper-live', 'aria-hidden': 'true' }, icon('play'), t('appearance.liveBadge')) : null,
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
  // Los fondos de Venus están en la página web: se bajan y se eligen con "Imagen o video".
  const moreBg = h('div', { class: 'ap-more-bg' },
    compact ? null : h('span', { class: 'ax-hint' }, t('appearance.moreBgSub')),
    h('button', { type: 'button', class: 'btn sm', title: compact ? t('appearance.moreBgSub') : null, onclick: openWallpapersPage }, icon('external'), t('appearance.moreBg')));
  const bgCard = card('image', t('appearance.panelBackground'), compact ? null : t('appearance.panelBackgroundSub'), bgSeg, galleryWrap, bgError_, bgControls, compact ? null : bgHint, moreBg);
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
    const applied = engine.legibleAccent(ap.customColor, scheme === 'light');
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
    const liveState = wallpaper?.video && !ap.lite ? liveWallpaperState(wallpaper.id) : null;
    const galleryText = !wallpaper
      ? t('appearance.galleryChoose')
      : liveState?.state === 'downloading'
        ? t('appearance.liveDownloading', { percent: liveState.percent })
        : liveState?.state === 'error'
          ? t('appearance.liveError')
          : t('appearance.gallerySelected', { name: wallpaper.name });
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
      const shown = wallpaper ? wallpaperMedia(wallpaper) : null;
      const url = shown?.url || fileUrl(ap.bgFile);
      const video = shown ? shown.video : isVideo(ap.bgFile);
      if (bgThumb.dataset.src !== url) {
        bgThumb.dataset.src = url;
        const media = makeMedia(url, video);
        if (media.tagName === 'VIDEO') media.autoplay = false;
        media.classList.toggle('ap-bg-soft', Boolean(shown?.soft));
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

// ---------- Tarjetas de la 3.1 (cada una devuelve { el, sync }) ----------
function segmented(label, options, onPick, { labelOf, iconOf } = {}) {
  const seg = h('div', { class: 'segmented ax-seg', role: 'group', 'aria-label': label });
  const btns = options.map((o) => h('button', { type: 'button', dataset: { value: o }, onclick: () => onPick(o) }, iconOf ? icon(iconOf(o)) : null, labelOf ? labelOf(o) : o));
  seg.append(...btns);
  return {
    el: seg,
    set(v) {
      btns.forEach((b) => {
        const on = b.dataset.value === String(v);
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', String(on));
      });
    },
  };
}

const iconBtn = (name, title, onclick, cls) => h('button', { type: 'button', class: ['icon-btn sm', cls], title, 'aria-label': title, onclick }, icon(name));
const colorHex = (css) => toHex(parseColor(css) || parseColor('#000000'));

// Color propio con un selector del sistema: muestra el valor elegido o "el de Venus", con un boton para volver
function colorItem(name, { onPick, onClear, clearLabel }) {
  const input = h('input', { type: 'color', 'aria-label': name });
  input.addEventListener('input', () => onPick(input.value.toLowerCase()));
  const swatch = h('label', { class: 'ap-pal-swatch' }, input);
  const value = h('span', { class: 'ap-pal-value' });
  const clear = h('button', { type: 'button', class: 'ap-pal-clear', title: clearLabel, 'aria-label': clearLabel, onclick: onClear }, icon('x'));
  const el = h('div', { class: 'ap-pal-item' }, swatch, h('div', { class: 'ap-pal-text' }, h('span', { class: 'ap-pal-name' }, name), value), clear);
  return {
    el,
    set(custom, shown, text) {
      swatch.style.setProperty('--pal', shown);
      if (document.activeElement !== input && input.value.toLowerCase() !== shown) input.value = shown;
      value.textContent = text;
      el.classList.toggle('ap-pal-custom', Boolean(custom));
      clear.hidden = !custom;
    },
  };
}

// Mis looks: guardar, aplicar, renombrar, borrar, compartir y pegar un codigo
function looksCard() {
  const list = h('div', { class: 'ap-looks-list', role: 'list', 'aria-label': t('appearance.panelLooks') });
  const empty = h('div', { class: 'ax-hint' }, icon('info'), t('appearance.looksEmpty'));
  const count = h('span', { class: 'ax-hint' });
  const saveBtn = h('button', { type: 'button', class: 'btn sm', onclick: saveCurrentLook }, icon('save'), t('appearance.lookSave'));
  const pasteBtn = h('button', { type: 'button', class: 'btn sm ghost', onclick: pasteLook }, icon('download'), t('appearance.lookPaste'));
  const el = card('sparkles', t('appearance.panelLooks'), t('appearance.panelLooksSub'), h('div', { class: 'ap-looks-head' }, saveBtn, pasteBtn, h('span', { class: 'spacer' }), count), list, empty);
  let lastKey = null;
  const sync = () => {
    count.textContent = t('appearance.looksCount', { count: looks.length, max: looksCodec.MAX_LOOKS });
    saveBtn.disabled = looks.length >= looksCodec.MAX_LOOKS;
    empty.hidden = looks.length > 0;
    list.hidden = !looks.length;
    const key = looks.map((l) => `${l.id}:${l.name}`).join('|');
    if (key === lastKey) return;
    lastKey = key;
    mount(list, looks.map(lookRow));
  };
  return { el, sync };
}

function lookRow(look) {
  const a = look.appearance;
  const wp = a.background === 'wallpaper' ? getWallpaper(a.wallpaperId) : null;
  const sw = h('span', { class: 'ap-look-sw', style: { '--lk-bg': a.palette.bg || (a.scheme === 'light' ? '#f4ece2' : '#1b130e'), '--lk-accent': a.palette.accent || accentOf(a) }, 'aria-hidden': 'true' }, wp ? h('img', { src: wp.thumb, alt: '', loading: 'lazy' }) : null, h('i'));
  const meta = [fmtDate(look.createdAt), a.accent === 'custom' ? a.palette.accent || a.customColor : t(`appearance.preset_${a.accent}`), a.scheme !== 'dark' ? t(`appearance.scheme_${a.scheme}`) : null, look.branding.name || null].filter(Boolean).join(' · ');
  return h(
    'div',
    { class: 'ap-look', role: 'listitem' },
    sw,
    h('div', { class: 'ap-look-main' }, h('div', { class: 'ap-look-name', title: look.name }, look.name), h('div', { class: 'ap-look-meta', title: meta }, meta)),
    h(
      'div',
      { class: 'ap-look-actions' },
      h('button', { type: 'button', class: 'btn sm tonal', 'aria-label': t('appearance.lookApplyNamed', { name: look.name }), onclick: () => applyLook(look) }, icon('check'), t('appearance.lookApply')),
      iconBtn('copy', t('appearance.lookShare'), () => shareLook(look)),
      iconBtn('edit', t('appearance.lookRename'), () => renameLook(look)),
      iconBtn('trash', t('appearance.lookDelete'), () => deleteLook(look), 'danger'),
    ),
  );
}

// Editor de colores: fondo, tarjetas, texto, bordes y acento, con el texto corregido si no se lee
function paletteCard() {
  const items = PALETTE_KEYS.map((key) => ({
    key,
    item: colorItem(t(`appearance.pal_${key}`), {
      onPick: (v) => save({ appearance: { palette: { ...ap.palette, [key]: v } } }, 300),
      onClear: () => save({ appearance: { palette: { ...ap.palette, [key]: null } } }),
      clearLabel: t('appearance.palClearNamed', { name: t(`appearance.pal_${key}`) }),
    }),
  }));
  const hint = h('div', { class: 'ax-hint ap-legible' });
  const resetBtn = h('button', { type: 'button', class: 'btn sm ghost', onclick: () => save({ appearance: { palette: { bg: null, surface: null, text: null, border: null, accent: null } } }) }, icon('undo'), t('appearance.palReset'));
  const el = card('contrast', t('appearance.panelPalette'), t('appearance.panelPaletteSub'), h('div', { class: 'ap-palette-grid' }, items.map((i) => i.item.el)), hint, h('div', { class: 'row wrap' }, resetBtn, h('span', { class: 'ax-hint' }, t('appearance.palHint'))));
  const sync = () => {
    const base = engine.baseTokens(scheme);
    const defaults = { bg: base['--bg-0'], surface: base['--surface'], text: base['--text'], border: base['--border'], accent: accentColor() };
    const { palette, adjustedText } = effectivePalette();
    for (const { key, item } of items) {
      const custom = ap.palette[key];
      const shown = key === 'text' && palette.text ? palette.text : custom || colorHex(defaults[key]);
      item.set(custom, shown, custom ? shown : t('appearance.palDefault'));
    }
    hint.hidden = !adjustedText;
    if (adjustedText) hint.replaceChildren(icon('info'), t('appearance.palAdjusted', { color: adjustedText }));
    resetBtn.disabled = !paletteActive(ap.palette);
  };
  return { el, sync };
}

// Tema claro u oscuro (con horario automatico) y temas de temporada
function schemeCard() {
  const seg = segmented(t('appearance.schemeLabel'), ['dark', 'light', 'auto'], (v) => save({ appearance: { scheme: v } }), {
    labelOf: (o) => t(`appearance.scheme_${o}`),
    iconOf: (o) => (o === 'light' ? 'sun' : o === 'dark' ? 'moon' : 'clock'),
  });
  const ids = { from: fieldId('light-from'), to: fieldId('light-to') };
  const from = h('input', { type: 'time', class: 'input', id: ids.from, value: ap.autoLightFrom, step: 300 });
  const to = h('input', { type: 'time', class: 'input', id: ids.to, value: ap.autoLightTo, step: 300 });
  from.addEventListener('change', () => {
    if (from.value) save({ appearance: { autoLightFrom: from.value } });
  });
  to.addEventListener('change', () => {
    if (to.value) save({ appearance: { autoLightTo: to.value } });
  });
  const times = h('div', { class: 'ap-scheme-times' }, h('label', { for: ids.from }, t('appearance.autoFrom')), from, h('label', { for: ids.to }, t('appearance.autoTo')), to);
  const autoHint = h('div', { class: 'ax-hint' });
  const seasonal = toggleRow(t('appearance.seasonalTitle'), t('appearance.seasonalSub'), ap.seasonal, (v) => {
    save({ appearance: { seasonal: v } });
    checkSeason();
  });
  const chips = h('div', { class: 'ap-season-row' });
  const el = card(
    'sun',
    t('appearance.panelScheme'),
    t('appearance.panelSchemeSub'),
    h('div', { class: 'ap-ui-row' }, h('span', { class: 'ap-ui-label' }, t('appearance.schemeLabel')), seg.el),
    times,
    autoHint,
    h('div', { class: 'divider' }),
    h('div', { class: 'ax-toggles' }, seasonal.el),
    chips,
  );
  let lastSeason = null;
  const sync = () => {
    seg.set(ap.scheme);
    times.hidden = ap.scheme !== 'auto';
    autoHint.hidden = ap.scheme !== 'auto';
    if (document.activeElement !== from) from.value = ap.autoLightFrom;
    if (document.activeElement !== to) to.value = ap.autoLightTo;
    autoHint.replaceChildren(icon(scheme === 'light' ? 'sun' : 'moon'), t(scheme === 'light' ? 'appearance.autoNowLight' : 'appearance.autoNowDark'));
    seasonal.set(ap.seasonal);
    const active = currentSeason();
    if (active !== lastSeason) {
      lastSeason = active;
      mount(chips, SEASONS.map((s) => h('span', { class: ['ap-season-chip', active === s.id && 'on'] }, h('i', { style: { '--sw': s.accent }, 'aria-hidden': 'true' }), t(`appearance.season_${s.id}`), h('span', { class: 'muted' }, t(`appearance.seasonDates_${s.id}`)))));
    }
  };
  return { el, sync };
}

// Fondos rotativos: varios fondos de la galeria que cambian cada N minutos o al abrir
function openRotationPicker() {
  const count = h('span', { class: 'ax-hint' });
  const btns = WALLPAPERS.map((w) =>
    h(
      'button',
      {
        type: 'button',
        class: 'ap-wallpaper',
        role: 'checkbox',
        'aria-checked': 'false',
        title: w.name,
        'aria-label': w.video ? `${w.name}, ${t('appearance.liveBadge')}` : w.name,
        dataset: { id: w.id },
        onclick: () => {
          const ids = ap.rotation.ids;
          const next = ids.includes(w.id) ? ids.filter((x) => x !== w.id) : [...ids, w.id];
          save({ appearance: { rotation: { ...ap.rotation, ids: next } } });
          refresh();
        },
      },
      h('img', { src: w.thumb, alt: '', loading: 'lazy', decoding: 'async', width: 320, height: 180 }),
      w.video ? h('span', { class: 'ap-wallpaper-live', 'aria-hidden': 'true' }, icon('play'), t('appearance.liveBadge')) : null,
      h('span', { class: 'ap-wallpaper-name', 'aria-hidden': 'true' }, w.name),
      h('span', { class: 'ap-wallpaper-check', 'aria-hidden': 'true' }, icon('check')),
    ),
  );
  const refresh = () => {
    const ids = ap.rotation.ids;
    btns.forEach((b) => {
      const on = ids.includes(b.dataset.id);
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    });
    count.textContent = t('appearance.rotCount', { count: ids.length });
  };
  refresh();
  const clearBtn = h('button', { type: 'button', class: 'btn sm ghost', onclick: () => { save({ appearance: { rotation: { ...ap.rotation, ids: [] } } }); refresh(); } }, icon('x'), t('appearance.rotClear'));
  const m = modal({
    title: t('appearance.rotPickTitle'),
    subtitle: t('appearance.rotPickSub'),
    icon: 'image',
    size: 'wide',
    body: h('div', {}, h('div', { class: 'ap-rot-head' }, count, clearBtn), h('div', { class: 'ap-wallpapers ap-rot-pick', role: 'group', 'aria-label': t('appearance.rotPickTitle') }, btns)),
    footer: [h('button', { type: 'button', class: 'btn primary', onclick: () => m.close() }, icon('check'), t('appearance.rotDone'))],
  });
}

function rotationCard() {
  const enabled = toggleRow(t('appearance.rotTitle'), t('appearance.rotSub'), ap.rotation.enabled, (v) => save({ appearance: { rotation: { ...ap.rotation, enabled: v } } }));
  const chips = h('div', { class: 'ap-rot-chips' });
  const empty = h('div', { class: 'ax-hint' }, icon('info'), t('appearance.rotEmpty'));
  const pickBtn = h('button', { type: 'button', class: 'btn sm', onclick: openRotationPicker }, icon('image'), t('appearance.rotPick'));
  const nowBtn = h('button', { type: 'button', class: 'btn sm ghost', onclick: () => rotateWallpaper() }, icon('refresh'), t('appearance.rotNow'));
  const every = segmented(t('appearance.rotEvery'), ROTATION_PRESETS.map(String), (v) => save({ appearance: { rotation: { ...ap.rotation, everyMin: Number(v) } } }), { labelOf: (o) => t('appearance.rotMinutes', { n: o }) });
  const onLaunch = toggleRow(t('appearance.rotOnLaunch'), t('appearance.rotOnLaunchSub'), ap.rotation.onLaunch, (v) => save({ appearance: { rotation: { ...ap.rotation, onLaunch: v } } }));
  const liteHint = h('div', { class: 'ax-hint' }, icon('info'), t('appearance.rotLiteHint'));
  const el = card(
    'refresh',
    t('appearance.panelRotation'),
    t('appearance.panelRotationSub'),
    h('div', { class: 'ax-toggles' }, enabled.el),
    chips,
    empty,
    h('div', { class: 'row wrap' }, pickBtn, nowBtn),
    h('div', { class: 'ap-ui-row' }, h('span', { class: 'ap-ui-label' }, t('appearance.rotEvery')), every.el),
    h('div', { class: 'ax-toggles' }, onLaunch.el),
    liteHint,
  );
  let lastKey = null;
  const sync = () => {
    const ids = ap.rotation.ids;
    enabled.set(ap.rotation.enabled);
    empty.hidden = ids.length > 0;
    chips.hidden = !ids.length;
    nowBtn.disabled = !ids.length;
    every.set(ROTATION_PRESETS.includes(ap.rotation.everyMin) ? ap.rotation.everyMin : '');
    onLaunch.set(ap.rotation.onLaunch);
    liteHint.hidden = !(ap.lite && ids.some((id) => getWallpaper(id)?.video));
    const current = ap.background === 'wallpaper' ? ap.wallpaperId : '';
    const key = `${ids.join('|')}#${current}`;
    if (key === lastKey) return;
    lastKey = key;
    mount(
      chips,
      ids.map((id) => {
        const w = getWallpaper(id);
        return h(
          'span',
          { class: ['ap-rot-chip', current === id && 'current'] },
          h('img', { src: w.thumb, alt: '', loading: 'lazy' }),
          h('span', { class: 'ellipsis', title: w.name }, w.name),
          iconBtn('x', t('appearance.rotRemove', { name: w.name }), () => save({ appearance: { rotation: { ...ap.rotation, ids: ap.rotation.ids.filter((x) => x !== id) } } })),
        );
      }),
    );
  };
  return { el, sync };
}

// Boton Jugar: color, texto, animacion y sonido (el boton real lo dibuja Inicio; aca hay una vista previa)
function playCard() {
  const previewText = h('span', {});
  const previewBtn = h('span', { class: 'play-btn' }, icon('play'), previewText);
  const preview = h('div', { class: 'ap-play-preview', 'aria-hidden': 'true', inert: '' }, previewBtn);
  const color = colorItem(t('appearance.playColor'), {
    onPick: (v) => save({ appearance: { playButton: { ...ap.playButton, color: v } } }, 300),
    onClear: () => save({ appearance: { playButton: { ...ap.playButton, color: 'accent' } } }),
    clearLabel: t('appearance.playColorAccent'),
  });
  const labelId = fieldId('play-label');
  const labelInput = h('input', { class: 'input', id: labelId, maxlength: PLAY_LABEL_MAX, placeholder: t('appearance.playLabelPlaceholder'), value: ap.playButton.label, autocomplete: 'off', spellcheck: 'false' });
  labelInput.addEventListener('input', () => save({ appearance: { playButton: { ...ap.playButton, label: cleanLabel(labelInput.value) } } }, 400));
  const anim = segmented(t('appearance.playAnim'), PLAY_ANIMATIONS, (v) => save({ appearance: { playButton: { ...ap.playButton, animation: v } } }), { labelOf: (o) => t(`appearance.playAnim_${o}`) });
  const sound = segmented(
    t('appearance.playSound'),
    PLAY_SOUNDS,
    (v) => {
      save({ appearance: { playButton: { ...ap.playButton, sound: v } } });
      playSound();
    },
    { labelOf: (o) => t(`appearance.playSound_${o}`) },
  );
  const testBtn = h('button', { type: 'button', class: 'btn sm ghost', onclick: playSound }, icon('volume'), t('appearance.playSoundTest'));
  const liteHint = h('div', { class: 'ax-hint' }, icon('info'), t('appearance.playLiteHint'));
  const el = card(
    'play',
    t('appearance.panelPlay'),
    t('appearance.panelPlaySub'),
    preview,
    h('div', { class: 'ap-play-grid' }, color.el, h('div', { class: 'field' }, h('label', { for: labelId }, t('appearance.playLabel')), labelInput, h('div', { class: 'field-help' }, t('appearance.playLabelHint', { max: PLAY_LABEL_MAX })))),
    h('div', { class: 'ap-ui-row' }, h('span', { class: 'ap-ui-label' }, t('appearance.playAnim')), anim.el),
    h('div', { class: 'ap-ui-row' }, h('span', { class: 'ap-ui-label' }, t('appearance.playSound')), h('div', { class: 'row wrap' }, sound.el, testBtn)),
    liteHint,
  );
  const sync = () => {
    const pb = ap.playButton;
    previewText.textContent = pb.label || t('appearance.previewPlay');
    const custom = pb.color !== 'accent';
    color.set(custom, custom ? pb.color : accentColor(), custom ? pb.color : t('appearance.playColorAccent'));
    if (document.activeElement !== labelInput) labelInput.value = pb.label;
    anim.set(pb.animation);
    sound.set(pb.sound);
    testBtn.disabled = pb.sound === 'none';
    liteHint.hidden = !(ap.lite && pb.animation !== 'none');
  };
  return { el, sync };
}

function buildPanel(root) {
  if (!started) ({ a: ap, b: br, l: looks } = fromStore());

  const { colorCard, bgCard, sync: syncVisuals } = createAppearanceControls();
  const looksC = looksCard();
  const paletteC = paletteCard();
  const schemeC = schemeCard();
  const rotationC = rotationCard();
  const playC = playCard();

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
        save({ appearance: appearanceDefaults(), branding: { ...BRANDING_DEFAULTS, server } });
        nameInput.value = '';
        subInput.value = BRANDING_DEFAULTS.subtitle;
      },
    },
    icon('undo'),
    t('appearance.reset'),
  );

  // Interfaz: bordes, densidad, menu lateral, tipografia y transparencia
  const uiRow = (key, options) => {
    const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': t(`appearance.ui_${key}`) });
    const draw = () =>
      mount(
        seg,
        options.map((o) => h('button', { type: 'button', class: ap[key] === o ? 'active' : '', 'aria-pressed': String(ap[key] === o), onclick: () => (save({ appearance: { [key]: o } }), draw()) }, t(`appearance.ui_${key}_${o}`))),
      );
    draw();
    return h('div', { class: 'ap-ui-row' }, h('span', { class: 'ap-ui-label' }, t(`appearance.ui_${key}`)), seg);
  };
  const glass = rangeField(t('appearance.ui_uiGlass'), { min: 40, max: 100, step: 5, value: ap.uiGlass, format: (v) => `${v} %`, onInput: (v) => save({ appearance: { uiGlass: v } }, 200) });
  const lite = toggleRow(t('appearance.liteTitle'), t('appearance.liteSub'), ap.lite, setLite);
  const uiCard = card(
    'sliders',
    t('appearance.panelInterface'),
    t('appearance.panelInterfaceSub'),
    lite.el,
    uiRow('uiRadius', ['sharp', 'normal', 'round']),
    uiRow('uiDensity', ['compact', 'normal', 'spacious']),
    uiRow('uiSidebar', ['full', 'icons']),
    uiRow('uiFont', ['outfit', 'system', 'rounded', 'mono']),
    glass.el || glass,
  );

  const extra = extraCards.map((fn) => { try { return fn(); } catch (err) { console.warn('[appearance] tarjeta', err?.message || err); return null; } }).filter(Boolean);
  mount(root, looksC.el, colorCard, paletteC.el, schemeC.el, bgCard, rotationC.el, uiCard, ...extra, brandCard, playC.el, musicCard, h('div', { class: 'ax-panel-foot' }, h('span', { class: 'ax-hint' }, t('appearance.liveNote')), resetBtn));

  // --- Sincronizar ---
  const sync = () => {
    syncVisuals();
    looksC.sync();
    paletteC.sync();
    schemeC.sync();
    rotationC.sync();
    playC.sync();

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
