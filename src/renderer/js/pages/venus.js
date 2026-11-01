// Pagina "Venus": la web de Venus dentro del launcher (venus-launcher.netlify.app y venus-launcher-fondos.netlify.app).
//   Inicio     cuenta regresiva del lanzamiento, novedades de cada version y accesos a lo que hace el launcher
//   Fondos     la galeria de fondos, que se aplican con un clic (pages/venus/gallery.js)
//   Venus IA   los planes (el mismo panel de Ajustes > Plan)
//   Preguntas  las preguntas frecuentes del sitio
// La pestana va en la ruta (#/venus/fondos) para poder abrirla desde otras partes; cambiarla no vuelve a dibujar la pagina.
import { h, icon, mount } from '../ui.js';
import { store } from '../store.js';
import { t } from '../i18n.js';
import { navigate } from '../app.js';
import { discordButton, openLink, WEBSITE, GITHUB_REPO } from '../community.js';
import { galleryView } from './venus/gallery.js';

// Domingo 8 de noviembre de 2026, 00:00 de Argentina (03:00 UTC). Igual que LANZAMIENTO en web/index.html.
export const LAUNCH_AT = Date.UTC(2026, 10, 8, 3, 0, 0);

const TABS = [
  { id: 'inicio', key: 'tab_home', icon: 'home' },
  { id: 'fondos', key: 'tab_wallpapers', icon: 'image' },
  { id: 'ia', key: 'tab_ai', icon: 'wand' },
  { id: 'preguntas', key: 'tab_faq', icon: 'info' },
];

// Novedades: la clave tiene una linea por cambio (la primera es la version que esta corriendo).
const NEWS = [
  { version: '1.0.19', key: 'news1019' },
  { version: '1.0.18', key: 'news1018' },
  { version: '1.0.17', key: 'news1017' },
  { version: '1.0.16', key: 'news1016' },
];

const FEATURES = [
  ['versions', 'layers'],
  ['modrinth', 'package'],
  ['smartsearch', 'sparkles'],
  ['worlds', 'globe'],
  ['servers', 'server'],
  ['voice', 'mic'],
  ['skins', 'user'],
  ['assistant', 'wand'],
];

const FAQ = ['free', 'java', 'offline', 'updates', 'ingame', 'help', 'platforms'];

// { days, hours, minutes, seconds } que faltan, o null si ya paso.
export function timeLeft(now, target = LAUNCH_AT) {
  const ms = target - now;
  if (!(ms > 0)) return null;
  const s = Math.floor(ms / 1000);
  return { days: Math.floor(s / 86400), hours: Math.floor((s % 86400) / 3600), minutes: Math.floor((s % 3600) / 60), seconds: s % 60 };
}

function planet(cls) {
  return h('div', { class: ['vn-planet', cls], 'aria-hidden': 'true' },
    h('span', { class: 'vn-orbit' }, h('i')),
    h('span', { class: 'vn-glow' }),
    h('img', { src: 'assets/logo-256.png', alt: '', width: 256, height: 256 }));
}

function countdown(onCleanup) {
  const units = ['days', 'hours', 'minutes', 'seconds'];
  const values = Object.fromEntries(units.map((u) => [u, h('span', { class: 'vn-cd-num' }, '0')]));
  const box = h('div', { class: 'vn-countdown', role: 'timer', 'aria-live': 'off' });
  const draw = () => {
    const left = timeLeft(Date.now());
    if (!left) {
      clearInterval(timer);
      mount(box, h('div', { class: 'vn-cd-done' }, icon('rocket'),
        h('div', {}, h('strong', {}, t('venus.launchedTitle')), h('p', {}, t('venus.launchedText')))));
      box.classList.add('done');
      return;
    }
    for (const u of units) values[u].textContent = String(left[u]).padStart(u === 'days' ? 1 : 2, '0');
    box.setAttribute('aria-label', t('venus.launchLeft', left));
  };
  mount(box,
    h('div', { class: 'vn-cd-head' }, h('span', { class: 'vn-cd-title' }, icon('calendar'), t('venus.launchTitle')), h('span', { class: 'vn-cd-date' }, t('venus.launchDate'))),
    h('div', { class: 'vn-cd-units', 'aria-hidden': 'true' }, units.map((u) => h('div', { class: 'vn-cd-unit' }, values[u], h('span', { class: 'vn-cd-label' }, t(`venus.unit_${u}`))))));
  const timer = setInterval(draw, 1000);
  onCleanup(() => clearInterval(timer));
  draw();
  return box;
}

