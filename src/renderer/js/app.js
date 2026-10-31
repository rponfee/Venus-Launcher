// Shell de la aplicacion: barra de titulo, navegacion, router, cuentas, tareas y eventos globales.
import { h, icon, mount, modal, toast, fail, ok, avatarImg, confirmDialog, fmtDuration, ensureCss } from './ui.js';
import { store, api } from './store.js';
import { social } from './social.js';
import { voice } from './voice.js';
import { cloud } from './cloud.js';
import { t, loadNs, setLanguage, onLanguageChange, systemLanguage } from './i18n.js';
import { discordButton } from './community.js';

// Menu lateral. { group } dibuja un separador con titulo. La etiqueta sale de t(`nav.<id>`).
const NAV = [
  { group: 'play' },
  { id: 'home', icon: 'home' },
  { id: 'assistant', icon: 'wand' },
  { id: 'versions', icon: 'layers' },
  { id: 'worlds', icon: 'globe' },
  { group: 'content' },
  { id: 'modrinth', icon: 'package', cls: 'modrinth' },
  { id: 'smartsearch', icon: 'sparkles' },
  { group: 'online' },
  { id: 'multiplayer', icon: 'wifi' },
  { id: 'servers', icon: 'server' },
  { id: 'voice', icon: 'mic' },
  { id: 'messages', icon: 'message' },
  { group: 'tools' },
  { id: 'updates', icon: 'download' },
  { id: 'stats', icon: 'chart' },
  { id: 'performance', icon: 'memory' },
  { id: 'devmode', icon: 'code' },
  { id: 'support', icon: 'message' },
];

// Cada pagina exporta default { ns?: ['home'], css?: ['pages/home'], render(root, params) -> cleanup? }
const PAGES = {
  welcome: () => import('./pages/welcome.js'),
  home: () => import('./pages/home.js'),
  assistant: () => import('./pages/assistant.js'),
  stats: () => import('./pages/stats.js'),
  versions: () => import('./pages/versions.js'),
  instance: () => import('./pages/instance.js'),
  worlds: () => import('./pages/worlds.js'),
  modrinth: () => import('./pages/modrinth.js'),
  smartsearch: () => import('./pages/smartsearch.js'),
  performance: () => import('./pages/performance.js'),
  multiplayer: () => import('./pages/multiplayer.js'),
  servers: () => import('./pages/servers.js'),
  server: () => import('./pages/server.js'),
  voice: () => import('./pages/voice.js'),
  messages: () => import('./pages/messages.js'),
  devmode: () => import('./pages/devmode.js'),
  settings: () => import('./pages/settings.js'),
  updates: () => import('./pages/updates.js'),
  support: () => import('./pages/support.js'),
  'support-staff': () => import('./pages/support-staff.js'),
};
// Las paginas propias del launcher no se pueden quitar con unregisterPage()
const BUILTIN_PAGES = new Set(Object.keys(PAGES));

// Pagina "padre" en la navegacion para rutas de detalle
const NAV_PARENT = { instance: 'versions', server: 'servers', settings: null, welcome: null };

// Apariencia y accesibilidad arrancan antes de dibujar la primera pagina (se esperan como mucho
// EARLY_WAIT_MS) para que no se vea un instante el tema por defecto.
const EARLY_STARTUP = [() => import('./appearance.js'), () => import('./a11y.js')];
const EARLY_WAIT_MS = 1500;

// Modulos que se inician solos despues de la primera pagina (cada uno exporta startup(), que se puede
// llamar mas de una vez): modpacks compartidos y nube, asistente, invitaciones a mundos,
// resultados de la busqueda del culpable de un crash, el autoarranque del modo desarrollador, la
// entrada del panel de administracion (solo aparece para los administradores) y las confirmaciones y
// avisos con Deshacer de las acciones que piden Claude o ChatGPT por MCP.
const STARTUP = [
  () => import('./features/netprefs.js'),
  () => import('./features/share.js'),
  () => import('./features/cloudsync.js'),
  () => import('./features/assistant.js'),
  () => import('./features/netplay.js'),
  () => import('./features/crash.js'),
  () => import('./pages/devmode.js'),
  () => import('./features/admin.js'),
  () => import('./features/support-staff.js'),
  () => import('./features/mcp.js'),
];

