// Ajustes: pagina con secciones y una subnavegacion a la izquierda.
// Rutas: #/settings/<seccion>[/<ancla>]  (por ejemplo #/settings/cloud, #/settings/plan o #/settings/ai/mcp)
// Secciones: general, appearance, a11y, cloud, privacy, ai, plan, java, storage, data, updates, about.
// Anclas: cloud/{accounts,venus} · ai/{status,mcp,privacy} · plan/plans · privacy/{activity,discord} ·
//         java/system · data/{folder,cache}. El ancla lleva la vista a esa tarjeta y enfoca su campo.
import { h, icon, mount } from '../ui.js';
import { store, api } from '../store.js';
import { t } from '../i18n.js';
import { cloud } from '../cloud.js';
import { errorNote, errMsg, reduceMotion } from './settings/shared.js';
import { renderGeneral, renderPrivacy, renderAbout } from './settings/general.js';
import { renderAppearance, renderA11y, renderStorage } from './settings/panels.js';
import { renderCloud } from './settings/account.js';
import { renderAi, renderPlan } from './settings/services.js';
import { renderJava, renderData } from './settings/system.js';
import { appendUpdates } from './settings/updates.js';

const SECTIONS = [
  { group: 'launcher' },
  { id: 'general', icon: 'sliders', render: renderGeneral },
  { id: 'appearance', icon: 'palette', render: renderAppearance },
  { id: 'a11y', icon: 'accessibility', render: renderA11y },
  { group: 'account' },
  { id: 'cloud', icon: 'cloud', render: renderCloud },
  { id: 'privacy', icon: 'shieldCheck', render: renderPrivacy },
  { group: 'services' },
  { id: 'ai', icon: 'sparkles', render: renderAi },
  { id: 'plan', icon: 'crown', render: renderPlan },
  { group: 'system' },
  { id: 'java', icon: 'coffee', render: renderJava },
  { id: 'storage', icon: 'drive', render: renderStorage },
  { id: 'data', icon: 'folderOpen', render: renderData },
  { sep: true },
  { id: 'updates', icon: 'download', render: (body, ctx) => {
    body.append(h('header', { class: 'cfg-head' },
      h('div', { class: 'cfg-head-icon', 'aria-hidden': 'true' }, icon('download')),
      h('div', { class: 'cfg-head-text' },
        h('h2', { class: 'cfg-title' }, t('updates.title')),
        h('p', { class: 'cfg-desc' }, t('updates.subtitle')))));
    appendUpdates(body, ctx);
  } },
  { id: 'about', icon: 'info', render: renderAbout },
];

// Nombres alternativos que tambien abren una seccion.
const ALIASES = {
  account: 'cloud',
  accounts: 'cloud',
  venus: 'cloud',
  nube: 'cloud',
  cuenta: 'cloud',
  language: 'general',
  idioma: 'general',
  accessibility: 'a11y',
  accesibilidad: 'a11y',
  theme: 'appearance',
  apariencia: 'appearance',
  claude: 'ai',
  ia: 'ai',
  assistant: 'ai',
  mcp: 'ai',
  plans: 'plan',
  planes: 'plan',
  billing: 'plan',
  subscription: 'plan',
  suscripcion: 'plan',
  discord: 'privacy',
  downloads: 'storage',
  descargas: 'storage',
  cache: 'data',
  datos: 'data',
  folder: 'data',
  privacidad: 'privacy',
  actualizaciones: 'updates',
  update: 'updates',
};

const IDS = SECTIONS.filter((s) => s.id).map((s) => s.id);

function parseSection(raw) {
  const key = String(raw || '').toLowerCase();
  const id = ALIASES[key] || key;
  return IDS.includes(id) ? id : 'general';
}

