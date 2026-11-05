// Comunidades: mensajes de bienvenida y de despedida, lógica pura sin DOM. renderGreeting es el espejo de
// private.community_greeting_render (supabase/migrations/0038_comunidades.sql): si cambia acá, cambia allá. Sirve para la vista
// previa; el texto que se publica lo arma el servidor al entrar o salir cada persona.
import { cleanText } from './logic.js';

export const GREETING_KINDS = ['join', 'leave'];
export const GREETING_LIMIT = 500;
// Español e inglés; el texto que escribe el dueño puede usar cualquiera.
export const GREETING_VARIABLES = ['usuario', 'comunidad', 'miembros'];
const ALIASES = { usuario: 'usuario', user: 'usuario', comunidad: 'comunidad', community: 'comunidad', miembros: 'miembros', members: 'miembros' };

/** ¿Todas las {variables} del texto son conocidas? */
export function greetingVariablesOk(text) {
  return [...String(text ?? '').matchAll(/\{([^{}]*)\}/g)].every((m) => ALIASES[m[1].toLowerCase()]);
}

/** Texto final con los datos de esa persona y comunidad. Las llaves de los nombres se quitan para que no se reemplacen dos veces. */
export function renderGreeting(template, { user = '', community = '', members = 0 } = {}) {
  const clean = (s) => String(s ?? '').replace(/[{}]/g, '');
  const values = { usuario: clean(user), comunidad: clean(community), miembros: String(Math.max(0, Number(members) || 0)) };
  return String(template ?? '').replace(/\{([^{}]*)\}/g, (all, name) => values[ALIASES[name.toLowerCase()]] ?? all).trim();
}

/** Estado vacío de una configuración (lo mismo que devuelve el servidor sin fila). */
export const emptyGreeting = () => ({ enabled: false, channelId: null, body: '', media: null, mediaStatus: null });

/** Canales donde se puede publicar: de texto o de anuncios y no privados. */
export const greetingChannels = (channels) => (channels || []).filter((c) => (c.kind === 'text' || c.kind === 'announcement') && !c.isPrivate);

/** Revisa la configuración antes de mandarla; el servidor repite estas reglas. */
export function validateGreeting(value, channels = []) {
  const body = cleanText(value?.body ?? '');
  if (body === null || [...body].length > GREETING_LIMIT) return { ok: false, error: 'bad_greeting_text' };
  if (!greetingVariablesOk(body)) return { ok: false, error: 'bad_greeting_variable' };
  const channelId = value?.channelId || null;
  if (channelId && !greetingChannels(channels).some((c) => c.id === channelId)) return { ok: false, error: 'bad_greeting_channel' };
  const enabled = value?.enabled === true;
  if (enabled && !channelId) return { ok: false, error: 'greeting_needs_channel' };
  if (enabled && !body && !value?.media) return { ok: false, error: 'greeting_empty' };
  return { ok: true, value: { enabled, channelId, body, media: value?.media || null } };
}

/** Lo que cambió respecto de lo guardado; null si nada. */
export function greetingPatch(saved, draft) {
  const base = { ...emptyGreeting(), ...(saved || {}) };
  const patch = {};
  if (Boolean(draft.enabled) !== Boolean(base.enabled)) patch.enabled = Boolean(draft.enabled);
  if ((draft.channelId || null) !== (base.channelId || null)) patch.channelId = draft.channelId || null;
  if ((draft.body || '') !== (base.body || '')) patch.body = draft.body || '';
  if (JSON.stringify(draft.media || null) !== JSON.stringify(base.media || null)) patch.media = draft.media || null;
  return Object.keys(patch).length ? patch : null;
}

/** GIF elegido en KLIPY a la forma que acepta el servidor (la misma de los banners del perfil). */
export function klipyMedia(gif) {
  const media = { kind: 'klipy', url: gif?.url };
  if (gif?.still) media.still = gif.still;
  if (typeof gif?.slug === 'string' && gif.slug) media.slug = gif.slug;
  return media;
}