function homeView(onCleanup) {
  const version = store.info?.version || '';
  const hero = h('section', { class: 'vn-hero' },
    planet('big'),
    h('div', { class: 'vn-hero-text' },
      h('div', { class: 'vn-kicker' }, h('span', { class: 'vn-wordmark' }, 'VENUS LAUNCHER'), version ? h('span', { class: 'vn-version' }, `v${version}`) : null),
      h('h1', { class: 'vn-title' }, t('venus.heroTitle')),
      h('p', { class: 'vn-lead' }, t('venus.heroText')),
      h('div', { class: 'vn-actions' },
        discordButton({ className: 'btn primary' }),
        h('button', { type: 'button', class: 'btn', onclick: () => openLink(WEBSITE) }, icon('globe'), h('span', {}, t('venus.website')), icon('external')),
        h('button', { type: 'button', class: 'btn ghost', onclick: () => openLink(GITHUB_REPO) }, icon('github'), h('span', {}, t('venus.github')), icon('external')))),
    countdown(onCleanup));

  const news = h('section', { class: 'vn-section', 'aria-labelledby': 'vn-news-title' },
    h('div', { class: 'vn-section-head' }, h('div', { class: 'vn-section-text' }, h('h2', { id: 'vn-news-title' }, t('venus.newsTitle')), h('p', {}, t('venus.newsSub')))),
    h('ol', { class: 'vn-news' }, NEWS.map((n) => h('li', { class: ['vn-news-item', n.version === version && 'current'] },
      h('div', { class: 'vn-news-tag' }, h('span', { class: 'vn-news-ver' }, `v${n.version}`), n.version === version ? h('span', { class: 'badge accent' }, t('venus.newsCurrent')) : null),
      h('ul', {}, String(t(`venus.${n.key}`)).split('\n').filter(Boolean).map((line) => h('li', {}, line)))))));

  const features = h('section', { class: 'vn-section', 'aria-labelledby': 'vn-feat-title' },
    h('div', { class: 'vn-section-head' }, h('div', { class: 'vn-section-text' }, h('h2', { id: 'vn-feat-title' }, t('venus.featuresTitle')), h('p', {}, t('venus.featuresSub')))),
    h('div', { class: 'vn-features' }, FEATURES.map(([route, ic]) => h('button', { type: 'button', class: 'vn-feature', onclick: () => navigate(route) },
      h('span', { class: 'vn-feature-icon', 'aria-hidden': 'true' }, icon(ic)),
      h('span', { class: 'vn-feature-text' }, h('strong', {}, t(`nav.${route}`)), h('span', {}, t(`venus.feat_${route}`))),
      icon('arrowRight', 'vn-feature-go')))));

  return h('div', { class: 'vn-home' }, hero, features, news);
}

function aiView(onCleanup) {
  const holder = h('div', { class: 'vn-ai-plans' }, h('div', { class: 'vn-loading' }, h('span', { class: 'spinner' })));
  let panel = null;
  let dead = false;
  import('../features/plans.js')
    .then(({ plansPanel }) => {
      if (dead) return;
      panel = plansPanel({ variant: 'page' });
      mount(holder, panel);
    })
    .catch((err) => mount(holder, h('div', { class: 'notice' }, icon('alert'), t('common.pageLoadError', { error: err.message }))));
  onCleanup(() => {
    dead = true;
    panel?.destroy?.();
  });
  return h('section', { class: 'vn-section vn-ai', 'aria-labelledby': 'vn-ai-title' },
    h('div', { class: 'vn-ai-intro' },
      h('span', { class: 'vn-ai-icon', 'aria-hidden': 'true' }, icon('wand')),
      h('div', { class: 'vn-section-text' }, h('h2', { id: 'vn-ai-title' }, t('venus.aiTitle')), h('p', {}, t('venus.aiText'))),
      h('button', { type: 'button', class: 'btn', onclick: () => navigate('assistant') }, icon('message'), h('span', {}, t('venus.aiOpen')))),
    h('ul', { class: 'vn-ai-points' }, ['aiPoint1', 'aiPoint2', 'aiPoint3', 'aiPoint4'].map((k) => h('li', {}, icon('check'), h('span', {}, t(`venus.${k}`))))),
    holder);
}

