// De lo que devuelve app_inbox a la notificación que se muestra. Lógica pura: la usa el service worker y se prueba con Node.
(function (root) {
  'use strict';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const ts = (v) => Date.parse(v) || 0;
  const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, max);

  function generic(tr) {
    return { title: tr('push_title'), body: tr('push_generic'), tag: 'venus-generic', hash: '#/inbox', stamp: 0 };
  }

  // Lo que se lee en el aviso: nunca una dirección de un GIF o de un sticker
  function previewOf(item, base, tr) {
    const { media } = root.VenusApp;
    const text = clean(item.text, 200);
    if (!text) return '';
    if (media.gifOf(text)) return tr('preview_gif');
    if (media.stickerOf(text, item.userId, base)) return tr('preview_sticker');
    return text.length > 120 ? `${text.slice(0, 119)}…` : text;
  }

  /**
   * inbox: resultado de app_inbox, o null si no hubo sesión o no se pudo consultar.
   * last: marca de la última notificación (solo se avisa de lo que es más nuevo que eso).
   * tr(clave, datos): textos en el idioma del celular. base: dirección del proyecto.
   */
  function buildNotification(inbox, { last = 0, tr, base }) {
    if (!inbox || typeof inbox !== 'object') return generic(tr);
    const messages = (Array.isArray(inbox.messages) ? inbox.messages : []).filter((m) => ts(m?.at) > last && m.conv);
    const requests = (Array.isArray(inbox.requests) ? inbox.requests : []).filter((r) => ts(r?.at) > last);
    const clips = (Array.isArray(inbox.clips) ? inbox.clips : []).filter((c) => ts(c?.at) > last);
    const newest = (list) => list.reduce((best, x) => Math.max(best, ts(x.at)), 0);
    const stamps = { messages: newest(messages), requests: newest(requests), clips: newest(clips) };
    const stamp = Math.max(stamps.messages, stamps.requests, stamps.clips);
    if (!stamp) return generic(tr);
    const someone = tr('someone');

    if (stamp === stamps.messages) {
      if (messages.length > 1) {
        const total = messages.reduce((sum, m) => sum + (Number(m.unread) || 1), 0);
        return { title: tr('push_title'), body: tr('push_many', { count: total, chats: messages.length }), tag: 'venus-dm', hash: '#/messages', stamp };
      }
      const m = messages[0];
      const unread = Number(m.unread) || 1;
      const preview = previewOf(m, base, tr);
      const body = preview || (unread > 1 ? tr('push_messages', { count: unread }) : tr('push_message'));
      const safeUser = UUID.test(String(m.userId)) ? m.userId : null;
      return { title: clean(m.name, 40) || someone, body, tag: `venus-dm-${clean(m.conv, 40)}`, hash: safeUser ? `#/messages/${safeUser}` : '#/messages', stamp };
    }
    if (stamp === stamps.requests) {
      const r = requests.find((x) => ts(x.at) === stamp);
      return { title: clean(r.name, 40) || someone, body: tr('push_request'), tag: 'venus-request', hash: '#/friends', stamp };
    }
    const c = clips.find((x) => ts(x.at) === stamp);
    const name = clean(c.name, 80);
    const what = tr(c.kind === 'clip' ? 'push_clip' : 'push_shot');
    return { title: clean(c.from, 40) || someone, body: name ? `${what}: ${name}` : what, tag: 'venus-clip', hash: '#/clips/received', stamp };
  }

  // Solo direcciones internas de la app: lo que abre tocar el aviso nunca sale de ella
  function safeHash(hash) {
    return /^#\/(friends|inbox|messages(\/[0-9a-f-]{36})?|clips(\/(received|mine|gallery))?)$/.test(String(hash ?? '')) ? hash : '#/inbox';
  }

  const notify = { buildNotification, safeHash, previewOf };
  root.VenusApp = Object.assign(root.VenusApp || {}, { notify });
  if (typeof module === 'object' && module.exports) module.exports = notify;
})(globalThis);
