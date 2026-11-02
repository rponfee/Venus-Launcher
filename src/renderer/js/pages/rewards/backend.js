// Venus Points: acceso a los datos (RPC de 0020/0021 y la tabla shop_items). Lo usan la página, features/rewards.js
// y features/premium.js. En el modo de capturas (VENUS_DEVSHOT + VENUS_REWARDS_FAKE, sin empaquetar) usa datos de
// ejemplo en memoria (fake.js) y no habla con ningún servidor.
//   const b = await backend();
//   b.signedIn(), b.userId(), await b.rpc('points_me'), await b.shopItems(), b.onAuth(fn) -> off
// Los errores son RewardsError con .code (logic.js: SERVER_CODES y CLIENT_CODES).
import { cloud } from '../../cloud.js';
import { store, api } from '../../store.js';
import { classifyError, errorDetail } from './logic.js';

export class RewardsError extends Error {
  constructor(code, message, detail = null) {
    super(message || code);
    this.name = 'RewardsError';
    this.code = code;
    this.detail = detail;
  }
}

// Convierte cualquier error (PostgrestError, de red o ya clasificado) en RewardsError.
export function toRewardsError(err, where = '') {
  if (err instanceof RewardsError) return err;
  const code = classifyError(err);
  if (['unavailable', 'server', 'network'].includes(code)) console.warn(`[rewards] ${where}`, err?.code || '', err?.message || err);
  return new RewardsError(code, err?.message, errorDetail(err));
}

const real = {
  fake: false,
  signedIn: () => cloud.isSignedIn(),
  userId: () => cloud.user?.id || null,
  async rpc(name, args) {
    if (!cloud.isSignedIn()) throw new RewardsError('noSession');
    let res;
    try {
      res = await cloud.client.rpc(name, args);
    } catch (err) {
      throw toRewardsError(err, name);
    }
    if (res?.error) throw toRewardsError(res.error, name);
    return res?.data ?? null;
  },
  async shopItems() {
    if (!cloud.isSignedIn()) throw new RewardsError('noSession');
    let res;
    try {
      res = await cloud.client.from('shop_items').select('id, kind, price, premium_only, sort, data').order('sort');
    } catch (err) {
      throw toRewardsError(err, 'shop_items');
    }
    if (res?.error) throw toRewardsError(res.error, 'shop_items');
    return Array.isArray(res?.data) ? res.data : [];
  },
  onAuth: (fn) => cloud.on('auth', fn),
};

let fakePromise = null;
function fakeBackend() {
  if (!store.info?.devshot) return Promise.resolve(null);
  fakePromise ||= api
    .invoke('rewards:fakeMode')
    .then(async (state) => (state ? (await import('./fake.js')).createFakeBackend(state) : null))
    .catch(() => null);
  return fakePromise;
}

/** El backend que corresponde: el de ejemplo en el modo de capturas o el de Supabase (con cloud.ready()). */
export async function backend() {
  const fake = await fakeBackend();
  if (fake) return fake;
  await cloud.ready();
  return real;
}
