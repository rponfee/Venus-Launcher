// Panel del asistente en el overlay: preguntarle sin salir del juego. Es el mismo asistente de la pagina (modules/
// assistant): misma conversacion, mismos permisos y mismo plan, sin motor propio. Los cambios sobre el juego abierto los
// sigue rechazando el asistente. Las respuestas y los nombres llegan como datos: van siempre como texto (minimd.js).
import { h, icon } from './dom.js';
import { renderMd } from './minimd.js';

const BLOCK = {
  disabled: { title: 'assistant.disabledTitle', text: 'assistant.disabledText', route: 'settings/ai', cta: 'assistant.goAiSettings' },
  unavailable: { title: 'assistant.blockedTitle', text: 'assistant.blockedText', route: 'settings/cloud/venus', cta: 'assistant.goCloud' },
  plan: { title: 'assistant.planNeededTitle', text: 'assistant.planNeededText', route: 'settings/plan', cta: 'assistant.seePlans' },
  quota: { title: 'assistant.quotaTitle', text: 'as_quotaText', route: 'settings/plan', cta: 'assistant.seePlans' },
  offline: { title: 'as_offlineTitle', text: 'as_offlineText' },
};
// Errores del asistente que se arreglan en una pantalla del launcher
const ERROR_ROUTE = { unavailable: 'settings/cloud/venus', session: 'settings/cloud/venus', noplan: 'settings/plan', plan: 'settings/plan', quota: 'settings/plan', disabled: 'settings/ai' };

