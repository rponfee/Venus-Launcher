// Fondos del chat y escenarios de voz de una comunidad, lógica pura sin DOM. Un fondo ('chat') cubre el chat de texto de toda la
// comunidad o de un canal; un escenario ('stage') es el fondo que ve todo el mundo dentro de una sala de voz. Cada uno es un
// incluido (presets.js) o una imagen/GIF aprobado de la galería, y gasta un cupo del plan de la comunidad. Los animados piden
// un plan que los permita. Lo que el plan ya no alcanza llega con state != 'ok' y no se dibuja para los miembros.
// RPC: community_backdrops_get, community_backdrop_set, community_backdrop_clear y community_stage_get (0044_clanes_planes.sql).
import { findPreset } from './presets.js';

export const LOOKS_EVENT = 'venus:community-looks';
export const BACKDROP_KINDS = ['chat', 'stage'];
export const DIM = Object.freeze({ min: 0, max: 80, def: 35 });
export const BLUR = Object.freeze({ min: 0, max: 20, def: 0 });
// Estados que manda el servidor: ok, hidden_plan (ya no hay cupo), hidden_animated (el plan no permite animados), media_unavailable.
export const BACKDROP_STATES = ['ok', 'hidden_plan', 'hidden_animated', 'media_unavailable'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clamp = (value, { min, max, def }) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

function normalizeMedia(raw) {
  if (!raw || typeof raw !== 'object' || !UUID.test(String(raw.id))) return null;
  return {
    id: raw.id,
    source: raw.source === 'klipy' ? 'klipy' : 'upload',
    path: typeof raw.path === 'string' ? raw.path : null,
    url: typeof raw.url === 'string' ? raw.url : null,
    still: typeof raw.still === 'string' ? raw.still : null,
    width: Number(raw.width) || 0,
    height: Number(raw.height) || 0,
    animated: raw.animated === true,
    name: typeof raw.name === 'string' ? raw.name.slice(0, 40) : '',
  };
}

/** Un fondo o escenario como lo manda el servidor; null si no tiene forma válida (un incluido que no existe, un tipo raro). */
export function normalizeBackdrop(raw) {
  if (!raw || typeof raw !== 'object' || !BACKDROP_KINDS.includes(raw.kind)) return null;
  const channelId = typeof raw.channelId === 'string' && UUID.test(raw.channelId) ? raw.channelId : null;
  const base = {
    id: typeof raw.id === 'string' ? raw.id : '', kind: raw.kind, channelId,
    dim: clamp(raw.dim, DIM), blur: clamp(raw.blur, BLUR),
    state: BACKDROP_STATES.includes(raw.state) ? raw.state : 'ok',
  };
  if (raw.source === 'preset') {
    const preset = findPreset(raw.preset, raw.kind);
    return preset ? { ...base, source: 'preset', preset: preset.id, media: null, animated: preset.animated } : null;
  }
  const media = normalizeMedia(raw.media);
  return raw.source === 'media' && media ? { ...base, source: 'media', preset: null, media, animated: media.animated || raw.animated === true } : null;
}

/** Respuesta de community_backdrops_get: { items }. Sin respuesta válida, lista vacía (se ve "no disponible" y nada se rompe). */
export function normalizeBackdrops(raw) {
  const items = (Array.isArray(raw?.items) ? raw.items : []).map(normalizeBackdrop).filter(Boolean);
  return { items };
}

/** El fondo que corresponde a un canal: el suyo, o el de toda la comunidad. Solo los que valen (state ok). */
export function pickBackdrop(items, kind, channelId) {
  const usable = (Array.isArray(items) ? items : []).filter((b) => b.kind === kind && b.state === 'ok');
  return usable.find((b) => b.channelId === (channelId || null) && channelId) || usable.find((b) => b.channelId === null) || null;
}

/** Las filas del editor: la de toda la comunidad y una por canal del tipo que sirve (texto, anuncios y foros / voz). */
export function scopeRows(community, kind, items) {
  const wanted = kind === 'stage' ? ['voice'] : ['text', 'announcement', 'forum'];
  const channels = [...(community?.channels || [])].filter((c) => wanted.includes(c.kind)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const own = (channelId) => (Array.isArray(items) ? items : []).find((b) => b.kind === kind && b.channelId === channelId) || null;
  return [{ channelId: null, channel: null, backdrop: own(null) }, ...channels.map((channel) => ({ channelId: channel.id, channel, backdrop: own(channel.id) }))];
}

/** ¿Es animada la elección? Un incluido lo dice en presets.js; una imagen de la galería, el servidor (GIF, KLIPY, WebP animado). */
export function choiceAnimated(choice) {
  if (choice?.source === 'preset') return findPreset(choice.id)?.animated === true;
  return choice?.source === 'media' && choice.item?.animated === true;
}

/**
 * Lo mismo que comprueba el servidor, para avisar antes de pedirlo: null si se puede, o el código del error
 * (plan_limit, plan_animated, bad_choice). existing: el fondo que ya hay en ese lugar (cambiarlo no gasta otro cupo).
 */
export function checkChoice(planState, kind, existing, choice) {
  if (!choice || !['preset', 'media'].includes(choice.source)) return 'bad_choice';
  if (choice.source === 'preset' && !findPreset(choice.id, kind)) return 'bad_choice';
  if (choice.source === 'media' && !UUID.test(String(choice.item?.id))) return 'bad_choice';
  if (!planState) return null; // sin plan cargado el servidor decide
  const limits = planState.plan.limits;
  if (choiceAnimated(choice) && !limits.animated) return 'plan_animated';
  const key = kind === 'stage' ? 'stages' : 'backdrops';
  if (!existing && (planState.usage[key] ?? 0) >= (limits[key] ?? 0)) return 'plan_limit';
  return null;
}

/** Argumentos de community_backdrop_set para una elección. */
export const setArgs = (communityId, kind, channelId, choice, { dim = DIM.def, blur = BLUR.def } = {}) => ({
  p_community: communityId, p_kind: kind, p_channel: channelId || null, p_source: choice.source,
  p_value: choice.source === 'preset' ? choice.id : choice.item.id, p_dim: clamp(dim, DIM), p_blur: clamp(blur, BLUR),
});

/** Las imágenes de la galería que sirven de fondo: aprobadas, que el plan no oculta y con algo que dibujar. */
export const usableMedia = (list) => (Array.isArray(list) ? list : []).filter((m) => m && m.status === 'approved' && m.hidden !== true && (m.path || m.url) && UUID.test(String(m.id)));

/** Para el dueño y el equipo: ¿por qué un fondo guardado no se ve? Clave de communityplans.state_<estado>. */
export const stateKey = (backdrop) => `state_${BACKDROP_STATES.includes(backdrop?.state) ? backdrop.state : 'ok'}`;