let cleanup = null;
let renderToken = 0;
let onboarding = false;
const navHidden = new Set(); // rutas ocultas con setNavHidden()
const navBadges = new Map(); // ruta -> { value, kind } (se vuelven a pintar cuando se rearma el menu)

const currentRoute = () => (location.hash.replace(/^#\/?/, '') || 'home').split('/')[0];

function runStartup(load) {
  return load()
    .then((m) => m.startup?.())
    .catch((err) => console.warn('[startup]', err));
}

function waitAtMost(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]).finally(() => clearTimeout(timer));
}

export function navigate(route) {
  if (location.hash !== `#/${route}`) location.hash = `#/${route}`;
  else renderRoute();
}

// Cualquier modulo (por ejemplo, el panel de administracion) puede sumar paginas y entradas del menu.
// navItem: { label: 'Texto' | () => 'Texto' (se vuelve a evaluar al cambiar el idioma), icon, cls }.
// Registrar otra vez el mismo id reemplaza la pagina y su entrada (no la duplica).
export function registerPage(id, loader, navItem) {
  PAGES[id] = loader;
  if (navItem) {
    const entry = { id, icon: navItem.icon || 'puzzle', label: navItem.label, cls: navItem.cls };
    const i = NAV.findIndex((n) => n.id === id);
    if (i >= 0) NAV[i] = entry;
    else NAV.push(entry);
    buildNav();
  }
}

// Quita una pagina registrada con registerPage() y su entrada del menu (si estaba abierta, vuelve al Inicio).
// Devuelve false si no existe o si es una pagina propia del launcher.
export function unregisterPage(id) {
  if (BUILTIN_PAGES.has(id) || !Object.prototype.hasOwnProperty.call(PAGES, id)) return false;
  delete PAGES[id];
  const i = NAV.findIndex((n) => n.id === id);
  if (i >= 0) NAV.splice(i, 1);
  navHidden.delete(id);
  navBadges.delete(id);
  buildNav();
  if (currentRoute() === id) navigate('home');
  return true;
}

// Oculta (o vuelve a mostrar) la entrada del menu de una pagina; la ruta sigue funcionando.
export function setNavHidden(id, hidden = true) {
  if (hidden) navHidden.add(id);
  else navHidden.delete(id);
  syncNavHidden();
}

async function renderRoute() {
  let [name, ...params] = (location.hash.replace(/^#\/?/, '') || 'home').split('/');
  if (onboarding && name !== 'welcome') {
    name = 'welcome';
    params = [];
  }
  const page = Object.prototype.hasOwnProperty.call(PAGES, name) ? name : 'home';
  const token = ++renderToken;
  if (cleanup) {
    try {
      cleanup();
    } catch (err) {
      console.error(err);
    }
    cleanup = null;
  }
  const navId = page in NAV_PARENT ? NAV_PARENT[page] : page;
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === navId));
  document.getElementById('settings-btn').classList.toggle('active', page === 'settings');
  if (page === 'stats') setNavBadge('stats', 0);
  const main = document.getElementById('main');
  const root = h('div', { class: ['page', `page-${page}`] });
  mount(main, root);
  try {
    const mod = await PAGES[page]();
    const def = mod.default;
    await loadNs('common', ...(def.ns || [page]));
    for (const css of def.css || []) ensureCss(css);
    if (token !== renderToken) return;
    const pageCleanup = (await def.render(root, params.map(decodeURIComponent))) || null;
    if (token !== renderToken) {
      if (typeof pageCleanup === 'function') pageCleanup();
      return;
    }
    cleanup = pageCleanup;
  } catch (err) {
    console.error(err);
    if (token === renderToken) mount(root, h('div', { class: 'notice' }, icon('alert'), t('common.pageLoadError', { error: err.message })));
  }
}

