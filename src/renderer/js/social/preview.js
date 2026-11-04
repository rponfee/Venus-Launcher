// Vista previa de avisos: las imágenes se anuncian por su tipo, sin descargar archivos ni mostrar su dirección.
import { stickerInMessage } from './stickers.js';
import { isKlipyUrl } from '../features/profile-editor/model.js';
export function messagePreview(body, senderId, base, labels) {
  const text = String(body ?? '');
  if (stickerInMessage(text, senderId, base)) return labels.sticker;
  if (isKlipyUrl(text.trim())) return labels.gif;
  return text;
}
