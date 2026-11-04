// Arranque de la app: sesión, rutas, barra de abajo, service worker e instalación.
import { createBackend } from './backend.js';
import { h, icon, mount, spinner } from './dom.js';
import { fakeAllowed, parseRoute } from './logic.js';
import { createPush } from './push.js';
import { Store } from './store.js';
import { accountScreen } from './screens/account.js';
import { chatScreen } from './screens/chat.js';
import { clipsScreen } from './screens/clips.js';
import { friendsScreen } from './screens/friends.js';
import { inboxScreen } from './screens/inbox.js';
import { renderLogin } from './screens/login.js';
import { messagesScreen } from './screens/messages.js';

const V = globalThis.VenusApp;
const lang = V.texts.pickLang(navigator.languages?.[0] || navigator.language);
const tr = V.texts.translator(lang);
document.documentElement.lang = lang;
document.title = 'Venus';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const fake = fakeAllowed(location) ? await import('../dev/fake.js') : null;
const client = fake ? fake.createFakeClient({ signedIn: params.get('login') !== '1' }) : V.session.createClient();
const { config } = V;

const SCREENS = { friends: friendsScreen, messages: messagesScreen, chat: chatScreen, clips: clipsScreen, inbox: inboxScreen, account: accountScreen };
const NAV = [
  { page: 'friends', hash: '#/friends', icon: 'users', label: 'nav_friends', badge: (b) => b.requests },
  { page: 'messages', hash: '#/messages', icon: 'message', label: 'nav_messages', badge: (b) => b.messages },
  { page: 'clips', hash: '#/clips', icon: 'film', label: 'nav_clips', badge: (b) => b.clips },
  { page: 'inbox', hash: '#/inbox', icon: 'bell', label: 'nav_inbox', badge: (b) => b.total },
];

let store = null;
let sessionUser = null;
let current = null;

// ---------- Instalar ----------
let installEvent = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
});
addEventListener('appinstalled', () => {
  installEvent = null;
});
const install = {
  available: () => Boolean(installEvent),
  prompt: async () => {
    const ev = installEvent;
    installEvent = null;
    await ev?.prompt?.();
  },
};

// ---------- Pantallas ----------
const titleEl = h('h1', { class: 'top-title pixel' });
const liveEl = h('div', { class: 'live-bar small', role: 'status', hidden: true });
const backEl = h('a', { class: 'icon-btn', href: '#/friends', hidden: true, 'aria-label': tr('back') }, icon('back'));
const meEl = h('a', { class: 'icon-btn top-me', href: '#/account', 'aria-label': tr('account_title') }, icon('user'));
const topbar = h('header', { class: 'topbar' }, backEl, titleEl, meEl);
const view = h('main', { class: 'view', id: 'view' });
const navEl = h('nav', { class: 'bottom-nav', 'aria-label': tr('nav_label') });
const shell = h('div', { class: 'shell' }, topbar, liveEl, view, navEl);

function drawNav(route) {
  const badges = store?.badges || { messages: 0, requests: 0, clips: 0, total: 0 };
  const active = route.page === 'chat' ? 'messages' : route.page;
  mount(
    navEl,
    NAV.map((item) => {
      const n = item.badge(badges);
      return h(
        'a',
        { class: `nav-item ${active === item.page ? 'active' : ''}`, href: item.hash, 'aria-current': active === item.page ? 'page' : null, 'aria-label': n ? `${tr(item.label)} (${n})` : tr(item.label) },
        h('span', { class: 'nav-ico' }, icon(item.icon, 24), n ? h('span', { class: 'nav-badge', 'aria-hidden': 'true' }, n > 99 ? '99+' : String(n)) : null),
        h('span', { class: 'nav-label' }, tr(item.label)),
      );
    }),
  );
  if (navigator.setAppBadge) (badges.total ? navigator.setAppBadge(badges.total) : navigator.clearAppBadge()).catch(() => {});
}

function drawLive() {
  const live = store?.live;
  liveEl.hidden = !store || store.state !== 'ready' || live === 'online';
  liveEl.textContent = navigator.onLine === false ? tr('live_offline') : tr('live_connecting');
}

function closeRouteDialogs() {
  for (const dlg of document.querySelectorAll('dialog[open]')) {
    dlg.close();
    dlg.remove();
  }
}

