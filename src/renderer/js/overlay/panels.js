// Paneles del overlay: se abren con su atajo en el modo interactivo (la ventana toma el mouse y el teclado) y Esc vuelve
// al juego. Por ahora, Recetas (panel-recipes.js) y Asistente (panel-assistant.js). La pagina solo les pide cosas al
// proceso principal por bridge.panel, que acepta una lista cerrada de acciones (src/main/modules/overlay/panels.js).
//   const panels = new OverlayPanels(host, { tr, bridge, showAlert, loadAssistantTexts })
//   panels.handle(msg)   -> { type: 'open', id, key? } | { type: 'close' } | { type: 'assistant', event } | { type: 'notice', key, vars }
//   panels.reset()       -> los vuelve a armar (cambio de idioma o de partida)
import { h, icon } from './dom.js';
import { RecipesPanel } from './panel-recipes.js';
import { AssistantPanel } from './panel-assistant.js';

const TABS = ['recipes', 'assistant'];
const ASK_MAX_MS = 120000; // el proceso principal ya corta la lectura de recetas a los 90 s: esto es el ultimo recurso
const TAB_ICON = { recipes: 'grid', assistant: 'wand' };

export class OverlayPanels {
  constructor(host, { tr, bridge, showAlert, loadAssistantTexts }) {
    this.host = host;
    this.tr = tr;
    this.bridge = bridge;
    this.showAlert = showAlert;
    this.loadAssistantTexts = loadAssistantTexts;
    this.current = null;
    this.views = {};
    this.el = null;
    this.onKey = (e) => {
      if (e.key !== 'Escape' || !this.current) return;
      e.preventDefault();
      e.stopPropagation();
      this.requestClose();
    };
    document.addEventListener('keydown', this.onKey, true);
  }

  // Pedido al proceso principal: nunca lanza ni espera para siempre, devuelve { ok, data } o { ok: false, code, error }
  ask = async (req) => {
    let timer;
    const limit = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, code: 'timeout' }), ASK_MAX_MS);
    });
    try {
      return (await Promise.race([this.bridge?.panel(req), limit])) || { ok: false, code: 'error' };
    } catch (err) {
      return { ok: false, code: 'error', error: err?.message || String(err) };
    } finally {
      clearTimeout(timer);
    }
  };

  requestClose() {
    this.bridge?.closePanel();
  }

  async handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'open') {
      // Otra partida (puede ser otra version): lo que se leyo de la anterior no sirve
      if (msg.key !== this.gameKey) {
        this.gameKey = msg.key;
        this.reset();
      }
      await this.open(msg.id);
    }
    else if (msg.type === 'close') this.close();
    else if (msg.type === 'assistant') this.views.assistant?.event(msg.event);
    else if (msg.type === 'notice' && typeof msg.key === 'string') {
      const vars = msg.vars || undefined;
      const body = this.tr(`${msg.key}Body`, vars);
      this.showAlert?.({ kind: 'alert', icon: 'info', title: this.tr(msg.key, vars), body: body === `${msg.key}Body` ? null : body, ttl: 8 });
    }
  }

  reset() {
    this.el?.remove();
    this.el = null;
    this.views = {};
    this.current = null;
  }

  view(id) {
    if (!this.views[id]) {
      if (id === 'recipes') this.views[id] = new RecipesPanel({ tr: this.tr, ask: this.ask, onWikiOpened: () => this.close() });
      else if (id === 'assistant') this.views[id] = new AssistantPanel({ tr: this.tr, ask: this.ask, onLeave: () => this.close() });
    }
    return this.views[id];
  }

  build() {
    const tr = this.tr;
    this.tabBtns = Object.fromEntries(
      TABS.map((id) => [id, h('button', { type: 'button', class: 'ovl-tab', role: 'tab', 'aria-selected': 'false', onclick: () => this.switchTo(id) }, icon(TAB_ICON[id]), tr(`pn_${id}`))]),
    );
    this.body = h('div', { class: 'ovl-panel-body' });
    const box = h(
      'section',
      { class: 'ovl-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': tr('pn_title') },
      h(
        'header',
        { class: 'ovl-panel-head' },
        h('div', { class: 'ovl-tabs', role: 'tablist', 'aria-label': tr('pn_title') }, Object.values(this.tabBtns)),
        h('span', { class: 'ovl-panel-hint' }, tr('pn_escHint')),
        h('button', { type: 'button', class: 'ovl-icon-btn', title: tr('pn_close'), 'aria-label': tr('pn_close'), onclick: () => this.requestClose() }, icon('x')),
      ),
      this.body,
    );
    this.el = h('div', { class: 'ovl-panel-back' }, box);
    this.el.addEventListener('mousedown', (e) => {
      if (e.target === this.el) this.requestClose();
    });
    this.host.append(this.el);
  }

  async switchTo(id) {
    if (id === this.current || !TABS.includes(id)) return;
    await this.ask({ action: 'panel.switch', id });
    await this.open(id);
  }

  async open(id) {
    if (!TABS.includes(id)) return;
    if (id === 'assistant') await this.loadAssistantTexts?.();
    if (!this.el) this.build();
    this.el.hidden = false;
    this.current = id;
    for (const [k, b] of Object.entries(this.tabBtns)) {
      b.classList.toggle('on', k === id);
      b.setAttribute('aria-selected', String(k === id));
    }
    const view = this.view(id);
    this.body.replaceChildren(view.el);
    await view.open();
  }

  close() {
    this.current = null;
    if (this.el) this.el.hidden = true;
    // Lo que el jugador tenia a medio escribir queda, pero el foco no se queda en la ventana
    document.activeElement?.blur?.();
  }
}
