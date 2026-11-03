// Decoración (3.1): partículas sobre el fondo, sonidos de la interfaz, pantalla de inicio propia y cursores
// pixel art. Ajustes en settings.decor (decor/settings.js, todo apagado por defecto). La tarjeta va en
// Ajustes > Apariencia debajo de "Interfaz" (registerAppearanceCard de appearance.js). Todo respeta el modo
// liviano (html[data-ui-lite]) y el movimiento reducido (reducedMotion() de ui.js): sin partículas ni animaciones.
// Eventos de window que escucha: 'venus:season' ({ detail: { id: 'halloween' | 'christmas' | 'newyear' | null } })
// y 'venus:ui-sound' ({ detail: { id: 'click' | 'whoosh' | 'bell' } }, lo manda el botón Jugar).
// Contrato: startup() (idempotente), playUiSound(id) (suena aunque los sonidos de la interfaz estén apagados),
// decorSettings(), saveDecor(patch, delay), onDecorChange(fn) -> off, currentSeason(), previewSplash(),
// previewSound(pack, id).
import { ensureCss, reducedMotion, fail } from '../ui.js';
import { store } from '../store.js';
import { t, loadNs, onLanguageChange } from '../i18n.js';
import { registerAppearanceCard, brandingView } from '../appearance.js';
import { normalizeDecor, mergeDecor, resolveParticles, seasonId } from './decor/settings.js';
import { soundSpec, uiSoundSpec } from './decor/packs.js';
import * as particles from './decor/particles.js';
import * as sounds from './decor/sounds.js';
import { applyCursor } from './decor/cursors.js';
import { showSplash } from './decor/splash.js';
import { decorCard } from './decor/panel.js';

const S = {
  started: false,
  cur: normalizeDecor(),
  season: null, // temporada vigente (venus:season) o null
  pending: {}, // cambios todavía no escritos
  inFlight: {}, // cambios que se están escribiendo
  saveTimer: 0,
  activeSave: null,
  listeners: new Set(),
};

// ---------- Ajustes ----------
function fromStore() {
  return normalizeDecor(mergeDecor(mergeDecor(store.settings?.decor, S.inFlight), S.pending));
}

export function decorSettings() {
  return normalizeDecor(S.cur);
}

export function currentSeason() {
  return S.season;
}

export function onDecorChange(fn) {
  S.listeners.add(fn);
  return () => S.listeners.delete(fn);
}

function emit() {
  for (const fn of S.listeners) {
    try {
      fn();
    } catch (err) {
      console.error('[decor]', err);
    }
  }
}

// Guarda un parche de settings.decor: se aplica al instante y se escribe con una pequeña espera (deslizadores,
// textos). Las escrituras van en serie para que una respuesta vieja no pise una elección más reciente.
export function saveDecor(patch, delay = 0) {
  S.pending = mergeDecor(S.pending, patch);
  S.cur = normalizeDecor(mergeDecor(S.cur, patch));
  applyAll();
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => {
    S.saveTimer = 0;
    flush().catch((err) => fail(t('decor.saveFailed'), err));
  }, delay);
}

function flush() {
  if (S.activeSave) return S.activeSave;
  S.activeSave = (async () => {
    while (Object.keys(S.pending).length) {
      const p = S.pending;
      S.inFlight = p;
      S.pending = {};
      try {
        await store.setSettings({ decor: p });
      } catch (err) {
        S.pending = mergeDecor(p, S.pending);
        throw err;
      } finally {
        S.inFlight = {};
      }
    }
  })().finally(() => {
    S.activeSave = null;
  });
  return S.activeSave;
}

// ---------- Aplicar ----------
function gameRunning() {
  return Object.values(store.running || {}).some((r) => r && r.state === 'running');
}