export default {
  ns: ['settings', 'updates'],
  css: ['pages/settings', 'pages/updates'],
  async render(root, params) {
    const legacyUpdates = params[0] === 'about' && params[1] === 'updates';
    let current = legacyUpdates ? 'updates' : parseSection(params[0]);
    let anchor = !legacyUpdates && params[1] ? String(params[1]) : null;
    let token = 0;
    let sectionCleanups = [];
    const pageCleanups = [];
    const info = store.info || (await api.app.info().catch(() => ({})));

    const nav = h('div', { class: 'cfg-nav', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': t('settings.navLabel') });
    const body = h('div', { class: 'cfg-body', role: 'tabpanel', tabindex: '-1' });
    const layout = h('div', { class: 'cfg-layout' }, h('nav', { class: 'cfg-nav-wrap', 'aria-label': t('settings.navLabel') }, nav), body);
    const dots = {}; // seccion -> 'good' | 'warn' | null

    function navItem(sec) {
      const on = sec.id === current;
      const dot = dots[sec.id];
      return h(
        'button',
        {
          type: 'button',
          role: 'tab',
          id: `cfg-tab-${sec.id}`,
          class: ['cfg-nav-item', on && 'active'],
          'aria-selected': String(on),
          'aria-controls': 'cfg-panel',
          tabindex: on ? 0 : -1,
          dataset: { section: sec.id },
          onclick: () => select(sec.id),
        },
        icon(sec.icon),
        h('span', { class: 'cfg-nav-label' }, t(`settings.nav_${sec.id}`)),
        // el punto de estado lleva un simbolo (se ve con "Simbolos en los estados") y texto para el lector
        dot
          ? h('span', { class: ['cfg-nav-dot', dot], title: t(`settings.dot_${dot}`) }, icon(dot === 'good' ? 'check' : 'alert'), h('span', { class: 'sr-only' }, t(`settings.dot_${dot}`)))
          : null,
      );
    }

    function drawNav() {
      mount(
        nav,
        SECTIONS.map((sec) => {
          if (sec.group) return h('div', { class: 'cfg-nav-group', role: 'presentation' }, t(`settings.group_${sec.group}`));
          if (sec.sep) return h('div', { class: 'cfg-nav-sep', role: 'presentation' });
          return navItem(sec);
        }),
      );
    }

    // Puntos de estado en la subnavegacion (conectado / falta algo).
    function setDot(id, state) {
      if ((dots[id] || null) === (state || null)) return;
      dots[id] = state || null;
      const old = nav.querySelector(`[data-section="${id}"]`);
      const sec = SECTIONS.find((s) => s.id === id);
      if (old && sec) {
        const hadFocus = document.activeElement === old;
        const fresh = navItem(sec);
        old.replaceWith(fresh);
        if (hadFocus) fresh.focus();
      }
    }

    nav.addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const i = IDS.indexOf(current);
      let n = i;
      if (e.key === 'Home') n = 0;
      else if (e.key === 'End') n = IDS.length - 1;
      else n = (i + (e.key === 'ArrowDown' ? 1 : -1) + IDS.length) % IDS.length;
      select(IDS[n], null, { focusTab: true });
    });

    function runCleanups() {
      const list = sectionCleanups;
      sectionCleanups = [];
      for (const fn of list) {
        try {
          fn();
        } catch (err) {
          console.error('[settings]', err);
        }
      }
    }

    function setRoute() {
      const route = ['settings', current, ...(anchor ? [anchor] : [])].map(encodeURIComponent).join('/');
      if (location.hash !== `#/${route}`) history.replaceState(null, '', `#/${route}`);
    }

    // Desplaza solo la pagina (scrollIntoView tambien moveria el documento entero).
    function scrollToEl(el, smooth = false) {
      const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 14;
      root.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
    }

    // Lleva la vista a una tarjeta de la seccion y enfoca su primer campo. Mientras las tarjetas de
    // arriba terminan de cargar (cambian de alto), la tarjeta se mantiene arriba un momento.
    function goAnchor(name) {
      let el = null;
      try {
        el = body.querySelector(`[data-anchor="${CSS.escape(name)}"]`);
      } catch {
        el = null;
      }
      anchor = null;
      setRoute();
      if (!el) return;
      scrollToEl(el, !reduceMotion());
      el.classList.remove('cfg-flash');
      void el.offsetWidth;
      el.classList.add('cfg-flash');
      setTimeout(() => el.classList.remove('cfg-flash'), 1900);
      const input = el.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([disabled]), textarea:not([disabled])');
      if (input) input.focus({ preventScroll: true });
      let first = true;
      const ro = new ResizeObserver(() => {
        if (first) first = false;
        else if (el.isConnected) scrollToEl(el);
      });
      ro.observe(body);
      const stop = () => {
        ro.disconnect();
        clearTimeout(timer);
        root.removeEventListener('wheel', stop);
        root.removeEventListener('pointerdown', stop);
      };
      const timer = setTimeout(stop, 2500);
      root.addEventListener('wheel', stop, { passive: true });
      root.addEventListener('pointerdown', stop);
      sectionCleanups.push(stop);
    }

    function renderSection() {
      runCleanups();
      const my = ++token;
      const sec = SECTIONS.find((s) => s.id === current);
      const ctx = {
        info,
        anchor,
        alive: () => my === token && root.isConnected,
        go: (id, anc = null) => (id === current && anc ? goAnchor(anc) : select(id, anc)),
        onCleanup: (fn) => {
          if (typeof fn === 'function') sectionCleanups.push(fn);
        },
        setDot,
      };
      body.setAttribute('aria-labelledby', `cfg-tab-${current}`);
      body.id = 'cfg-panel';
      mount(body);
      body.classList.remove('cfg-anim');
      void body.offsetWidth;
      body.classList.add('cfg-anim');
      try {
        const ret = sec.render(body, ctx);
        if (typeof ret === 'function') sectionCleanups.push(ret);
      } catch (err) {
        console.error('[settings]', err);
        mount(body, errorNote(t('settings.sectionError', { error: errMsg(err) }), () => renderSection()));
      }
      // Que el comienzo de la seccion quede a la vista.
      const top = Math.max(0, layout.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 12);
      if (root.scrollTop > top) root.scrollTop = top;
      if (anchor) {
        const name = anchor;
        requestAnimationFrame(() => {
          if (my === token) goAnchor(name);
        });
      }
    }

    function select(id, anc = null, { focusTab = false } = {}) {
      current = parseSection(id);
      anchor = anc;
      setRoute();
      drawNav();
      renderSection();
      if (focusTab) nav.querySelector(`[data-section="${current}"]`)?.focus();
    }

    mount(
      root,
      h(
        'div',
        { class: 'cfg-root' },
        h('div', { class: 'page-head cfg-page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, t('settings.title')), h('p', { class: 'page-sub' }, t('settings.subtitle')))),
        layout,
      ),
    );
    setRoute();
    drawNav();
    renderSection();

    // Estado de la nube en la subnavegacion
    const cloudDot = () => setDot('cloud', cloud.isSignedIn() ? 'good' : null);
    cloudDot();
    pageCleanups.push(cloud.on('auth', cloudDot), cloud.on('config', cloudDot));
    api
      .invoke('ai:status')
      .then((s) => root.isConnected && setDot('ai', s?.provider ? 'good' : null))
      .catch(() => {});
    // Plan de Venus IA activo (sin sesión no se pregunta: billing:state respondería noSession)
    if (cloud.isSignedIn()) {
      api
        .invoke('billing:state')
        .then((s) => root.isConnected && setDot('plan', s?.active ? 'good' : null))
        .catch(() => {});
    }

    return () => {
      token++;
      runCleanups();
      pageCleanups.forEach((off) => {
        try {
          off();
        } catch {
          /* ya desuscripto */
        }
      });
    };
  },
};