// ---------- Menu ----------
function navLabel(item) {
  if (typeof item.label === 'function') {
    try {
      const text = item.label();
      if (text) return String(text);
    } catch (err) {
      console.warn('[nav]', item.id, err);
    }
  } else if (item.label) return String(item.label);
  return t(`nav.${item.id}`);
}

function buildNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  mount(
    nav,
    NAV.map((item) =>
      item.group
        ? h('div', { class: 'nav-group', dataset: { group: item.group } }, t(`nav.group_${item.group}`))
        : h(
            'div',
            { class: ['nav-item', item.cls], dataset: { route: item.id }, onclick: () => navigate(item.id), title: navLabel(item), role: 'link', tabindex: 0 },
            icon(item.icon),
            h('span', {}, navLabel(item)),
            h('span', { class: 'nav-extra', dataset: { for: item.id } }),
          ),
    ),
  );
  const navId = currentRoute() in NAV_PARENT ? NAV_PARENT[currentRoute()] : currentRoute();
  nav.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === navId));
  syncNavHidden();
  for (const route of navBadges.keys()) paintBadge(route);
}

// Aplica setNavHidden(): oculta las entradas y los titulos de grupo que quedan sin entradas visibles.
function syncNavHidden() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  let group = null;
  let visible = 0;
  const closeGroup = () => {
    if (group) group.hidden = visible === 0;
  };
  for (const el of nav.children) {
    if (el.classList.contains('nav-group')) {
      closeGroup();
      group = el;
      visible = 0;
    } else if (el.classList.contains('nav-item')) {
      el.hidden = navHidden.has(el.dataset.route);
      if (!el.hidden) visible++;
    }
  }
  closeGroup();
}

function paintBadge(route) {
  const slot = document.querySelector(`.nav-extra[data-for="${CSS.escape(String(route))}"]`);
  if (!slot) return;
  const badge = navBadges.get(route);
  slot.className = 'nav-extra';
  slot.textContent = '';
  if (!badge) return;
  if (badge.kind === 'dot') slot.className = 'nav-extra nav-dot';
  else {
    slot.className = 'nav-extra nav-badge';
    slot.textContent = badge.value > 99 ? '99+' : String(badge.value);
  }
}

export function setNavBadge(route, value, kind = 'badge') {
  if (value) navBadges.set(route, { value, kind });
  else navBadges.delete(route);
  paintBadge(route);
}

// ---------- Cuentas ----------
// Cancelar el inicio de sesion no es un error: el proceso principal manda err.code = 'cancelled'
// (el texto traducido puede no decir "cancel" en otros idiomas; /cancel/i queda como respaldo).
const isLoginCancelled = (err) => err?.code === 'cancelled' || /cancel/i.test(String(err?.message || ''));

function renderAccountChip() {
  const chip = document.getElementById('account-chip');
  chip.title = t('common.accounts');
  const acc = store.selectedAccount();
  if (!acc) {
    mount(chip, h('div', { class: 'avatar', style: { display: 'grid', placeItems: 'center' } }, icon('user')), h('div', { class: 'ellipsis' }, h('div', { class: 'acc-name' }, t('common.addAccount')), h('div', { class: 'acc-type' }, t('common.neededToPlay'))));
    return;
  }
  mount(
    chip,
    avatarImg(acc.type === 'msa' ? acc.uuid : acc.name, 64),
    h(
      'div',
      { class: 'ellipsis' },
      h('div', { class: 'acc-name' }, acc.name),
      acc.needsLogin ? h('div', { class: 'acc-type warn' }, t('common.needsLogin')) : h('div', { class: 'acc-type' }, acc.type === 'msa' ? 'Microsoft' : t('common.offline')),
    ),
  );
}