// 'run': animar · 'freeze': dejar el último cuadro quieto (ventana oculta o juego abierto) · 'clear': esconder
// (modo liviano o movimiento reducido: reducedMotion() incluye html[data-ui-lite] y body.reduce-motion).
function particleGate() {
  if (reducedMotion()) return 'clear';
  if (document.hidden || gameRunning()) return 'freeze';
  return 'run';
}

function applyParticles() {
  const { kind } = resolveParticles(S.cur, S.season);
  particles.set(kind, S.cur.density);
  particles.refresh();
}

function applyAll() {
  applyParticles();
  applyCursor(S.cur.cursor);
  emit();
}

// ---------- Sonidos ----------
// Sonido pedido por el botón Jugar u otro módulo ('click', 'whoosh' o 'bell'): suena aunque los sonidos de la
// interfaz estén apagados, al volumen elegido.
export function playUiSound(id) {
  const voices = uiSoundSpec(S.cur.sounds.pack, id);
  if (!voices) return false;
  return sounds.playVoices(voices, S.cur.sounds.volume);
}

// Para la tarjeta de Ajustes: escuchar un pack aunque los sonidos estén apagados.
export function previewSound(pack, id) {
  return sounds.playVoices(soundSpec(pack, id), S.cur.sounds.volume);
}

// ---------- Pantalla de inicio ----------
function splashView() {
  const v = brandingView();
  return { style: S.cur.splash.style, text: S.cur.splash.text, logoSrc: v.logoSrc, name: v.name, sub: v.sub, pixel: v.pixel };
}

export function previewSplash() {
  showSplash(splashView());
}

// Espera a que la pantalla de carga de index.html se esté yendo (o a que no exista), como mucho 12 s.
function bootGone() {
  const boot = document.getElementById('boot');
  if (!boot || boot.classList.contains('out')) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      mo.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const mo = new MutationObserver(() => {
      if (!boot.isConnected || boot.classList.contains('out')) finish();
    });
    mo.observe(boot, { attributes: true, attributeFilter: ['class'] });
    mo.observe(document.body, { childList: true });
    const timer = setTimeout(finish, 12000);
  });
}

const inWelcome = () => document.body.classList.contains('onboarding') || location.hash.startsWith('#/welcome');

async function startupSplash() {
  if (!S.cur.splash.enabled || store.info?.devshot || inWelcome()) return;
  await bootGone();
  if (!S.cur.splash.enabled || inWelcome()) return;
  showSplash(splashView());
}

// ---------- Arranque ----------
export async function startup() {
  if (S.started) return;
  S.started = true;
  ensureCss('features/decor');
  try {
    await loadNs('decor');
  } catch (err) {
    console.warn('[decor] i18n', err?.message || err);
  }
  if (!store.settings) await store.refreshSettings().catch(() => null);
  S.cur = fromStore();
  particles.init({ gate: particleGate });
  sounds.init({ getSounds: () => S.cur.sounds });
  const ctx = {
    get: () => S.cur,
    save: saveDecor,
    onChange: onDecorChange,
    season: () => S.season,
    previewSplash,
    previewSound,
  };
  registerAppearanceCard(() => decorCard(ctx));
  applyAll();

  store.on('settings', () => {
    const next = fromStore();
    if (JSON.stringify(next) === JSON.stringify(S.cur)) return;
    S.cur = next;
    applyAll();
  });
  store.on('running', particles.refresh);
  document.addEventListener('visibilitychange', particles.refresh);
  // movimiento reducido (body.reduce-motion) y modo liviano (html[data-ui-lite]) cambian en vivo
  new MutationObserver(particles.refresh).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(particles.refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui-lite'] });
  window.addEventListener('venus:season', (e) => {
    const id = seasonId(e?.detail?.id);
    if (id === S.season) return;
    S.season = id;
    applyParticles();
    emit();
  });
  window.addEventListener('venus:ui-sound', (e) => {
    playUiSound(e?.detail?.id);
  });
  onLanguageChange(emit);
  startupSplash().catch((err) => console.warn('[decor] pantalla de inicio', err?.message || err));
}
