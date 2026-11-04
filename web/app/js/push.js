// Avisos push con la app cerrada. El permiso se pide recién cuando la persona toca el botón.
// Se anota solo el endpoint del navegador (0035): el aviso llega vacío y el service worker consulta lo nuevo con la sesión.
import { deviceLabel, pushSupport, sameKeyBytes, urlB64ToBytes } from './logic.js';

const PREVIEW_KEY = 'prefs.preview';
const READY_MS = 5000;
const unavailable = () => Object.assign(new Error('push_unavailable'), { code: 'push_unavailable' });

/**
 * deps (para las pruebas): nav, notification, fetchFn, standalone().
 */
export function createPush({ client, config, idb, deps = {} }) {
  const nav = deps.nav ?? globalThis.navigator;
  const notification = () => deps.notification ?? globalThis.Notification;
  const fetchFn = deps.fetchFn ?? ((...args) => globalThis.fetch(...args));
  const standalone = deps.standalone ?? (() => matchMedia('(display-mode: standalone)').matches || nav.standalone === true);
  const hasPush = () => deps.hasPush ?? 'PushManager' in globalThis;
  const hasNotification = () => Boolean(notification());
  let keyText = null;

  const env = () => ({
    hasSW: 'serviceWorker' in nav,
    hasPush: hasPush(),
    hasNotification: hasNotification(),
    standalone: standalone(),
    ua: nav.userAgent,
    platform: nav.platform,
    touchPoints: nav.maxTouchPoints,
  });

  // La clave pública la da la Edge Function: no va en el repositorio y se puede cambiar.
  async function publicKey() {
    if (keyText) return keyText;
    let res;
    try {
      res = await fetchFn(config.pushFunction, { headers: { accept: 'application/json' } });
    } catch {
      throw unavailable();
    }
    if (!res.ok) throw unavailable();
    const data = await res.json().catch(() => null);
    if (typeof data?.publicKey !== 'string') throw unavailable();
    keyText = data.publicKey;
    return keyText;
  }

  // Si el service worker no llega a estar listo, no se queda esperando para siempre
  const registration = () => Promise.race([nav.serviceWorker.ready, new Promise((_, reject) => setTimeout(() => reject(unavailable()), READY_MS))]);

  async function subscribed() {
    return (await registration()).pushManager.getSubscription();
  }

  async function save(sub) {
    const { error } = await client.rpc('push_subscribe', { p_endpoint: sub.endpoint, p_label: deviceLabel(nav.userAgent) });
    if (error) throw error;
  }

  return {
    // { support: 'ok' | 'ios_install' | 'ios_old' | 'unsupported', permission, enabled }. Nunca pide permiso.
    async status() {
      const support = pushSupport(env());
      if (support !== 'ok') return { support, permission: 'default', enabled: false };
      const { permission } = notification();
      let enabled = false;
      if (permission === 'granted') {
        try {
          enabled = Boolean(await subscribed());
        } catch {
          enabled = false;
        }
      }
      // Se trae antes del toque: Safari exige que el permiso salga enseguida del gesto
      if (!enabled && permission !== 'denied') publicKey().catch(() => {});
      return { support, permission, enabled };
    },

    // Solo desde un toque de la persona. Lo primero es el permiso.
    async enable() {
      const permission = await notification().requestPermission();
      if (permission !== 'granted') throw Object.assign(new Error('push_denied'), { code: 'push_denied' });
      const key = urlB64ToBytes(await publicKey());
      const reg = await registration();
      let sub = await reg.pushManager.getSubscription();
      if (sub && !sameKeyBytes(sub.options?.applicationServerKey, key)) {
        await sub.unsubscribe();
        sub = null;
      }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await save(sub);
    },

    async disable() {
      if (pushSupport(env()) !== 'ok') return;
      const sub = await subscribed();
      if (!sub) return;
      const { endpoint } = sub;
      await sub.unsubscribe();
      const { error } = await client.rpc('push_unsubscribe', { p_endpoint: endpoint });
      if (error) console.warn('[app] borrar aviso', error.message);
    },

    // Al abrir: si ya estaba activado, avisa que este celular sigue en uso y corrige si cambió la clave.
    async refresh() {
      if (pushSupport(env()) !== 'ok' || notification().permission !== 'granted') return;
      const sub = await subscribed();
      if (!sub) return;
      const key = urlB64ToBytes(await publicKey());
      if (sameKeyBytes(sub.options?.applicationServerKey, key)) {
        await save(sub);
        return;
      }
      const { endpoint } = sub;
      await sub.unsubscribe();
      await client.rpc('push_unsubscribe', { p_endpoint: endpoint });
      await save(await (await registration()).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
    },

    previewEnabled: async () => (await idb.get(PREVIEW_KEY)) !== false,
    setPreview: (on) => idb.set(PREVIEW_KEY, Boolean(on)),
  };
}