export function openAccounts({ welcome = false } = {}) {
  const listBox = h('div', { class: 'account-list' });
  const nameInput = h('input', { class: 'input', placeholder: t('common.playerNamePlaceholder'), maxlength: 16 });
  const msBtn = h(
    'button',
    { class: 'ms-btn' },
    h('span', { class: 'ms-logo' }, h('i', { style: { background: '#f25022' } }), h('i', { style: { background: '#7fba00' } }), h('i', { style: { background: '#00a4ef' } }), h('i', { style: { background: '#ffb900' } })),
    t('common.loginMicrosoft'),
  );

  // Inicio de sesion con Microsoft: el boton grande o "Iniciar sesion" de una cuenta vencida (needsLogin).
  // Si se entra con la misma cuenta, el registro se actualiza y deja de pedir el inicio de sesion.
  let loggingIn = false;
  const msLogin = async (btn, { compact = false, name = null } = {}) => {
    if (loggingIn) return;
    loggingIn = true;
    const old = [...btn.childNodes];
    btn.disabled = true;
    msBtn.disabled = true;
    mount(btn, h('div', { class: 'spinner' }), compact ? null : t('common.waitingMicrosoft'));
    try {
      await api.accounts.loginMicrosoft();
      await store.refreshAccounts();
      renderList();
      ok(t('common.loggedIn'), t('common.hello', { name: name || store.selectedAccount()?.name }));
    } catch (err) {
      if (!isLoginCancelled(err)) fail(t('common.loginFailed'), err);
    } finally {
      loggingIn = false;
      msBtn.disabled = false;
      btn.disabled = false;
      mount(btn, ...old);
    }
  };

  const renderList = () => {
    const accs = store.accounts.accounts;
    if (!accs.length) {
      mount(listBox, h('div', { class: 'muted small' }, t('common.noAccounts')));
      return;
    }
    mount(
      listBox,
      accs.map((a) =>
        h(
          'div',
          {
            class: ['account-row', a.id === store.accounts.selected && 'active', a.needsLogin && 'needs-login'],
            onclick: async () => {
              await api.accounts.select(a.id);
              await store.refreshAccounts();
              renderList();
            },
          },
          avatarImg(a.type === 'msa' ? a.uuid : a.name, 64, ''),
          h(
            'div',
            { class: 'spacer' },
            h('div', { style: { fontWeight: 700 } }, a.name),
            a.needsLogin
              ? h('span', { class: 'badge warn', title: t('common.needsLoginHint') }, icon('alert'), t('common.needsLogin'))
              : h('div', { class: 'small muted' }, a.type === 'msa' ? t('common.microsoftAccount') : t('common.offlineAccount')),
          ),
          a.id === store.accounts.selected ? h('span', { class: 'badge accent' }, icon('check'), t('common.inUse')) : null,
          a.needsLogin
            ? h(
                'button',
                {
                  class: 'btn sm',
                  title: t('common.needsLoginHint'),
                  onclick: (e) => {
                    e.stopPropagation();
                    msLogin(e.currentTarget, { compact: true, name: a.name });
                  },
                },
                icon('logIn'),
                t('common.reloginAction'),
              )
            : null,
          h(
            'button',
            {
              class: 'icon-btn sm danger',
              title: t('common.removeAccount'),
              'aria-label': t('common.removeAccount'),
              onclick: async (e) => {
                e.stopPropagation();
                if (!(await confirmDialog(t('common.removeAccount'), t('common.removeAccountConfirm', { name: a.name }), { okText: t('common.remove'), danger: true }))) return;
                await api.accounts.remove(a.id);
                await store.refreshAccounts();
                renderList();
              },
            },
            icon('trash'),
          ),
        ),
      ),
    );
  };

  msBtn.addEventListener('click', () => msLogin(msBtn));

  const addOffline = async () => {
    try {
      await api.accounts.addOffline(nameInput.value);
      nameInput.value = '';
      await store.refreshAccounts();
      renderList();
    } catch (err) {
      fail(t('common.invalidName'), err);
    }
  };
  nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && addOffline());

  renderList();
  modal({
    title: welcome ? t('common.welcomeTitle') : t('common.accounts'),
    body: h(
      'div',
      { class: 'stack' },
      welcome ? h('p', { class: 'text-2', style: { margin: 0 } }, t('common.welcomeAccountText')) : null,
      listBox,
      h('div', { class: 'divider' }),
      msBtn,
      h('div', { class: 'label', style: { marginTop: '6px' } }, t('common.offlineAccount')),
      h('div', { class: 'row' }, nameInput, h('button', { class: 'btn', onclick: addOffline }, icon('plus'), t('common.add'))),
      h('div', { class: 'small muted' }, t('common.offlineHint')),
    ),
  });
}

