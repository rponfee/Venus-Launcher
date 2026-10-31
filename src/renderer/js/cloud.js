// Conexion con Supabase: cuenta de Venus (email + contraseña), perfil publico y el cliente que usan
// amigos, mensajes, voz, compartir modpacks y la nube. El proyecto es siempre el del launcher (cloud:config lee
// core/cloud-defaults.js; no se cambia desde la interfaz). La sesion se guarda cifrada en el proceso
// principal (canales secure:*), nunca en localStorage.
//
//   import { cloud } from './cloud.js';
//   await cloud.ready();                       // espera la inicializacion
//   if (cloud.isSignedIn()) cloud.client.from('messages').select('*')...
//   cloud.on('auth', (session) => ...); cloud.on('profile', (profile) => ...)
import { api } from './store.js';
import { t } from './i18n.js';

// Clave con la que supabase-js guarda la sesion (en secure:* queda como 'sb.venus-auth', '-code-verifier'...)
const STORAGE_KEY = 'venus-auth';

const listeners = new Map();
let client = null;
let config = { url: '', anonKey: '', configured: false };
let session = null;
let profile = null;
let initPromise = null;
let refreshListener = null;

// Adaptador de almacenamiento asincrono para supabase-js (las claves quedan cifradas con DPAPI/Keychain).
const secureStorage = {
  getItem: async (key) => (await api.invoke('secure:get', `sb.${key}`)) ?? null,
  setItem: (key, value) => api.invoke('secure:set', `sb.${key}`, value),
  removeItem: (key) => api.invoke('secure:remove', `sb.${key}`),
};

// Borra la sesion guardada sin depender de la red: la sesion, el verificador PKCE (tambien los de cada
// flujo pendiente, por ejemplo una recuperacion de contraseña a medias) y la copia del usuario.
async function clearStoredSession() {
  let flows = [];
  try {
    const raw = await api.invoke('secure:get', `sb.${STORAGE_KEY}-flows-code-verifier`);
    const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(list)) flows = list.filter((id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id));
  } catch {
    /* sin flujos pendientes */
  }
  const keys = [STORAGE_KEY, `${STORAGE_KEY}-code-verifier`, `${STORAGE_KEY}-user`, `${STORAGE_KEY}-flows-code-verifier`, ...flows.map((id) => `${STORAGE_KEY}-flow-${id}-code-verifier`)];
  await Promise.all(keys.map((k) => api.invoke('secure:remove', `sb.${k}`).catch(() => {})));
}

function waitAtMost(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]).finally(() => clearTimeout(timer));
}

function emit(evt, data) {
  for (const fn of listeners.get(evt) || []) {
    try {
      fn(data);
    } catch (err) {
      console.error(err);
    }
  }
}

async function loadProfile() {
  if (!client || !session?.user) {
    profile = null;
    emit('profile', null);
    return null;
  }
  const { data, error } = await client.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
  if (error) console.warn('[cloud] perfil', error.message);
  profile = data || null;
  emit('profile', profile);
  return profile;
}

