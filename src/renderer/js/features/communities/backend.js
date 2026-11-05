// Comunidades: acceso a los datos (RPC de 0033 y 0038, Realtime de community_messages y el bucket community-media). En el modo de
// capturas (VENUS_DEVSHOT + VENUS_REWARDS_FAKE, sin empaquetar) responde fake.js, en memoria y sin red.
//   const b = await groupsBackend();
//   b.fake, b.signedIn(), b.userId(), b.onAuth(fn) -> off, await b.rpc(nombre, args), await b.friends(), b.isBlocked(userId)
//   b.watchChannel(canal, { onRow(fila), onStatus(estado) }) -> off
//   await b.mediaUrl(ruta) -> URL firmada de un GIF subido (o null), await b.uploadMedia(ruta, archivo), await b.removeMedia(ruta)
// Los errores son GroupError con .code (el texto de la excepción del servidor o unavailable, network, noSession, server).
import { api } from '../../store.js';
import { cloud } from '../../cloud.js';
import { t, has } from '../../i18n.js';
import { social } from '../../social.js';
import { backend } from '../../pages/rewards/backend.js';
import { classifyGroupError } from './logic.js';

export const MEDIA_BUCKET = 'community-media';
const URL_TTL_MS = 50 * 60000; // las URL firmadas duran una hora; se renuevan antes

export class GroupError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'GroupError';
    this.code = code;
  }
}

/** Mensaje para el usuario de un error del servidor; lo técnico queda en la consola. */
export function errText(err) {
  const code = err?.code || classifyGroupError(err);
  if (code === 'too_many_channels') return t('communities.cmChannelsFull');
  return has(`communities.err_${code}`) ? t(`communities.err_${code}`) : t('communities.err_server');
}

let warned = false;
function toGroupError(err, where) {
  if (err instanceof GroupError) return err;
  const code = classifyGroupError(err);
  if (['unavailable', 'server'].includes(code) && !warned) {
    warned = true; // sin servicio o sin la migración: una vez por sesión alcanza
    console.warn(`[communities] ${where}:`, err?.code || '', err?.message || err);
  }
  const result = new GroupError(code, err?.message);
  if (code === 'slowmode') {
    try {
      const details = typeof err?.details === 'string' ? JSON.parse(err.details) : err?.details;
      if (typeof details?.nextPostAt === 'string' && Number.isFinite(Date.parse(details.nextPostAt))) result.nextPostAt = details.nextPostAt;
    } catch { /* detalles opcionales: nunca mostrar la respuesta técnica */ }
  }
  return result;
}

function realBackend(b) {
  const urls = new Map();
  return {
    fake: false,
    signedIn: () => b.signedIn(),
    userId: () => b.userId(),
    onAuth: (fn) => b.onAuth(fn),
    async rpc(name, args) {
      if (!cloud.isSignedIn()) throw new GroupError('noSession');
      let res;
      try {
        res = await cloud.client.rpc(name, args);
      } catch (err) {
        throw toGroupError(err, name);
      }
      if (res?.error) throw toGroupError(res.error, name);
      const data = res?.data ?? null;
      // Los códigos equivocados vuelven como { error } para que el intento quede contado (ver 0033)
      if (data && !Array.isArray(data) && typeof data.error === 'string') throw new GroupError(data.error);
      return data;
    },
    async friends() {
      await social.init?.();
      for (let i = 0; i < 40 && social.state === 'loading'; i++) await new Promise((r) => setTimeout(r, 100));
      return (social.friends || []).map((f) => ({ id: f.id, name: f.name || f.profile?.username || '?', profile: f.profile || null }));
    },
    isBlocked: (userId) => (social.blocked || []).some((x) => x.id === userId),
    // Postgres Changes respeta la política de community_messages: a quien no es miembro no le llega nada.
    watchChannel(channelId, { onRow, onStatus } = {}) {
      let closed = false;
      const filter = `channel_id=eq.${channelId}`;
      const channel = cloud.client
        .channel(`community:${channelId}:${Date.now().toString(36)}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'community_messages', filter }, (p) => !closed && onRow?.(p.new))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'community_messages', filter }, (p) => !closed && onRow?.(p.new))
        .subscribe((status) => !closed && onStatus?.(status));
      return () => {
        closed = true;
        cloud.client.removeChannel(channel).catch(() => {});
      };
    },
    // El bucket es privado: la política de Storage decide quién puede pedir la URL firmada (aprobado, o dueño/autor/administrador).
    async mediaUrl(path) {
      if (typeof path !== 'string' || !cloud.isSignedIn()) return null;
      const hit = urls.get(path);
      if (hit && hit.until > Date.now()) return hit.url;
      try {
        const { data, error } = await cloud.client.storage.from(MEDIA_BUCKET).createSignedUrl(path, 3600);
        if (error || !data?.signedUrl) return null;
        urls.set(path, { url: data.signedUrl, until: Date.now() + URL_TTL_MS });
        return data.signedUrl;
      } catch {
        return null;
      }
    },
    async uploadMedia(path, file) {
      if (!cloud.isSignedIn()) throw new GroupError('noSession');
      let res;
      try {
        res = await cloud.client.storage.from(MEDIA_BUCKET).upload(path, file, { contentType: file.type, upsert: false, cacheControl: '3600' });
      } catch (err) {
        throw toGroupError(err, 'upload');
      }
      if (res?.error) throw new GroupError(/row-level security|not authorized|403/i.test(String(res.error.message)) ? 'upload_forbidden' : 'upload_failed', res.error.message);
    },
    async removeMedia(path) {
      urls.delete(path);
      try {
        await cloud.client.storage.from(MEDIA_BUCKET).remove([path]);
      } catch (err) {
        console.warn('[communities] borrar archivo:', err?.message || err);
      }
    },
  };
}

let fakeGroups = null;
let real = null;

export async function groupsBackend() {
  const b = await backend();
  if (b.fake) {
    if (!fakeGroups) {
      const { createFakeGroups } = await import('./fake.js');
      const scenario = await api.invoke('rewards:fakeMode').catch(() => null);
      fakeGroups = createFakeGroups(typeof scenario === 'string' ? scenario : 'demo', b);
    }
    return fakeGroups;
  }
  real ||= realBackend(b);
  return real;
}
