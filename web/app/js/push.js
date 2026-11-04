// Avisos push con la app cerrada. El permiso se pide recién cuando la persona toca el botón.
// Se anota solo el endpoint del navegador (0035): el aviso llega vacío y el service worker consulta lo nuevo con la sesión.
import { deviceLabel, pushSupport, sameKeyBytes, urlB64ToBytes } from './logic.js';

const PREVIEW_KEY = 'prefs.preview';

async function publicKey(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw Object.assign(new Error('push_unavailable'), { code: 'push_unavailable' });
  const data = await res.json();
  if (typeof data?.publicKey !== 'string') throw Object.assign(new Error('push_unavailable'), { code: 'push_unavailable' });
  return data.publicKey;
}

export function createPush({ client, config, idb }) {
  const env = () => ({
    hasSW: 'serviceWorker' in navigator,
    hasPush: 'PushManager' in globalThis,
    hasNotification: 'Notification' in globalThis,
    standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
    ua: navigator.userAgent,
    platform: navigator.platform,
    touchPoints: navigator.maxTouchPoints,
  });
  const registration = () => navigator.serviceWorker.ready;

  async function subscribed() {
    const reg = await registration();
    return reg.pushManager.getSubscription();
  }

  async function save(sub) {
    const { error } = await client.rpc('push_subscribe', { p_endpoint: sub.endpoint, p_label: deviceLabel(navigator.userAgent) });
    if (error) throw error;
  }

  return {
    // { support: 'ok' | 'ios_install' | 'ios_old' | 'unsupported', permission, enabled }
    async status() {
      const support = pushSupport(env());
      if (support !== 'ok') return { support, permission: 'default', enabled: false };
      const permission = Notification.permission;
      let enabled = false;
      if (permission === 'granted') {
        try {
          enabled = Boolean(await subscribed());
        } catch {
          enabled = false;
        }
      }
      return { support, permission, enabled };
    },

    // Solo desde un toque de la persona
    async enable() {
      const key = urlB64ToBytes(await publicKey(config.pushFunction));
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw Object.assign(new Error('push_denied'), { code: 'push_denied' });
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
      const sub = await subscribed();
      if (!sub) return;
      const { endpoint } = sub;
      await sub.unsubscribe();
      const { error } = await client.rpc('push_unsubscribe', { p_endpoint: endpoint });
      if (error) console.warn('[app] borrar aviso', error.message);
    },

    // Al abrir: si ya estaba activado, avisa que este celular sigue en uso y corrige si cambió la clave.
    async refresh() {
      if (pushSupport(env()) !== 'ok' || Notification.permission !== 'granted') return;
      const sub = await subscribed();
      if (!sub) return;
      const key = urlB64ToBytes(await publicKey(config.pushFunction));
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