// ---------- Tareas ----------
// Una tarea cancelada no es un error (sin aviso rojo). Hoy core/tasks la marca como 'error' con el texto
// del motivo; si el proceso principal pasa a mandar state 'cancelled' (o cancelled: true) tambien se entiende.
const isCancelledTask = (task) => task.state === 'cancelled' || (task.state === 'error' && (task.cancelled === true || /cancel/i.test(String(task.detail || ''))));

function renderTask(task) {
  const dock = document.getElementById('tasks');
  let el = dock.querySelector(`[data-task="${CSS.escape(String(task.id))}"]`);
  if (!el) {
    el = h('div', { class: 'task', dataset: { task: task.id } });
    dock.append(el);
  }
  const state = task.state === 'done' ? 'done' : isCancelledTask(task) ? 'cancelled' : task.state === 'error' ? 'error' : 'running';
  el.className = `task ${state === 'running' ? '' : state}`;
  const pct = task.progress === null || task.progress === undefined ? null : Math.round(task.progress * 100);
  mount(
    el,
    h(
      'div',
      { class: 'task-top' },
      state === 'running' ? h('div', { class: 'spinner' }) : icon(state === 'done' ? 'check' : state === 'cancelled' ? 'ban' : 'alert'),
      h('div', { class: 'task-title' }, task.title),
      pct !== null && state === 'running' ? h('span', { class: 'small muted' }, `${pct}%`) : null,
      state === 'running'
        ? h('button', { class: 'icon-btn sm', title: t('common.cancel'), 'aria-label': t('common.cancel'), onclick: () => api.tasks.cancel(task.id) }, icon('x'))
        : h('button', { class: 'icon-btn sm', title: t('common.close'), 'aria-label': t('common.close'), onclick: () => el.remove() }, icon('x')),
    ),
    state === 'running' ? h('div', { class: ['progress', pct === null && 'indeterminate'] }, h('i', { style: { width: `${pct || 0}%` } })) : null,
    task.detail ? h('div', { class: 'task-detail', title: task.detail }, task.detail) : null,
  );
  if (state === 'done') setTimeout(() => el.remove(), 2500);
  if (state === 'cancelled') setTimeout(() => el.remove(), 4000);
  if (state === 'error') setTimeout(() => el.isConnected && el.remove(), 20000);
}

// ---------- Lanzar ----------
export async function launchInstance(id, opts = {}) {
  if (!store.selectedAccount()) {
    openAccounts({ welcome: true });
    return false;
  }
  try {
    store.running[id] = { state: 'preparing' };
    store.emit('running', store.running);
    await api.instances.launch(id, opts);
    return true;
  } catch (err) {
    delete store.running[id];
    store.emit('running', store.running);
    fail(t('common.launchFailed'), err);
    return false;
  }
}

async function showCrash(id, st) {
  try {
    const m = await import('./features/crash.js');
    await loadNs('crash');
    m.showCrashDialog(id, st);
  } catch (err) {
    console.error(err);
    const inst = store.instances.find((i) => i.id === id);
    toast('bad', t('common.gameCrashed', { name: inst?.name || 'Minecraft' }), t('common.gameCrashedCode', { code: st.code }), 10000);
  }
}

