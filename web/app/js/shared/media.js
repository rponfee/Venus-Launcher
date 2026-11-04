// Qué URL de medios se puede cargar. Todo lo que viene de otra persona pasa por acá antes de llegar a un <img> o un <video>:
// lo que no coincide exactamente se muestra como texto.
(function (root) {
  'use strict';
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const KLIPY = /^https:\/\/static[0-9]*\.klipy\.com\/[A-Za-z0-9/._~-]+(\?[A-Za-z0-9=&._~%-]*)?$/;
  const STICKER_FILE = new RegExp(`^(${UUID})/(${UUID})\\.(png|webp|gif)$`);

  const trim = (base) => String(base || '').replace(/\/+$/, '');

  // Un GIF de KLIPY: el mensaje es solo la dirección (igual que en el launcher)
  function gifOf(body) {
    const s = String(body ?? '').trim();
    return s && s.length <= 400 && !/\s/.test(s) && KLIPY.test(s) ? s : null;
  }

  // Un sticker: el mensaje es solo la dirección del archivo, en el bucket de este proyecto y en la carpeta del que escribió
  function stickerOf(body, senderId, base) {
    const s = String(body ?? '').trim();
    if (!s || /\s/.test(s) || s.length > 400 || !base) return null;
    const prefix = `${trim(base)}/storage/v1/object/public/stickers/`;
    if (!s.startsWith(prefix)) return null;
    const m = STICKER_FILE.exec(s.slice(prefix.length));
    return m && senderId && m[1] === senderId ? { id: m[2], userId: m[1], url: s } : null;
  }

  function inProject(raw, base) {
    if (typeof raw !== 'string' || !base || raw.length > 2000) return null;
    try {
      const u = new URL(raw);
      const b = new URL(base);
      return u.protocol === 'https:' && u.host === b.host && !u.username && !u.password ? u : null;
    } catch {
      return null;
    }
  }

  // Un link firmado de una captura o un clip del Storage de este proyecto
  function signedMedia(raw, base) {
    const u = inProject(raw, base);
    return u && /^\/storage\/v1\/object\/sign\/(screenshots|clips)\//.test(u.pathname) ? u.href : null;
  }

  const media = { gifOf, stickerOf, signedMedia };
  root.VenusApp = Object.assign(root.VenusApp || {}, { media });
  if (typeof module === 'object' && module.exports) module.exports = media;
})(globalThis);
