// Novedades de Venus 4.5: recorrido de instancias, juego, social, clips y conexiones opcionales.
// Se muestra una vez por versión, después de la bienvenida; también se abre desde Ajustes → Acerca de.
// startup(), openWhatsNew({ start?, only? }) y whatsNewButton({ className? }).
import { h, icon, mount, modal, ensureCss, registerIcons, reducedMotion } from '../ui.js';
import { store } from '../store.js';
import { t, loadNs, has } from '../i18n.js';
import { navigate } from '../app.js';

const NS = 'whatsnew';
export const TOUR_VERSION = '4.5.0';
const FULL_TOUR_VERSION = '4.5.0'; // quien ya vio esta versión del recorrido no lo vuelve a ver entero
const CHANGES_SLIDE = 'v45changes';

registerIcons({
  wnBrush: '<path d="m14.622 17.897-10.68-2.913"/><path d="M18.376 2.622a1 1 0 1 1 3.002 3.002L17.36 9.643a.5.5 0 0 0 0 .707l.944.944a2.41 2.41 0 0 1 0 3.408l-.944.944a.5.5 0 0 1-.707 0L8.354 7.348a.5.5 0 0 1 0-.707l.944-.944a2.41 2.41 0 0 1 3.408 0l.944.944a.5.5 0 0 0 .707 0z"/><path d="M9 8c-1.804 2.71-3.97 3.46-6.583 3.948a.507.507 0 0 0-.302.819l7.32 8.883a1 1 0 0 0 1.185.204C12.735 20.405 16 16.792 16 15"/>',
  wnPoint: '<circle cx="12" cy="12" r="5.5"/><path d="M17.3 9.2c3-.9 4.9-.7 5.2.3.5 1.7-4.1 5-10.2 7.4S1.8 20.1 1.4 18.5c-.3-1 1.1-2.4 3.8-3.8"/>',
  wnBadge: '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
});

// Abre la primera función que exista de otros módulos ([[carga, [nombres]], ...]); si ninguna está, va a la ruta.
async function tryOpen(candidates, fallback) {
  for (const [load, names] of candidates) {
    try {
      const m = await load();
      const fn = names.map((n) => m?.[n]).find((f) => typeof f === 'function');
      if (fn) {
        await fn();
        return;
      }
    } catch (err) {
      console.warn('[whatsnew]', err?.message || err);
    }
  }
  navigate(fallback);
}

const SLIDES = [
  { id: 'intro', icon: 'sparkles' },
  { id: 'v45instances', art: 'party', icon: 'layers', go: () => navigate('versions') },
  { id: 'v45play', art: 'overlay', icon: 'gamepad', go: () => navigate('settings/ingame') },
  { id: 'v45social', art: 'profiles', icon: 'users', go: () => navigate('communities') },
  { id: 'v45clips', art: 'clips', icon: 'camera', go: () => navigate('clips') },
  { id: CHANGES_SLIDE, art: 'intro', icon: 'info', bullets: [3], go: () => navigate('settings/privacy') },
];

// "2.0.0", "2.0.0-beta.1" o "v2.1" -> [2, 0, 0]
function parts(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}
export function compareVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
// La versión instalada ya trae el recorrido y todavía no se vio.
export function shouldShow(appVersion, seen) {
  return compareVersions(appVersion, TOUR_VERSION) >= 0 && (!seen || compareVersions(seen, TOUR_VERSION) < 0);
}

let readyPromise = null;
function prepare() {
  ensureCss('features/whatsnew');
  if (!readyPromise) readyPromise = loadNs(NS).catch((err) => console.warn('[whatsnew] textos', err));
  return readyPromise;
}