// ---------- Hitos de estadisticas ----------
// Aviso global de hitos desbloqueados (con la pagina de Estadisticas abierta, la pagina avisa sola).
async function showMilestones(list) {
  const items = (Array.isArray(list) ? list : []).filter((m) => m && m.id);
  if (!items.length || currentRoute() === 'stats') return;
  try {
    await loadNs('stats');
  } catch (err) {
    console.warn('[stats]', err);
  }
  for (const m of items.slice(0, 3)) toast('good', t('stats.msUnlockedToast'), t(`stats.ms_${m.id}`), 6000);
  setNavBadge('stats', 1, 'dot');
}

// ---------- Descargas en pausa / modo sin conexion (indicador en la barra de titulo) ----------
let netState = { paused: false, offline: false };

function renderNetIndicator() {
  const el = document.getElementById('tb-net');
  if (!el) return;
  const { paused, offline } = netState;
  el.hidden = !paused && !offline;
  if (el.hidden) {
    mount(el);
    return;
  }
  const labels = [offline && t('common.offlineModeIndicator'), paused && t('common.downloadsPausedIndicator')].filter(Boolean);
  mount(
    el,
    offline ? h('span', { class: 'tb-net-item' }, icon('wifiOff'), t('common.offlineModeIndicator')) : null,
    paused ? h('span', { class: 'tb-net-item' }, icon('pause'), t('common.downloadsPausedIndicator')) : null,
  );
  el.title = t('common.netIndicatorHint');
  el.setAttribute('aria-label', `${labels.join(' · ')}. ${t('common.netIndicatorHint')}`);
}

function setNetState(s) {
  if (!s || typeof s !== 'object') return;
  const next = { paused: Boolean(s.paused), offline: Boolean(s.offline) };
  if (next.paused === netState.paused && next.offline === netState.offline) return;
  netState = next;
  renderNetIndicator();
}

