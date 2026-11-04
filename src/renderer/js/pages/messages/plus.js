// Mensajes (3.3): lo que se suma a cada conversacion. Stickers como imagen, emojis propios en el texto, boton Traducir,
// interruptor de traduccion automatica y denunciar un sticker. Clases con prefijo .spx- (styles/features/socialplus.css).
import { h, icon, mount, toast } from '../../ui.js';
import { t, getLanguage } from '../../i18n.js';
import { api } from '../../store.js';
import { cloud } from '../../cloud.js';
import { navigate } from '../../app.js';
import { stickerInMessage, resolveSticker, emojiNames, cachedEmoji, cachedEmojiItem, resolveEmojis } from '../../social/stickers.js';
import { TranslateQueue, isTranslatable, hasWords } from '../../social/translate.js';
import { translationCache, chatAutoOn, setChatAuto, askTranslateConsent } from '../../features/socialplus/translate-state.js';
import '../../features/socialplus/stickerpicker.js'; // registra los iconos spx*

const S = (k, vars) => t(`socialplus.${k}`, vars);

// Sticker de un mensaje ({ id, url, userId, ... }) o null: solo del bucket propio y de la carpeta del que escribio
export const stickerOfMessage = (m) => (m ? stickerInMessage(m.body, m.sender_id, cloud.config?.url) : null);
export const stickerOfLast = (last) => (last ? stickerInMessage(last.body, last.senderId, cloud.config?.url) : null);