// ---------- Dibujos de cada pantalla (solo formas con los tokens del tema; nada de imágenes de afuera) ----------
// Las clases de modificadores van sin prefijo en el código y se les agrega "wn-" acá (wn-dim, wn-w70...).
const i = (cls, ...kids) => h('i', { class: cls.split(' ').filter(Boolean).map((c) => (c.startsWith('wn-') ? c : `wn-${c}`)).join(' ') }, ...kids);
function art(id) {
  const scene = (...kids) => h('div', { class: `wn-art wn-art-${id}`, 'aria-hidden': 'true' }, h('div', { class: 'wn-glow' }), ...kids);
  if (id === 'intro') {
    return scene(i('orbit'), i('orbit orbit-2'), h('img', { class: 'wn-logo', src: 'assets/logo-256.png', alt: '' }), h('span', { class: 'wn-ver' }, '4.5'), i('spark s1'), i('spark s2'), i('spark s3'));
  }
  if (id === 'music') {
    return scene(
      h('div', { class: 'wn-mock wn-player' }, i('cover', icon('music')), h('div', { class: 'wn-lines' }, i('line w70'), i('line w45 dim')), h('div', { class: 'wn-progress' }, i('fill')), h('div', { class: 'wn-controls' }, i('ctl ctl-back', icon('skipForward')), i('ctl ctl-main', icon('pause')), i('ctl', icon('skipForward')))),
      h('div', { class: 'wn-eq' }, i('bar'), i('bar'), i('bar'), i('bar'), i('bar')),
    );
  }
  if (id === 'overlay') {
    return scene(h('div', { class: 'wn-mock wn-game' }, i('sky'), i('ground'), i('hotbar'), h('div', { class: 'wn-toast' }, i('dot'), h('div', { class: 'wn-lines' }, i('line w80'), i('line w50 dim'))), h('div', { class: 'wn-voice' }, i('av'), i('av speaking'), i('av'))));
  }
  if (id === 'profiles') {
    return scene(h('div', { class: 'wn-mock wn-profile' }, i('banner'), i('avatar', icon('user')), i('name'), i('line w45 dim'), h('div', { class: 'wn-badges' }, i('chip'), i('chip'), i('chip'))));
  }
  if (id === 'clips') {
    return scene(h('div', { class: 'wn-mock wn-shot' }, i('sky'), i('ground'), h('span', { class: 'wn-rec' }, i('rec-dot'), '0:30'), i('corner tl'), i('corner tr'), i('corner bl'), i('corner br')), h('div', { class: 'wn-strip' }, i('frame'), i('frame'), i('frame')));
  }
  if (id === 'rewards') {
    return scene(h('div', { class: 'wn-coins' }, i('coin c1', icon('wnPoint')), i('coin c2', icon('wnPoint')), i('coin c3', icon('wnPoint'))), h('span', { class: 'wn-plus' }, '+50'), h('div', { class: 'wn-mock wn-shop' }, i('item'), i('item'), i('item premium', icon('crown'))));
  }
  if (id === 'party') {
    return scene(h('div', { class: 'wn-mock wn-party' }, h('div', { class: 'wn-row' }, i('av big', icon('crown')), i('av big ready'), i('av big ready'), i('av big')), i('line w60'), h('div', { class: 'wn-go' }, icon('play'))), h('div', { class: 'wn-bell' }, icon('bell')));
  }
  if (id === 'themes') {
    return scene(h('div', { class: 'wn-themes' }, i('theme t1'), i('theme t2'), i('theme t3')), h('span', { class: 'wn-code' }, 'VENUS-THEME:…'));
  }
  if (id === 'skins') {
    // cara de pixeles propia (no es Steve): marco, piel, ojos y sonrisa
    const map = ['11111111', '12222221', '13322331', '12222221', '12244221', '12422421', '12222221', '11111111'];
    const cells = [];
    for (const row of map) for (const c of row) cells.push(i(`px p${c}`));
    return scene(h('div', { class: 'wn-mock wn-grid' }, cells), h('div', { class: 'wn-brush' }, icon('wnBrush')), h('div', { class: 'wn-tools' }, i('tool on'), i('tool'), i('tool')));
  }
  // insignia
  return scene(h('div', { class: 'wn-mock wn-nameplate' }, h('span', { class: 'wn-badge' }, icon('wnBadge')), i('line plate')), i('head'), i('torso'));
}

// ---------- Recorrido ----------
let current = null; // { el, focus }