// ---------- Arrastrar y soltar ----------
// Soltar un archivo (o un enlace) fuera de una zona que lo acepte no tiene que hacer navegar la ventana.
// Las zonas propias (Versiones, packs...) llaman antes a preventDefault y no se tocan; el texto
// arrastrado sobre un campo de texto y los archivos sobre un <input type="file"> siguen funcionando normal.
function guardDrops() {
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const nativeDrop = (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return false;
    if (el.closest('input[type="file"]')) return true;
    return !hasFiles(e) && Boolean(el.closest('input, textarea, [contenteditable=""], [contenteditable="true"]'));
  };
  window.addEventListener('dragover', (e) => {
    if (e.defaultPrevented || nativeDrop(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  });
  window.addEventListener('drop', (e) => {
    if (e.defaultPrevented || nativeDrop(e)) return;
    e.preventDefault();
  });
}

// ---------- Fondo de estrellas ----------
function starfield() {
  const canvas = document.getElementById('stars');
  const ctx = canvas.getContext('2d');
  let stars = [];
  const resize = () => {
    canvas.width = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
    const count = Math.round((innerWidth * innerHeight) / 9000);
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height,
      r: (Math.random() < 0.85 ? 1 : 2) * devicePixelRatio,
      a: Math.random() * 0.6 + 0.2,
      s: Math.random() * 0.02 + 0.004,
      p: Math.random() * Math.PI * 2,
      warm: Math.random() < 0.3,
    }));
  };
  const draw = (time) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of stars) {
      const alpha = s.a * (0.65 + 0.35 * Math.sin(time * s.s * 0.06 + s.p));
      ctx.fillStyle = s.warm ? `rgba(255, 210, 150, ${alpha})` : `rgba(255, 244, 230, ${alpha})`;
      ctx.fillRect(Math.round(s.x), Math.round(s.y), s.r, s.r);
    }
  };
  resize();
  addEventListener('resize', resize);
  let last = 0;
  const loop = (time) => {
    if (!document.hidden && !document.body.classList.contains('reduce-motion') && Object.keys(store.running).length === 0 && time - last > 80) {
      draw(time);
      last = time;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// ---------- Bienvenida obligatoria ----------
function setOnboarding(on) {
  onboarding = on;
  document.body.classList.toggle('onboarding', on);
}

// La pagina de bienvenida la llama al terminar (ya guardo onboarded: true en los ajustes).
export async function finishOnboarding() {
  setOnboarding(false);
  await Promise.all([store.refreshSettings(), store.refreshAccounts(), store.refreshInstances()]);
  renderAccountChip();
  navigate('home');
}

function translateShell() {
  document.querySelectorAll('[data-win]').forEach((b) => {
    const label = t(`common.win_${b.dataset.win}`);
    b.title = label;
    b.setAttribute('aria-label', label);
  });
  const settingsBtn = document.getElementById('settings-btn');
  settingsBtn.title = t('nav.settings');
  settingsBtn.setAttribute('aria-label', t('nav.settings'));
  mount(document.getElementById('community-link'), discordButton({ className: 'btn ghost sidebar-discord', label: 'Discord' }));
  refreshRunningStatus();
  renderNetIndicator();
}

function refreshRunningStatus() {
  const count = Object.values(store.running).filter((r) => r.state === 'running').length;
  document.getElementById('tb-status').textContent = count ? `● ${t('common.gamesRunning', { count })}` : '';
}

// ---------- Inicio ----------
async function init() {
  guardDrops();
  document.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => api.app.window(b.dataset.win)));
  document.querySelector('.titlebar').addEventListener('dblclick', (e) => {
    if (!e.target.closest('.tb-btns, button')) api.app.window('maximize');
  });
  document.querySelector('.brand').addEventListener('click', () => navigate('home'));
  const settingsBtn = document.getElementById('settings-btn');
  settingsBtn.append(icon('settings'));
  settingsBtn.addEventListener('click', () => navigate('settings'));
  document.getElementById('account-chip').addEventListener('click', () => openAccounts());
  document.getElementById('tb-net')?.addEventListener('click', () => navigate('settings/storage'));

  [store.info] = await Promise.all([api.app.info(), store.refreshSettings(), store.refreshAccounts(), store.refreshInstances()]);
  await setLanguage(store.settings.language || systemLanguage(store.info.locale));
  // Tema, marca y accesibilidad: arrancan ya, en paralelo con el resto del inicio
  const early = Promise.all(EARLY_STARTUP.map(runStartup));
  await loadNs('common', 'nav');

  buildNav();
  translateShell();
  starfield();
  renderAccountChip();
  store.on('accounts', renderAccountChip);
  onLanguageChange(async () => {
    await loadNs('common', 'nav');
    buildNav();
    translateShell();
    renderAccountChip();
    renderRoute();
  });

  setOnboarding(!store.settings.onboarded && !store.info.skipOnboarding);

  api.on('task:update', (task) => {
    store.tasks.set(task.id, task);
    if (task.state !== 'running') setTimeout(() => store.tasks.delete(task.id), 3000);
    renderTask(task);
    store.emit('task', task);
    if (task.state === 'error' && !isCancelledTask(task)) toast('bad', task.title, task.detail, 8000);
  });
  api.on('instances:changed', () => store.refreshInstances());
  api.on('game:log', (id, lines) => {
    const arr = (store.gameLogs[id] = store.gameLogs[id] || []);
    arr.push(...lines);
    if (arr.length > 4000) arr.splice(0, arr.length - 4000);
    store.emit('game:log', { id, lines });
  });
  api.on('game:warnings', (id, warnings) => {
    const inst = store.instances.find((i) => i.id === id);
    toast('info', t('common.launchWarnings', { name: inst?.name || '' }), warnings.slice(0, 3).join(' · '), 9000);
  });
  api.on('game:state', (id, state) => {
    const st = state || {};
    const inst = store.instances.find((i) => i.id === id);
    // st.quiet: pruebas de la busqueda del culpable de un crash (sin avisos ni dialogo de crash)
    const quiet = Boolean(st.quiet);
    if (st.state === 'running') {
      store.running[id] = st;
      if (!quiet) toast('good', t('common.gameStarted'), t('common.gameStartedText', { name: inst?.name || '' }), 3000);
    } else if (st.state === 'preparing') {
      store.running[id] = st;
    } else {
      delete store.running[id];
      if (quiet) {
        /* lo informa la busqueda del culpable */
      } else if (st.state === 'crashed') showCrash(id, st);
      else if (st.error) {
        /* el error ya se mostro como tarea */
      } else if (st.state === 'stopped' && inst) {
        toast('info', t('common.gameClosed'), `${inst.name}`, 2500);
      }
      store.refreshInstances();
    }
    store.emit('running', store.running);
    refreshRunningStatus();
  });
  api.on('server:state', () => refreshServerDot());
  api.on('servers:changed', () => refreshServerDot());
  api.on('stats:milestone', (list) => {
    showMilestones(list).catch((err) => console.warn('[stats]', err));
  });
  api.on('downloads:stats', setNetState);
  // El modulo de almacenamiento puede no estar: sin indicador
  api.invoke('downloads:status').then(setNetState, () => {});

  await cloud.ready();
  social.on('unread', (n) => setNavBadge('messages', n));
  await social.init().catch((err) => console.warn('social', err));
  await Promise.resolve(voice.init?.()).catch((err) => console.warn('voice', err));
  await waitAtMost(early, EARLY_WAIT_MS);
  window.addEventListener('hashchange', renderRoute);
  if (onboarding) location.hash = '#/welcome';
  renderRoute();
  refreshServerDot();

  voice.on('room', (room) => setNavBadge('voice', room ? 1 : 0, 'dot'));
  voice.on('invite', ({ name, room }) => {
    const m = modal({
      title: t('common.voiceInviteTitle'),
      body: h('div', { class: 'row' }, avatarImg(name, 64), h('div', {}, h('strong', {}, name), ' ', t('common.voiceInviteText'), ' ', h('span', { class: 'kbd' }, room))),
      footer: [
        h('button', { class: 'btn ghost', onclick: () => m.close() }, t('common.notNow')),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: async () => {
              m.close();
              try {
                await voice.joinRoom(room);
                navigate('voice');
              } catch (err) {
                // Sala con contraseña: la pagina de voz la pide (#/voice/join/<codigo>)
                if (err?.code === 'password_required' || err?.code === 'bad_password') navigate(`voice/join/${encodeURIComponent(room)}`);
                else fail(t('common.joinFailed'), err);
              }
            },
          },
          icon('mic'),
          t('common.join'),
        ),
      ],
    });
  });
  social.on('message', ({ chatId, text, from } = {}) => {
    if (text && !(location.hash.startsWith('#/messages') && social.activeChat === chatId)) toast('info', t('common.messageFrom', { name: from }), text.slice(0, 120), 5000);
  });

  // Modulos que arrancan solos (sincronizacion de modpacks, asistente, invitaciones...)
  for (const load of STARTUP) runStartup(load);

  // Atajo de recarga (desarrollo)
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'r') location.reload();
  });
}

async function refreshServerDot() {
  try {
    const list = await api.servers.list();
    store.servers = list;
    setNavBadge('servers', list.some((s) => s.state === 'online' || s.state === 'starting') ? 1 : 0, 'dot');
  } catch {
    /* ignorar */
  }
}

export function playtimeLabel(inst) {
  return inst.playtime ? t('common.playtime', { time: fmtDuration(inst.playtime) }) : t('common.notPlayedYet');
}

init();
