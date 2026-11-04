// Service worker de la app. Guarda solo la cáscara (HTML, CSS, JS, fuentes e íconos): nunca datos de la cuenta ni respuestas de
// la API. Las peticiones a otros dominios (Supabase, KLIPY) ni pasan por acá.
// Un aviso push llega vacío: se consulta lo nuevo con la sesión guardada y se muestra. Sin sesión, un aviso genérico.
// Es un script clásico (no módulo) para que funcione en todos los navegadores con Web Push.
importScripts('./vendor/supabase.js', './js/shared/config.js', './js/shared/idb.js', './js/shared/session.js', './js/shared/texts.js', './js/shared/media.js', './js/shared/notify.js');

const VERSION = 'venus-app-1';
const SHELL = [
  './',
  './manifest.webmanifest',
  './css/app.css',
  './vendor/supabase.js',
  './js/shared/config.js',
  './js/shared/idb.js',
  './js/shared/session.js',
  './js/shared/texts.js',
  './js/shared/media.js',
  './js/shared/notify.js',
  './js/main.js',
  './js/logic.js',
  './js/dom.js',
  './js/backend.js',
  './js/store.js',
  './js/push.js',
  './js/screens/login.js',
  './js/screens/friends.js',
  './js/screens/messages.js',
  './js/screens/chat.js',
  './js/screens/clips.js',
  './js/screens/inbox.js',
  './js/screens/account.js',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png',
  './assets/apple-touch-icon.png',
  './assets/badge-96.png',
  './assets/fonts/outfit-latin-400-normal.woff2',
  './assets/fonts/outfit-latin-500-normal.woff2',
  './assets/fonts/outfit-latin-600-normal.woff2',
  './assets/fonts/outfit-latin-700-normal.woff2',
  './assets/fonts/pixelify-sans-latin-700-normal.woff2',
];

const { idb, notify, session, texts, config } = self.VenusApp;
const LAST_KEY = 'notify.last';
const PREVIEW_KEY = 'prefs.preview';
const tr = () => texts.translator(texts.pickLang(self.navigator.language));
const shellUrls = new Set(SHELL.map((path) => new URL(path, self.registration.scope).href));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Navegar: primero la red, sin red la cáscara. El HTML no lleva datos.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('./', { cacheName: VERSION })));
    return;
  }
  if (!shellUrls.has(url.origin + url.pathname)) return;
  // Cáscara: sale al toque de la caché y se actualiza por detrás.
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const cached = await cache.match(url.origin + url.pathname);
      const refresh = fetch(request)
        .then((res) => {
          if (res.ok) cache.put(url.origin + url.pathname, res.clone());
          return res;
        })
        .catch(() => cached);
      if (cached) {
        event.waitUntil(refresh);
        return cached;
      }
      return refresh;
    }),
  );
});

// ---------- Avisos ----------
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);
}

const isIos = () => /iphone|ipad|ipod/i.test(self.navigator.userAgent) || (self.navigator.platform === 'MacIntel' && self.navigator.maxTouchPoints > 1);

// null si no hay sesión o no se pudo consultar. Con la sesión, supabase-js renueva el token si venció.
async function fetchInbox() {
  try {
    const client = session.createClient({ autoRefresh: false });
    const { data } = await withTimeout(client.auth.getSession(), 8000);
    if (!data?.session) return null;
    const preview = (await idb.get(PREVIEW_KEY)) !== false;
    const res = await withTimeout(client.rpc('app_inbox', { p_preview: preview }), 8000);
    return res.error ? null : res.data;
  } catch {
    return null;
  }
}

async function onPush() {
  const inbox = await fetchInbox();
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) client.postMessage({ type: 'inbox' });
  // Con la app a la vista alcanza con lo que se ve adentro. Safari igual exige mostrar algo en cada aviso.
  if (!isIos() && windows.some((c) => c.visibilityState === 'visible' && c.focused)) return;
  const last = Number(await idb.get(LAST_KEY).catch(() => 0)) || 0;
  const n = notify.buildNotification(inbox, { last, tr: tr(), base: config.url });
  if (n.stamp) await idb.set(LAST_KEY, n.stamp).catch(() => {});
  await self.registration.showNotification(n.title, {
    body: n.body,
    tag: n.tag,
    renotify: true,
    icon: 'assets/icon-192.png',
    badge: 'assets/badge-96.png',
    data: { hash: n.hash },
  });
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    onPush().catch(() => {
      const t = tr();
      return self.registration.showNotification(t('push_title'), { body: t('push_generic'), tag: 'venus-generic', icon: 'assets/icon-192.png', badge: 'assets/badge-96.png', data: { hash: '#/inbox' } });
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const hash = notify.safeHash(event.notification.data?.hash);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((c) => c.url.startsWith(self.registration.scope));
      if (open) {
        await open.focus();
        open.postMessage({ type: 'navigate', hash });
        return;
      }
      await self.clients.openWindow(new URL(hash, self.registration.scope).href);
    })(),
  );
});

// El navegador puede renovar la suscripción: se anota la nueva con la sesión guardada.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const client = session.createClient({ autoRefresh: false });
      const { data } = await client.auth.getSession();
      if (!data?.session) return;
      let sub = event.newSubscription;
      if (!sub) {
        const res = await fetch(config.pushFunction);
        const { publicKey } = await res.json();
        const clean = publicKey.replace(/-/g, '+').replace(/_/g, '/');
        const key = Uint8Array.from(atob(clean + '='.repeat((4 - (clean.length % 4)) % 4)), (c) => c.charCodeAt(0));
        sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      await client.rpc('push_subscribe', { p_endpoint: sub.endpoint });
      if (event.oldSubscription && event.oldSubscription.endpoint !== sub.endpoint) {
        await client.rpc('push_unsubscribe', { p_endpoint: event.oldSubscription.endpoint });
      }
    })().catch((err) => console.warn('[app] renovar aviso', err?.message || err)),
  );
});