export async function openWhatsNew({ start = 0, only = null } = {}) {
  if (current) {
    current.focus();
    return;
  }
  await prepare();
  if (current) return;
  const slides = only ? SLIDES.filter((s) => s.id === only) : SLIDES;
  let index = Math.max(0, Math.min(slides.length - 1, Number(start) || 0));
  const total = slides.length;
  const slideHost = h('div', { class: 'wn-slide-host' });
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
  const dots = slides.map((s, n) =>
    h('button', { type: 'button', class: 'wn-dot-btn', 'aria-label': t('whatsnew.dotLabel', { n: n + 1, total, title: t(`whatsnew.${s.id}_title`) }), onclick: () => go(n) }, h('span', { class: 'wn-dot-mark' })),
  );
  const prevBtn = h('button', { type: 'button', class: 'btn ghost', onclick: () => go(index - 1) }, icon('chevronLeft'), t('whatsnew.prev'));
  const nextBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => (index >= total - 1 ? m.close() : go(index + 1)) });
  const m = modal({
    title: t('whatsnew.title'),
    subtitle: ' ',
    icon: 'sparkles',
    size: 'wide',
    body: h('div', { class: 'wn-body' }, slideHost, live),
    footer: [h('div', { class: 'wn-dots', role: 'group', 'aria-label': t('whatsnew.dotsLabel') }, dots), h('span', { class: 'spacer' }), prevBtn, nextBtn],
    onClose: () => {
      current = null;
    },
  });
  m.el.classList.add('wn-modal');
  const sub = m.el.querySelector('.modal-sub');

  function slideEl(s, dir) {
    const cta = s.go
      ? h('button', { type: 'button', class: 'btn tonal wn-cta', onclick: () => {
          m.close();
          Promise.resolve(s.go()).catch((err) => console.warn('[whatsnew]', err?.message || err));
        } }, t(`whatsnew.${s.id}_cta`), icon('arrowRight'))
      : null;
    const bullets = (s.bullets || [1, 2, 3, 4]).map((k) => `whatsnew.${s.id}_b${k}`).filter((k) => has(k));
    return h(
      'section',
      { class: ['wn-slide', dir && !reducedMotion() && `wn-enter-${dir}`], role: 'group', 'aria-roledescription': t('whatsnew.slideRole'), 'aria-label': t('whatsnew.slideLabel', { n: index + 1, total, title: t(`whatsnew.${s.id}_title`) }) },
      art(s.art || s.id),
      h(
        'div',
        { class: 'wn-text' },
        h('span', { class: 'wn-kicker' }, icon(s.icon), t(s.id === 'intro' ? 'whatsnew.kickerIntro' : 'whatsnew.kicker')),
        h('h2', { class: 'wn-title' }, t(`whatsnew.${s.id}_title`)),
        h('p', { class: 'wn-desc' }, t(`whatsnew.${s.id}_text`)),
        bullets.length ? h('ul', { class: 'wn-bullets' }, bullets.map((k) => h('li', {}, icon('check'), h('span', {}, t(k))))) : null,
        cta,
      ),
    );
  }

  function go(n, { initial = false } = {}) {
    if (n < 0 || n >= total) return;
    const dir = initial ? null : n > index ? 'next' : 'prev';
    index = n;
    mount(slideHost, slideEl(slides[index], dir));
    dots.forEach((d, k) => {
      d.classList.toggle('active', k === index);
      if (k === index) d.setAttribute('aria-current', 'step');
      else d.removeAttribute('aria-current');
    });
    prevBtn.hidden = index === 0;
    mount(nextBtn, index >= total - 1 ? [t('whatsnew.done'), icon('check')] : [t('whatsnew.next'), icon('chevronRight')]);
    const step = t('whatsnew.step', { n: index + 1, total });
    if (sub) {
      sub.textContent = step;
      sub.title = step;
    }
    if (!initial) live.textContent = t('whatsnew.slideLabel', { n: index + 1, total, title: t(`whatsnew.${slides[index].id}_title`) });
  }

  // Flechas izquierda/derecha cambian de pantalla (menos dentro de un grupo que ya las usa)
  m.el.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      e.preventDefault();
      go(index + 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      go(index - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      go(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      go(total - 1);
    }
  });

  go(index, { initial: true });
  queueMicrotask(() => nextBtn.focus({ preventScroll: true }));
  current = { el: m.el, focus: () => nextBtn.focus({ preventScroll: true }) };
}

// Botón para Ajustes → Acerca de (se traduce solo aunque la página no haya cargado los textos).
export function whatsNewButton({ className = 'btn sm' } = {}) {
  const label = h('span', {}, has('whatsnew.button') ? t('whatsnew.button') : '');
  const btn = h('button', { type: 'button', class: className, onclick: () => openWhatsNew() }, icon('sparkles'), label);
  if (!label.textContent) prepare().then(() => (label.textContent = t('whatsnew.button')));
  return btn;
}

// ---------- Arranque ----------
// Espera a que no haya bienvenida ni otro diálogo abierto (la bienvenida puede tardar: revisa cada tanto).
export function whenFree() {
  return new Promise((resolve) => {
    let tries = 0;
    const free = () => store.settings?.onboarded && !document.body.classList.contains('onboarding') && !location.hash.startsWith('#/welcome') && !document.querySelector('.modal-backdrop');
    const tick = () => {
      if (free()) resolve();
      else setTimeout(tick, tries++ < 40 ? 1500 : 5000);
    };
    setTimeout(tick, 1800);
  });
}

let started = false;
export async function startup() {
  if (started) return;
  started = true;
  await prepare();
  try {
    const { registerCommands } = await import('../a11y.js');
    registerCommands(() => [
      { id: 'whatsnew.open', title: t('whatsnew.cmdTitle'), sub: t('whatsnew.cmdSub'), group: 'actions', icon: 'sparkles', keywords: t('whatsnew.cmdKeywords'), run: () => openWhatsNew() },
    ]);
  } catch (err) {
    console.warn('[whatsnew] paleta', err?.message || err);
  }
  const info = store.info || {};
  // Capturas automáticas: nunca se muestra solo
  if (info.skipOnboarding || info.devshot) return;
  if (!shouldShow(info.version, store.settings?.whatsnew?.seen)) return;
  await whenFree();
  if (!shouldShow(info.version, store.settings?.whatsnew?.seen)) return;
  // Se marca como visto al mostrarlo (si el launcher se cierra a mitad, no vuelve a aparecer solo)
  const seen = store.settings?.whatsnew?.seen;
  const onlyChanges = Boolean(seen) && compareVersions(seen, FULL_TOUR_VERSION) >= 0;
  store.setSettings({ whatsnew: { seen: TOUR_VERSION, seenAt: Date.now() } }).catch((err) => console.warn('[whatsnew] ajustes', err?.message || err));
  openWhatsNew(onlyChanges ? { only: CHANGES_SLIDE } : {}).catch((err) => console.warn('[whatsnew]', err?.message || err));
}