function render() {
  if (!store) return;
  const route = parseRoute(location.hash);
  closeRouteDialogs();
  current?.destroy?.();
  const ctx = { store, tr, lang, client, config, media: V.media, push: pushApi, install, navigate, signOut };
  current = SCREENS[route.page](ctx, route);
  shell.classList.toggle('fullscreen', Boolean(current.fullscreen));
  titleEl.textContent = current.title;
  backEl.hidden = !current.back;
  meEl.hidden = route.page === 'account';
  mount(view, current.el);
  view.scrollTop = 0;
  drawNav(route);
  clearChatNotifications(route);
}

function navigate(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

addEventListener('hashchange', render);

// ---------- Service worker ----------
let pushApi = null;
const swAllowed = !fake || params.get('sw') === '1';

async function registerSw() {
  if (!swAllowed || !('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch (err) {
    console.warn('[app] service worker', err?.message || err);
  }
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.origin && e.origin !== location.origin) return;
    if (e.data?.type === 'navigate') navigate(V.notify.safeHash(e.data.hash));
    else if (e.data?.type === 'inbox') store?.refreshInbox();
  });
}

// Lo que ya se está viendo no sigue en la bandeja del celular
async function clearChatNotifications(route) {
  if (route.page !== 'chat' || !swAllowed || !('serviceWorker' in navigator)) return;
  try {
    const chatId = store?.chatIdFor(route.userId);
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !chatId) return;
    for (const n of await reg.getNotifications({ tag: `venus-dm-${chatId}` })) n.close();
  } catch {
    /* sin notificaciones */
  }
}

// ---------- Sesión ----------
function showBoot() {
  mount(app, h('div', { class: 'boot' }, spinner()));
}

function startSession(user) {
  sessionUser = user.id;
  store = new Store({ backend: createBackend(client, user.id), someone: tr('someone') });
  pushApi = fake ? fake.createFakePush() : createPush({ client, config, idb: V.idb });
  mount(app, shell);
  if (!location.hash) history.replaceState(null, '', '#/friends');
  store.on('friends', () => drawNav(parseRoute(location.hash)));
  store.on('inbox', () => drawNav(parseRoute(location.hash)));
  store.on('live', drawLive);
  store.on('state', drawLive);
  render();
  store.start();
  pushApi.refresh?.().catch((err) => console.warn('[app] avisos', err?.message || err));
}

// Corta los avisos de este celular y borra todo lo guardado. La cáscara de la app queda: no tiene datos.
async function wipeLocal() {
  try {
    await Promise.race([pushApi?.disable(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  } catch {
    /* sin red o sin sesión: el servidor lo borra al primer aviso que rebote */
  }
  const old = store;
  store = null;
  sessionUser = null;
  current?.destroy?.();
  current = null;
  await old?.stop()?.catch?.(() => {});
  return async () => {
    await V.idb.clear().catch(() => {});
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      /* almacenamiento bloqueado */
    }
    try {
      const reg = swAllowed && 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      for (const n of (await reg?.getNotifications()) || []) n.close();
      await navigator.clearAppBadge?.();
    } catch {
      /* sin notificaciones */
    }
  };
}

// La sesión se terminó sola (venció, o se cerró desde el launcher en todos los dispositivos)
async function endSession() {
  const finish = await wipeLocal();
  await finish();
  closeRouteDialogs();
  renderLogin(app, { client, tr });
}

// Salir
async function signOut() {
  showBoot();
  const finish = await wipeLocal();
  try {
    await Promise.race([client.auth.signOut({ scope: 'local' }), new Promise((resolve) => setTimeout(resolve, 4000))]);
  } catch {
    /* sin red: la sesión local se borra igual */
  }
  await finish();
  location.replace(`${location.pathname}${location.search}`);
}

client.auth.onAuthStateChange((event, session) => {
  // Fuera del callback: supabase-js no admite llamarse a sí mismo desde acá
  setTimeout(() => {
    const id = session?.user?.id || null;
    if (id && id !== sessionUser) startSession(session.user);
    else if (!id && sessionUser) endSession();
  }, 0);
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    store?.onResume();
    if (store) clearChatNotifications(parseRoute(location.hash));
  }
});
addEventListener('online', () => {
  store?.onNetwork(true);
  drawLive();
});
addEventListener('offline', () => {
  store?.onNetwork(false);
  drawLive();
});

showBoot();
registerSw();
try {
  const { data } = await client.auth.getSession();
  if (data?.session?.user) {
    if (data.session.user.id !== sessionUser) startSession(data.session.user);
  } else if (!sessionUser) {
    renderLogin(app, { client, tr });
  }
} catch (err) {
  console.warn('[app] sesión', err?.message || err);
  renderLogin(app, { client, tr });
}