async function doInit() {
  config = await api.invoke('cloud:config').catch(() => ({ url: '', anonKey: '', configured: false }));
  if (!config.configured || !window.supabase?.createClient) {
    client = null;
    session = null;
    profile = null;
    emit('config', config);
    return;
  }
  const c = window.supabase.createClient(config.url, config.anonKey, {
    auth: {
      storage: secureStorage,
      storageKey: STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
    realtime: { params: { eventsPerSecond: 20 } },
  });
  client = c;
  c.auth.onAuthStateChange((event, s) => {
    if (client !== c) return; // cliente anterior (ya reemplazado)
    const changed = (s?.user?.id || null) !== (session?.user?.id || null);
    session = s;
    emit('auth', session);
    if (changed || event === 'USER_UPDATED') loadProfile();
  });
  const { data } = await c.auth.getSession();
  if (client !== c) return;
  session = data.session;
  // El proceso principal (IA) pide renovar la sesion cuando el token esta por vencer.
  if (!refreshListener) {
    refreshListener = api.on('cloud:refreshSession', () => {
      client?.auth.refreshSession().catch((err) => console.warn('[cloud] refresh', err?.message));
    });
  }
  emit('config', config);
  emit('auth', session);
  await loadProfile();
}

export const cloud = {
  get client() {
    return client;
  },
  get session() {
    return session;
  },
  get user() {
    return session?.user || null;
  },
  get profile() {
    return profile;
  },
  get config() {
    return config;
  },

  isConfigured() {
    return Boolean(config.configured && client);
  },

  isSignedIn() {
    return Boolean(client && session?.user);
  },

  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt)?.delete(fn);
  },

  // Inicializa una sola vez (se puede llamar desde cualquier modulo).
  ready() {
    if (!initPromise) initPromise = doInit().catch((err) => console.error('[cloud]', err));
    return initPromise;
  },

  // Cierra la sesion de este equipo (si hay red) y borra la sesion guardada aunque no la haya.
  async forgetSession() {
    const c = client;
    if (c) {
      try {
        const res = await waitAtMost(c.auth.signOut({ scope: 'local' }), 4000);
        if (res?.error) console.warn('[cloud] cerrar sesión', res.error.message);
      } catch (err) {
        console.warn('[cloud] cerrar sesión', err?.message || err);
      }
    }
    await clearStoredSession();
    if (session || profile) {
      session = null;
      profile = null;
      emit('auth', null);
      emit('profile', null);
    }
  },

  // Lanza un error legible si no hay nube o sesion.
  requireSession() {
    if (!this.isConfigured() || !session?.user) throw new Error(t('common.requiresCloud'));
    return session.user;
  },

  async signUp({ email, password, username }) {
    if (!client) throw new Error(t('common.requiresCloud'));
    const { data, error } = await client.auth.signUp({ email, password, options: { data: { username } } });
    if (error) throw error;
    return data; // si data.session es null, el proyecto exige confirmar el email (ver verifyEmailCode)
  },

  // Vuelve a mandar el codigo de confirmacion del alta.
  async resendSignupCode(email) {
    if (!client) throw new Error(t('common.requiresCloud'));
    const { data, error } = await client.auth.resend({ type: 'signup', email });
    if (error) throw error;
    return data;
  },

  // Confirmacion por codigo de 6 digitos (plantilla de email con {{ .Token }}).
  // type: 'signup' (alta) o 'recovery' (despues de resetPassword; deja una sesion para updatePassword).
  async verifyEmailCode(email, token, type = 'signup') {
    if (!client) throw new Error(t('common.requiresCloud'));
    const { data, error } = await client.auth.verifyOtp({ email, token, type });
    if (error) throw error;
    return data;
  },

  async signIn({ email, password }) {
    if (!client) throw new Error(t('common.requiresCloud'));
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  async resetPassword(email) {
    if (!client) throw new Error(t('common.requiresCloud'));
    const { error } = await client.auth.resetPasswordForEmail(email);
    if (error) throw error;
  },

  // Cambia la contraseña de la sesion actual (tambien la de recuperacion de verifyEmailCode(..., 'recovery')).
  async updatePassword(password) {
    if (!client) throw new Error(t('common.requiresCloud'));
    const { data, error } = await client.auth.updateUser({ password });
    if (error) throw error;
    return data;
  },

  async signOut() {
    if (!client) return;
    const { error } = (await client.auth.signOut()) || {};
    // sin red el servidor no se entera, pero en este equipo la sesion se cierra igual
    if (error) {
      console.warn('[cloud] cerrar sesión', error.message);
      await clearStoredSession();
    }
    session = null;
    profile = null;
    emit('auth', null);
    emit('profile', null);
  },

  loadProfile,

  async updateProfile(patch) {
    const user = this.requireSession();
    const { data, error } = await client.from('profiles').update(patch).eq('id', user.id).select('*').single();
    if (error) throw error;
    profile = data;
    emit('profile', profile);
    return profile;
  },
};