function faqView() {
  return h('section', { class: 'vn-section vn-faq', 'aria-labelledby': 'vn-faq-title' },
    h('div', { class: 'vn-section-head' }, h('div', { class: 'vn-section-text' }, h('h2', { id: 'vn-faq-title' }, t('venus.faqTitle')), h('p', {}, t('venus.faqSub')))),
    h('div', { class: 'vn-faq-list' }, FAQ.map((id, i) => h('details', { class: 'vn-faq-item', open: i === 0 ? true : null },
      h('summary', {}, h('span', {}, t(`venus.q_${id}`)), icon('chevronDown')),
      h('p', {}, t(`venus.a_${id}`)),
      id === 'ingame' ? h('button', { type: 'button', class: 'btn sm', onclick: () => navigate('settings/general/play') }, icon('settings'), h('span', {}, t('venus.openSettings'))) : null))),
    h('div', { class: 'vn-help' }, icon('message'),
      h('div', {}, h('strong', {}, t('venus.helpTitle')), h('p', {}, t('venus.helpText'))),
      h('button', { type: 'button', class: 'btn', onclick: () => navigate('support') }, t('venus.goSupport')),
      discordButton({ className: 'btn ghost' })));
}

export default {
  ns: ['venus', 'appearance'],
  css: ['pages/venus'],
  render(root, params) {
    const cleanups = [];
    let viewCleanups = [];
    const onCleanup = (fn) => viewCleanups.push(fn);
    const body = h('div', { class: 'vn-body' });
    const tabButtons = TABS.map((tab) => h('button', {
      type: 'button',
      class: 'tab',
      role: 'tab',
      id: `vn-tab-${tab.id}`,
      'aria-controls': 'vn-panel',
      dataset: { tab: tab.id },
      onclick: () => show(tab.id, true),
      onkeydown: (e) => {
        const i = TABS.findIndex((x) => x.id === tab.id);
        const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
        if (next === null) return;
        e.preventDefault();
        const target = TABS[(next + TABS.length) % TABS.length].id;
        show(target, true);
        tabButtons.find((b) => b.dataset.tab === target)?.focus();
      },
    }, icon(tab.icon), h('span', {}, t(`venus.${tab.key}`))));

    function show(id, fromUser) {
      const tab = TABS.some((x) => x.id === id) ? id : 'inicio';
      viewCleanups.forEach((fn) => fn());
      viewCleanups = [];
      tabButtons.forEach((b) => {
        const on = b.dataset.tab === tab;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        b.classList.toggle('active', on);
      });
      let view;
      if (tab === 'fondos') {
        view = galleryView();
        onCleanup(() => view.destroy?.());
      } else if (tab === 'ia') view = aiView(onCleanup);
      else if (tab === 'preguntas') view = faqView();
      else view = homeView(onCleanup);
      mount(body, h('div', { class: 'vn-panel', id: 'vn-panel', role: 'tabpanel', 'aria-labelledby': `vn-tab-${tab}` }, view));
      if (fromUser) {
        history.replaceState(null, '', `#/venus/${tab}`);
        root.scrollTop = 0;
      }
    }

    mount(root, h('div', { class: 'vn-page' },
      h('nav', { class: 'tabs vn-tabs', role: 'tablist', 'aria-label': t('venus.title') }, tabButtons),
      body,
      h('p', { class: 'vn-disclaimer' }, t('venus.disclaimer'))));
    show(params[0], false);
    cleanups.push(() => viewCleanups.forEach((fn) => fn()));
    return () => cleanups.forEach((fn) => fn());
  },
};