export class AssistantPanel {
  constructor({ tr, ask, onLeave }) {
    this.tr = tr;
    this.ask = ask;
    this.onLeave = onLeave;
    this.conv = null;
    this.running = false;
    this.blocked = null;
    this.lastSeq = 0;
    this.groups = new Map();
    this.tools = new Map();
    this.confirms = new Map();
    this.pending = new Set();

    this.thread = h('div', { class: 'ova-thread' });
    this.scroller = h('div', { class: 'ova-scroll', role: 'log', 'aria-live': 'polite', 'aria-label': tr('as_title') }, this.thread);
    this.typing = h('div', { class: 'ova-typing', role: 'status' }, h('span', { class: 'ovl-spinner', 'aria-hidden': 'true' }), tr('assistant.thinking'));
    this.blockBox = h('div', { class: 'ova-block', hidden: true, role: 'alert' });
    this.input = h('textarea', { class: 'ovl-input ova-input', rows: 1, placeholder: tr('assistant.placeholder'), 'aria-label': tr('assistant.placeholder'), maxlength: 8000 });
    this.sendBtn = h('button', { type: 'button', class: 'ovl-icon-btn primary', title: tr('assistant.send'), 'aria-label': tr('assistant.send'), onclick: () => this.send() }, icon('send'));
    this.stopBtn = h('button', { type: 'button', class: 'ovl-icon-btn', title: tr('assistant.stop'), 'aria-label': tr('assistant.stop'), hidden: true, onclick: () => this.ask({ action: 'assistant.cancel' }) }, icon('stop'));
    this.newBtn = h('button', { type: 'button', class: 'ovl-btn ghost', onclick: () => this.startNew() }, icon('plus'), tr('assistant.newChat'));
    this.input.addEventListener('input', () => this.autosize());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.send();
      }
    });
    this.el = h(
      'div',
      { class: 'ova-panel' },
      this.scroller,
      this.blockBox,
      h('div', { class: 'ova-composer' }, h('div', { class: 'ova-input-row' }, this.input, this.sendBtn, this.stopBtn), h('div', { class: 'ova-hint' }, h('span', {}, tr('as_hint')), this.newBtn)),
    );
  }

  autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight + 2, 120)}px`; // + el borde
  }

  // Se llama cada vez que se abre: vuelve a leer la conversacion (pudo seguir con el panel cerrado o en el launcher)
  async open() {
    const r = await this.ask({ action: 'assistant.open' });
    if (!r.ok) {
      this.setBlocked('unavailable');
      return;
    }
    this.setBlocked(r.data.block);
    this.load(r.data.conv);
    if (!this.blocked) this.input.focus();
  }

  load(conv) {
    this.reset();
    this.conv = conv?.id || null;
    this.pending = new Set(conv?.pending || []);
    for (const ev of conv?.events || []) this.apply(ev, false);
    this.lastSeq = conv?.seq || 0;
    this.setRunning(Boolean(conv?.running));
    if (!this.thread.childNodes.length) this.welcome();
    this.scrollDown();
  }

  reset() {
    this.groups.clear();
    this.tools.clear();
    this.confirms.clear();
    this.lastSeq = 0;
    this.thread.replaceChildren();
    this.setRunning(false);
  }

  welcome() {
    this.thread.append(h('div', { class: 'ovr-empty' }, icon('wand'), this.tr('as_welcome')));
  }

  setBlocked(code) {
    const def = code ? BLOCK[code] || BLOCK.unavailable : null;
    this.blocked = code || null;
    this.input.disabled = Boolean(def);
    this.sendBtn.disabled = Boolean(def);
    this.blockBox.hidden = !def;
    if (!def) {
      this.blockBox.replaceChildren();
      return;
    }
    const cta = def.route ? h('button', { type: 'button', class: 'ovl-btn', onclick: () => this.leave(def.route) }, this.tr(def.cta)) : null;
    this.blockBox.replaceChildren(...[icon('info'), h('div', { class: 'ova-block-main' }, h('strong', {}, this.tr(def.title)), h('span', {}, this.tr(def.text))), cta].filter(Boolean));
  }

  leave(route) {
    this.ask({ action: 'launcher.open', route });
    this.onLeave?.();
  }

  setRunning(on) {
    this.running = on;
    this.sendBtn.hidden = on;
    this.stopBtn.hidden = !on;
    this.input.placeholder = this.tr('assistant.placeholder');
    if (!on) this.typing.remove();
    else if (!this.typing.isConnected && this.groups.size) [...this.groups.values()].pop().append(this.typing);
  }

  async send() {
    const text = this.input.value.trim();
    if (!text || this.running || this.blocked) return;
    this.input.value = '';
    this.autosize();
    this.setRunning(true);
    const r = await this.ask({ action: 'assistant.send', text });
    if (!r.ok) {
      this.setRunning(false);
      this.input.value = text;
      this.autosize();
      this.thread.append(this.notice(r.error || this.tr('assistant.sendFailed'), r.code));
      this.scrollDown();
      return;
    }
    if (this.conv !== r.data.conversationId) {
      this.conv = r.data.conversationId;
      this.thread.querySelector('.ovr-empty')?.remove();
    }
  }

  async startNew() {
    if (this.running) return;
    await this.ask({ action: 'assistant.new' });
    this.conv = null;
    this.reset();
    this.welcome();
    this.input.focus();
  }

  // Evento en vivo del proceso principal
  event(ev) {
    if (!ev || ev.seq <= this.lastSeq) return;
    this.lastSeq = ev.seq;
    this.thread.querySelector(':scope > .ovr-empty')?.remove();
    const stick = this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 90;
    this.apply(ev, true);
    if (stick) this.scrollDown();
  }

  scrollDown() {
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  group(turnId) {
    if (this.groups.has(turnId)) return this.groups.get(turnId);
    const body = h('div', { class: 'ova-turn' });
    this.thread.append(body);
    this.groups.set(turnId, body);
    return body;
  }

  notice(message, code) {
    const route = ERROR_ROUTE[code];
    return h('div', { class: 'ova-error', role: 'alert' }, icon('info'), h('span', {}, message), route ? h('button', { type: 'button', class: 'ovl-btn', onclick: () => this.leave(route) }, this.tr('as_openLauncher')) : null);
  }

  toolLabel(ev) {
    const key = `assistant.tool_${ev.name}`;
    const label = this.tr(key);
    return label === key ? this.tr('as_tool') : label;
  }

  toolRow(ev) {
    const sub = h('span', { class: 'ova-tool-sub' });
    const state = h('span', { class: 'ova-tool-state' }, h('span', { class: 'ovl-spinner', 'aria-hidden': 'true' }));
    const row = h('div', { class: 'ova-tool' }, h('span', { class: 'ova-tool-name' }, this.toolLabel(ev)), sub, state);
    row._sub = sub;
    row._state = state;
    return row;
  }

  toolDone(row, ev) {
    row._sub.textContent = ev.summary || ev.error || '';
    row._sub.title = ev.summary || ev.error || '';
    row.classList.toggle('bad', !ev.ok && !ev.declined);
    row._state.replaceChildren(icon(ev.ok ? 'check' : 'x'));
    if (ev.undoable) row.append(h('span', { class: 'ova-tool-note' }, this.tr('as_undoInLauncher')));
  }

  confirmCard(ev, live) {
    const actions = h('div', { class: 'ova-confirm-actions' });
    const card = h(
      'div',
      { class: 'ova-confirm', role: 'group', 'aria-label': ev.title || this.tr('assistant.confirmNeeded') },
      h('strong', {}, ev.title || this.tr('assistant.confirmNeeded')),
      ev.message ? h('p', {}, ev.message) : null,
      ev.items?.length ? h('ul', {}, ev.items.map((x) => h('li', {}, x))) : null,
      actions,
    );
    card._actions = actions;
    if (live || this.pending.has(ev.requestId)) {
      const answer = async (approved) => {
        actions.querySelectorAll('button').forEach((b) => {
          b.disabled = true;
        });
        const r = await this.ask({ action: 'assistant.confirm', requestId: ev.requestId, approved });
        if (!r.ok) this.confirmState(card, 'expired');
      };
      actions.replaceChildren(
        h('button', { type: 'button', class: 'ovl-btn ghost', onclick: () => answer(false) }, this.tr('assistant.cancel')),
        h('button', { type: 'button', class: ['ovl-btn', ev.danger ? 'danger' : 'primary'], onclick: () => answer(true) }, ev.okText || this.tr('assistant.confirm')),
      );
    } else this.confirmState(card, 'expired');
    return card;
  }

  confirmState(card, state) {
    const key = { approved: 'confirmApproved', denied: 'confirmDenied', cancelled: 'confirmCancelled', expired: 'confirmExpired' }[state] || 'confirmExpired';
    card._actions.replaceChildren(h('span', { class: 'ova-tool-note' }, this.tr(`assistant.${key}`)));
  }

  apply(ev, live) {
    if (ev.type !== 'thinking' && ev.type !== 'quota') this.typing.remove();
    switch (ev.type) {
      case 'turn-start':
        this.thread.append(h('div', { class: 'ova-user ovl-selectable' }, ev.text || ''));
        this.group(ev.turnId);
        if (live) this.setRunning(true);
        break;
      case 'thinking':
        if (live && this.running) this.group(ev.turnId).append(this.typing);
        break;
      case 'text':
        this.group(ev.turnId).append(h('div', { class: 'ova-text ovl-selectable' }, renderMd(ev.text, h)));
        break;
      case 'tool-start':
        if (!this.tools.has(ev.toolUseId)) {
          const row = this.toolRow(ev);
          this.tools.set(ev.toolUseId, row);
          this.group(ev.turnId).append(row);
        }
        break;
      case 'tool-result': {
        let row = this.tools.get(ev.toolUseId);
        if (!row) {
          row = this.toolRow(ev);
          this.tools.set(ev.toolUseId, row);
          this.group(ev.turnId).append(row);
        }
        this.toolDone(row, ev);
        break;
      }
      case 'confirm': {
        const existing = this.confirms.get(ev.requestId);
        if (ev.state === 'pending' && !existing) {
          const card = this.confirmCard(ev, live);
          this.confirms.set(ev.requestId, card);
          this.group(ev.turnId).append(card);
        } else if (existing && ev.state !== 'pending') this.confirmState(existing, ev.state);
        break;
      }
      case 'notice':
        this.group(ev.turnId).append(h('div', { class: 'ova-note' }, ev.text || ''));
        break;
      case 'error':
        (ev.turnId ? this.group(ev.turnId) : this.thread).append(this.notice(ev.message || this.tr('assistant.sendFailed'), ev.code));
        break;
      case 'done': {
        const note = { cancelled: 'assistant.cancelled', interrupted: 'assistant.interrupted', max_tokens: 'assistant.truncated' }[ev.stopReason];
        if (note) this.group(ev.turnId).append(h('div', { class: 'ova-note' }, this.tr(note)));
        if (live) this.setRunning(false);
        break;
      }
      default:
        break;
    }
  }
}
