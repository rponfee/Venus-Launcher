// Comunidades: dibujo de un GIF dentro de un mensaje, de una vista previa o de la galería. Uno de KLIPY se carga directo de
// KLIPY (solo si su dirección es de KLIPY, con la misma regla que el servidor); uno subido se pide con una URL firmada del
// bucket privado, que Storage entrega únicamente si ya está aprobado (o si es de quien lo sube / del dueño / de un administrador).
// Si la imagen no carga queda un recuadro en su lugar: nunca se muestra una imagen rota.
import { h, icon, mount } from '../../ui.js';
import { t } from '../../i18n.js';
import { isKlipyUrl } from '../../features/profile-editor/model.js';
import { viewMedia } from '../../features/communities/media.js';

const C = (key, vars) => t(`communities.${key}`, vars);

/**
 * media: { kind: 'klipy', url } o { kind: 'upload', path, name }. size: 'sm' | 'md' | 'lg'.
 * alt: texto alternativo (el nombre del GIF). Devuelve el elemento; no carga nada hasta que el navegador lo pida.
 */
export function mediaImage(b, media, { size = 'md', alt = '' } = {}) {
  const view = viewMedia(media, isKlipyUrl);
  const box = h('div', { class: ['cm-media', `is-${size}`], dataset: { kind: view?.kind || 'gone' } });
  const gone = () => {
    box.classList.add('is-gone');
    mount(box, icon('image'), h('span', {}, C('mediaGone')));
  };
  if (!view || view.kind === 'gone') {
    gone();
    return box;
  }
  const img = h('img', { class: 'cm-media-img', alt: alt || view.name || C('mediaAlt'), loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' });
  // Con las medidas conocidas (los GIFs subidos las traen) se reserva el lugar: la imagen no salta al cargar.
  if (view.width > 0 && view.height > 0) {
    img.style.aspectRatio = `${view.width} / ${view.height}`;
    img.style.width = `${Math.min(view.width, { sm: 150, md: 240, lg: 360 }[size] || 240)}px`;
  }
  img.addEventListener('error', gone);
  mount(box, img);
  if (view.kind === 'klipy') img.src = view.url;
  else {
    b.mediaUrl(view.path).then((url) => {
      if (url) img.src = url;
      else gone();
    }).catch(gone);
  }
  return box;
}
