// Clanes y comunidades: acceso a los datos (RPC de 0033 y Realtime de community_messages). En el modo de capturas
// (VENUS_DEVSHOT + VENUS_REWARDS_FAKE, sin empaquetar) responde fake.js, en memoria y sin red.
//   const b = await groupsBackend();
//   b.fake, b.signedIn(), b.userId(), b.onAuth(fn) -> off, await b.rpc(nombre, args), await b.friends(), b.isBlocked(userId)
//   b.watchChannel(canal, { onRow(fila), onStatus(estado) }) -> off
// Los errores son GroupError con .code (el texto de la excepción del servidor o unavailable, network, noSession, server).
import { api } from '../../store.js';
import { cloud } from '../../cloud.js';
import { t, has } from '../../i18n.js';
import { social } from '../../social.js';
import { backend } from '../../pages/rewards/backend.js';
import { classifyGroupError } from './logic.js';

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
  return has(`clans.err_${code}`) ? t(`clans.err_${code}`) : t('clans.err_server');
}

let warned = false;
function toGroupError(err, where) {
  if (err instanceof GroupError) return err;
  const code = classifyGroupError(err);
  if (['unavailable', 'server'].includes(code) && !warned) {
    warned = true; // sin servicio o sin la migración: una vez por sesión alcanza
    console.warn(`[clans] ${where}:`, err?.code || '', err?.message || err);
  }
  return new GroupError(code, err?.message);
}

function realBackend(b) {
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
