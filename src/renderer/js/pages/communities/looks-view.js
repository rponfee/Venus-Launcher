// Fondos del chat y escenarios de voz de una comunidad: dibujo de la capa (un incluido de CSS, una imagen aprobada de la galería o
// un GIF de KLIPY) y los dos enganches que la ponen en su lugar: el chat de texto de un canal y la sala de voz. Si algo falla, o la
// comunidad no tiene fondo, no se agrega nada y el chat o la sala se ven como siempre. Lógica pura: features/communities/looks.js.
import { h, ensureCss } from '../../ui.js';
import { isKlipyUrl } from '../../features/profile-editor/model.js';
import { groupsBackend } from '../../features/communities/backend.js';
import { LOOKS_EVENT, normalizeBackdrop, normalizeBackdrops, pickBackdrop } from '../../features/communities/looks.js';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
// Una URL firmada de Storage o un dibujo de ejemplo; nunca se arma CSS con comillas, barras ni saltos de línea de otra persona.
const cssUrl = (url) => (typeof url === 'string' && /^(https:\/\/|blob:|data:image\/)/.test(url) ? `url("${url.replace(/["\\\n\r]/g, '')}")` : null);

/** Dibuja un fondo o escenario. backdrop: lo que devuelve normalizeBackdrop. thumb: versión chica para la vista previa. */
export function backdropLayer(b, backdrop, { thumb = false } = {}) {
  ensureCss('features/communityplans');
  const art = h('div', { class: 'cp-bd-art' });
  const layer = h('div', {
    class: ['cp-bd', thumb && 'is-thumb', backdrop.animated && 'is-animated'], 'aria-hidden': 'true', dataset: { source: backdrop.source },
    style: { '--cp-dim': String(backdrop.dim / 100), '--cp-blur': `${backdrop.blur}px` },
  }, art, h('div', { class: 'cp-bd-scrim' }));
  if (backdrop.source === 'preset') {
    layer.dataset.preset = backdrop.preset;
    return layer;
  }
  const media = backdrop.media;
  art.classList.add('cp-bd-image');
  const paint = (url) => { const css = cssUrl(url); if (css) art.style.backgroundImage = css; };
  if (media.source === 'klipy') {
    // Con "reducir movimiento" se usa la imagen fija de KLIPY si la trae.
    const url = reducedMotion() && isKlipyUrl(media.still) ? media.still : media.url;
    if (isKlipyUrl(url)) paint(url);
  } else if (media.path) {
    b.mediaUrl(media.path).then(paint).catch(() => {});
  }
  return layer;
}

function fetchBackdrops(b, communityId) {
  return b.rpc('community_backdrops_get', { p_community: communityId }).then(normalizeBackdrops);
}

/** Avisa a los chats y salas abiertos que los fondos de esa comunidad cambiaron (lo llama el editor al guardar). */
export function notifyLooksChanged(communityId) {
  document.dispatchEvent(new CustomEvent(LOOKS_EVENT, { detail: { communityId } }));
}

/**
 * Pone el fondo del chat de un canal detrás de sus mensajes. host: el contenedor del chat. Devuelve { sync(community, channel), destroy() }:
 * sync vuelve a pedir los fondos solo si cambió el plan o el canal.
 */
export function attachChatBackdrop(host, b, community, channel) {
  ensureCss('features/communityplans');
  let destroyed = false;
  let layer = null;
  let items = [];
  let seq = 0;
  let key = `${community.id}|${community.plan?.id}|${community.plan?.endsAt}`;
  const draw = () => {
    layer?.remove();
    layer = null;
    host.classList.remove('cp-has-bd');
    const found = pickBackdrop(items, 'chat', channel.id);
    if (!found || destroyed) return;
    layer = backdropLayer(b, found);
    host.classList.add('cp-has-bd');
    host.prepend(layer);
  };
  const load = async () => {
    const mine = ++seq;
    try {
      const res = await fetchBackdrops(b, community.id);
      if (destroyed || mine !== seq) return;
      items = res.items;
      draw();
    } catch {
      /* sin fondos: el chat se ve como siempre */
    }
  };
  const onChange = (e) => { if (e.detail?.communityId === community.id) load(); };
  document.addEventListener(LOOKS_EVENT, onChange);
  load();
  return {
    sync(next, nextChannel) {
      community = next;
      const nextKey = `${next.id}|${next.plan?.id}|${next.plan?.endsAt}`;
      const moved = nextChannel?.id !== channel.id;
      channel = nextChannel || channel;
      if (nextKey !== key) { key = nextKey; load(); } else if (moved) draw();
    },
    destroy() {
      destroyed = true;
      document.removeEventListener(LOOKS_EVENT, onChange);
      layer?.remove();
      host.classList.remove('cp-has-bd');
    },
  };
}

/**
 * Escenario de una sala de voz de comunidad: una capa detrás de los miembros de la sala. getRoom devuelve la sala actual
 * ({ id }) y subscribe(fn) avisa cuando cambia. Una sala común (no de comunidad) no recibe nada. Devuelve la función que lo quita.
 */
export function attachStage(el, getRoom, subscribe) {
  ensureCss('features/communityplans');
  let destroyed = false;
  let layer = null;
  let roomId = null;
  let seq = 0;
  const clear = () => {
    layer?.remove();
    layer = null;
    el.classList.remove('cp-staged');
  };
  const sync = async () => {
    const id = getRoom()?.id || null;
    if (id === roomId) return;
    roomId = id;
    clear();
    if (!id || /^bk:/.test(String(id))) return;
    const mine = ++seq;
    try {
      const b = await groupsBackend();
      const res = await b.rpc('community_stage_get', { p_room: id });
      const stage = normalizeBackdrop(res?.stage);
      if (destroyed || mine !== seq || !stage || stage.state !== 'ok') return;
      layer = backdropLayer(b, stage);
      el.classList.add('cp-staged');
      el.prepend(layer);
    } catch {
      /* sin escenario: la sala se ve como siempre */
    }
  };
  const off = subscribe?.(sync);
  sync();
  return () => {
    destroyed = true;
    off?.();
    clear();
  };
}