// Imagen del sticker. Si el archivo no carga o el sticker se borro, un aviso en su lugar (nunca otra direccion).
export function stickerEl(sticker) {
  const img = h('img', { class: 'spx-sticker', src: sticker.url, alt: S('stickerAlt'), loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' });
  const box = h('span', { class: 'spx-sticker-box' }, img);
  const gone = () => mount(box, h('span', { class: 'spx-sticker-gone' }, icon('spxSticker'), S('stickerGone')));
  img.addEventListener('error', gone);
  resolveSticker(sticker.id).then((item) => {
    if (item === null) gone();
  });
  return box;
}

export class ChatExtras {
  constructor(view) {
    this.view = view;
    this.tr = new Map(); // id del mensaje -> { state: 'pending' | 'done' | 'failed', body, text, same, auto, hidden }
    this.queue = null;
    this.stopped = false; // sin plan o sin saldo: la traduccion automatica no insiste hasta que el usuario vuelva a pedir
    this.asked = new Set();
    this.noticeEl = h('div', { class: 'spx-tr-notice', role: 'status', hidden: true });
  }

  destroy() {
    this.queue?.close();
    this.queue = null;
  }

  // ---------- Emojis propios ----------
  // Lo que se conoce del que escribio (se dibuja como imagen); lo que falta se pregunta y se vuelve a dibujar
  emojisOf(m) {
    return (name) => cachedEmoji(m.sender_id, name) || null;
  }

  scanEmojis(msgs) {
    const missing = new Map();
    for (const m of msgs) {
      if (m.deleted || m._local) continue;
      for (const name of emojiNames(m.body)) {
        const key = `${m.sender_id}:${name}`;
        if (cachedEmoji(m.sender_id, name) !== undefined || this.asked.has(key)) continue;
        this.asked.add(key);
        if (!missing.has(m.sender_id)) missing.set(m.sender_id, []);
        missing.get(m.sender_id).push(name);
      }
    }
    for (const [owner, names] of missing) {
      resolveEmojis(owner, names)
        .then((learned) => {
          for (const n of names) this.asked.delete(`${owner}:${n}`);
          if (learned && !this.view.destroyed) this.view.renderMessages('keep');
        })
        .catch((err) => console.warn('[stickers] emojis:', err?.message || err)); // quedan como texto; no se reintenta en esta charla
    }
  }

  // Lo que se puede denunciar de un mensaje ajeno: el sticker o el primer emoji propio que se ve
  reportable(m) {
    const sticker = stickerOfMessage(m);
    if (sticker) return { id: sticker.id };
    for (const name of emojiNames(m.body)) {
      const item = cachedEmojiItem(m.sender_id, name);
      if (item) return { id: item.id, name };
    }
    return null;
  }

  // ---------- Traduccion ----------
  get auto() {
    return Boolean(this.view.chatId) && chatAutoOn(this.view.chatId);
  }

  async ensureQueue() {
    if (!this.queue) {
      const cache = await translationCache();
      if (this.view.destroyed) return null;
      this.queue ??= new TranslateQueue({
        cache,
        lang: () => getLanguage(),
        send: (items, lang) => api.invoke('socialplus:translate', { items, lang }).then((r) => r?.items || []),
        onResult: (id, value) => this.onResult(id, value),
        onError: (err, items) => this.onError(err, items),
      });
    }
    return this.queue;
  }

  // Mensaje ajeno de texto (los GIF y stickers no se traducen)
  isText(m) {
    return Boolean(m) && m.sender_id !== this.view.userIdSelf() && !m.deleted && !m._local && !this.view.isMediaMessage(m);
  }

  // El boton Traducir se ofrece en todo mensaje ajeno con palabras
  canTranslate(m) {
    return this.isText(m) && hasWords(m.body);
  }

  refreshRow(id) {
    if (!this.view.updateRow(id)) this.view.renderMessages('keep');
  }

  onResult(id, value) {
    const st = this.tr.get(id);
    if (!st) return;
    if (value.failed) Object.assign(st, { state: 'failed' });
    else Object.assign(st, { state: 'done', text: value.text, same: value.same });
    this.refreshRow(id);
  }

  onError(err, items) {
    for (const it of items) {
      const st = this.tr.get(it.id);
      if (st?.state === 'pending') {
        if (st.auto) this.tr.delete(it.id);
        else st.state = 'failed';
        this.refreshRow(it.id);
      }
    }
    this.showError(err);
  }

  // Aviso claro de por que no se pudo traducir, con la salida que corresponda
  showError(err) {
    const code = err?.code;
    if (code === 'noplan' || code === 'quota' || code === 'plan' || code === 'unavailable' || code === 'session') this.stopped = true;
    let text = S('trError');
    let action = null;
    if (code === 'noplan' || code === 'plan') {
      text = S('trNoPlan');
      action = [S('seePlans'), () => import('../../features/plans.js').then((m) => m.openPlans({ reason: 'needsPlan' }))];
    } else if (code === 'quota') {
      text = S('trNoQuota');
      action = [S('seePlans'), () => import('../../features/plans.js').then((m) => m.openPlans({ reason: 'quota' }))];
    } else if (code === 'unavailable' || code === 'session') {
      text = S('trSignIn');
      action = [S('trGoAccount'), () => navigate('settings/cloud/venus')];
    } else if (code === 'ratelimit') text = S('trBusy');
    else if (code === 'network') text = S('trNetwork');
    else console.warn('[socialplus] traduccion:', code, err?.message);
    this.noticeEl.hidden = false;
    mount(
      this.noticeEl,
      icon('alert'),
      h('span', { class: 'spacer' }, text),
      action ? h('button', { class: 'btn sm', type: 'button', onclick: () => action[1]() }, action[0]) : null,
      h('button', { class: 'icon-btn sm', type: 'button', title: S('close'), 'aria-label': S('close'), onclick: () => this.hideNotice() }, icon('x')),
    );
  }

  hideNotice() {
    this.noticeEl.hidden = true;
    mount(this.noticeEl);
  }

  enqueue(msgs, { auto }) {
    this.ensureQueue().then((q) => {
      if (!q) return;
      const lang = getLanguage();
      const items = [];
      for (const m of msgs) {
        // Sin mandar nada: lo que no hace falta traducir o ya esta en este idioma
        if (!isTranslatable(m.body, lang)) {
          if (!auto) {
            this.tr.set(m.id, { state: 'done', body: m.body, text: '', same: true, auto });
            this.refreshRow(m.id);
          }
          continue;
        }
        if (!this.tr.has(m.id)) this.tr.set(m.id, { state: 'pending', body: m.body, auto });
        items.push({ id: m.id, text: m.body });
      }
      if (items.length) {
        q.request(items);
        for (const it of items) if (this.tr.get(it.id)?.state === 'pending') this.refreshRow(it.id);
      }
    });
  }

  // Boton Traducir de un mensaje: traduce o, si ya esta a la vista, oculta la traduccion
  async translateMessage(m) {
    const st = this.tr.get(m.id);
    if (st?.state === 'done' && st.body === m.body) {
      st.hidden = !st.hidden;
      return this.refreshRow(m.id);
    }
    if (!(await askTranslateConsent()) || this.view.destroyed) return;
    this.stopped = false;
    this.hideNotice();
    this.tr.delete(m.id);
    this.enqueue([m], { auto: false });
  }

  isShown(m) {
    const st = this.tr.get(m.id);
    return Boolean(st && !st.hidden && st.state === 'done' && st.body === m.body);
  }

  async toggleAuto() {
    const chatId = this.view.chatId;
    if (!chatId) return;
    if (this.auto) {
      await setChatAuto(chatId, false).catch(() => {});
      for (const [id, st] of [...this.tr]) {
        if (st.auto) {
          this.tr.delete(id);
          this.view.updateRow(id);
        }
      }
      this.hideNotice();
      this.view.renderHead();
      return;
    }
    if (!(await askTranslateConsent()) || this.view.destroyed) return;
    await setChatAuto(chatId, true);
    this.stopped = false;
    this.hideNotice();
    toast('info', S('trAutoOnTitle'), S('trAutoOnText', { name: this.view.name() }), 4000);
    this.view.renderHead();
    this.onOpen();
  }

  // Al abrir la charla con el interruptor prendido: lo que ya esta en la caché se ve, y se traduce lo que todavia no se leyo
  async onOpen(unreadFrom = null) {
    if (!this.auto) return;
    const msgs = this.view.chatMessages().filter((m) => this.isText(m));
    const cache = await translationCache();
    if (this.view.destroyed) return;
    const lang = getLanguage();
    let from = unreadFrom ? msgs.findIndex((m) => m.id === unreadFrom) : -1;
    if (from < 0) from = msgs.length;
    let changed = false;
    msgs.forEach((m, i) => {
      if (this.tr.has(m.id)) return;
      const hit = cache.get(m.id, lang, m.body);
      if (hit) {
        this.tr.set(m.id, { state: 'done', body: m.body, text: hit.text, same: hit.same, auto: true });
        changed = true;
      } else if (i >= from && !this.stopped) this.enqueue([m], { auto: true });
    });
    if (changed) this.view.renderMessages('keep');
  }

  // Llego un mensaje a esta charla
  onIncoming(m) {
    if (this.auto && !this.stopped && this.isText(m)) this.enqueue([m], { auto: true });
  }

  // Lo que se dibuja debajo del globo: el original queda arriba y la traduccion abajo, siempre como texto
  blockFor(m) {
    const st = this.tr.get(m.id);
    if (!st) return null;
    // Se edito: esa traduccion ya no vale
    if (st.body !== m.body) {
      this.tr.delete(m.id);
      if (st.auto) this.onIncoming(m);
      return null;
    }
    if (st.hidden) return null;
    if (st.state === 'pending') return h('div', { class: 'spx-tr pending', role: 'status' }, icon('spxLanguages'), h('span', {}, S('trWorking')));
    if (st.state === 'failed') {
      return h('div', { class: 'spx-tr bad', role: 'status' }, icon('alert'), h('span', {}, S('trFailed')), h('button', { class: 'msg-linkbtn', type: 'button', onclick: () => this.translateMessage(m) }, S('retry')));
    }
    if (st.same) return st.auto ? null : h('div', { class: 'spx-tr same', role: 'status' }, icon('spxLanguages'), h('span', {}, S('trSame')));
    return h('div', { class: 'spx-tr' }, h('div', { class: 'spx-tr-head' }, icon('spxLanguages'), h('span', {}, S('trLabel'))), h('div', { class: 'spx-tr-text selectable priv' }, st.text));
  }
}
