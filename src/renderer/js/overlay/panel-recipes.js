// Panel de recetas del overlay: buscador de items y su ficha (como se fabrica y en que se usa), con la grilla de crafteo,
// horno y demas. Todo sale de los archivos del juego que corre (src/main/modules/recipes.js). Los nombres son datos del
// juego o de un mod: siempre van como texto. La wiki se abre en el navegador, solo con la conexion opcional activada.
import { h, icon } from './dom.js';

const SEARCH_DELAY_MS = 110;

// Etiqueta del lugar donde se hace una receta
const STATION_KEY = { crafting: 'rc_crafting', smelting: 'rc_smelting', blasting: 'rc_blasting', smoking: 'rc_smoking', campfire: 'rc_campfire', stonecutter: 'rc_stonecutter', smithing: 'rc_smithing' };

const fmtSeconds = (ticks) => {
  const s = Number(ticks) / 20;
  return Number.isFinite(s) ? String(Math.round(s * 10) / 10) : '';
};

export class RecipesPanel {
  constructor({ tr, ask, onWikiOpened }) {
    this.tr = tr;
    this.ask = ask;
    this.onWikiOpened = onWikiOpened;
    this.icons = new Map();
    this.state = { info: null, query: '', results: [], total: 0, card: null, tab: 'recipes', error: null, wikiAllowed: false, optIn: false };
    this.history = [];
    this.token = 0; // busquedas: gana la ultima
    this.itemToken = 0; // fichas: gana la ultima (aparte de las busquedas: escribir mientras se abre un item no lo cancela)
    this.timer = null;

    this.input = h('input', { class: 'ovl-input', type: 'search', placeholder: tr('rc_searchPlaceholder'), 'aria-label': tr('rc_searchPlaceholder'), maxlength: 80, spellcheck: 'false', autocomplete: 'off' });
    this.input.addEventListener('input', () => this.searchSoon());
    this.input.addEventListener('keydown', (e) => this.onInputKey(e));
    this.list = h('div', { class: 'ovr-list', role: 'listbox', 'aria-label': tr('rc_results') });
    this.list.addEventListener('keydown', (e) => this.onListKey(e));
    this.count = h('div', { class: 'ovr-count', role: 'status' });
    this.detail = h('div', { class: 'ovr-detail' });
    this.foot = h('div', { class: 'ovr-foot' });
    this.el = h(
      'div',
      { class: 'ovr-panel' },
      h('div', { class: 'ovr-side' }, h('div', { class: 'ovl-field' }, icon('search'), this.input), this.count, this.list, this.foot),
      this.detail,
    );
  }

  // Se llama al abrir el panel. Lee los archivos del juego la primera vez (despues queda en cache).
  async open() {
    this.input.focus();
    if (this.state.info) return;
    this.showDetail(h('div', { class: 'ovr-empty', role: 'status' }, h('span', { class: 'ovl-spinner', 'aria-hidden': 'true' }), this.tr('rc_loading')));
    const r = await this.ask({ action: 'recipes.info' });
    if (!r.ok) return this.fail(r);
    this.state.info = r.data;
    this.state.wikiAllowed = Boolean(r.data.wikiAllowed);
    this.drawFoot();
    if (!r.data.recipes) this.showDetail(h('div', { class: 'ovr-empty' }, icon('info'), this.tr('rc_noRecipes', { version: r.data.version })));
    else this.showDetail(h('div', { class: 'ovr-empty' }, icon('search'), this.tr('rc_startHint')));
    return this.search();
  }

  fail(r) {
    const key = { noJar: 'rc_err_noJar', noVersion: 'rc_err_noJar', noGame: 'rc_err_noGame', timeout: 'rc_err_timeout' }[r.code] || 'rc_err_read';
    this.showDetail(h('div', { class: 'ovr-empty bad', role: 'alert' }, icon('info'), this.tr(key)));
  }

  drawFoot() {
    const info = this.state.info;
    if (!info) return;
    const parts = [this.tr('rc_version', { version: info.version })];
    if (info.mods) parts.push(this.tr('rc_mods', { count: info.mods }));
    this.foot.textContent = parts.join(' · ');
    const notes = [];
    if (info.modsFailed) notes.push(this.tr('rc_modsFailed', { count: info.modsFailed }));
    if (info.modsSkipped) notes.push(this.tr('rc_modsSkipped', { count: info.modsSkipped }));
    // Faltan mods por leer (hay muchos): se siguen leyendo de fondo y la proxima vez que se abra el panel ya estan
    if (info.modsPending) {
      notes.push(this.tr('rc_modsPending', { count: info.modsPending }));
      parts.push(this.tr('rc_modsPendingShort', { count: info.modsPending }));
      this.foot.textContent = parts.join(' · ');
    }
    this.foot.title = [...notes, this.tr('rc_sourceHint')].join(' ');
  }

  searchSoon() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.search(), SEARCH_DELAY_MS);
  }

  async search() {
    const token = ++this.token;
    const query = this.input.value.trim();
    const r = await this.ask({ action: 'recipes.search', query });
    if (token !== this.token) return;
    if (!r.ok) return this.fail(r);
    this.state.query = query;
    this.state.results = r.data.items;
    this.state.total = r.data.total;
    this.remember(r.data.icons);
    this.drawList();
  }

  remember(icons) {
    for (const [id, url] of Object.entries(icons || {})) this.icons.set(id, url);
  }

  drawList() {
    const { results, total, query } = this.state;
    this.count.textContent = query ? this.tr('rc_found', { count: total }) : '';
    if (!results.length) {
      this.list.replaceChildren(h('div', { class: 'ovr-none' }, this.tr('rc_noResults')));
      return;
    }
    const selected = this.state.card?.id;
    this.list.replaceChildren(
      ...results.map((it) =>
        h(
          'button',
          { type: 'button', class: ['ovr-row', it.id === selected && 'on'], role: 'option', 'aria-selected': String(it.id === selected), dataset: { id: it.id }, onclick: () => this.openItem(it.id, { fresh: true }) },
          this.itemIcon(it.id, it.name),
          h('span', { class: 'ovr-row-name' }, it.name),
          it.hasRecipe ? null : h('span', { class: 'ovr-row-note', title: this.tr('rc_noRecipeHint') }, '—'),
        ),
      ),
    );
  }

  // Icono del item (textura del .jar) o sus iniciales si no hay
  itemIcon(id, name, cls = 'ovr-icon') {
    const url = this.icons.get(id);
    const letters = String(name || '?').split(/\s+/).map((w) => w.charAt(0)).join('').slice(0, 2).toUpperCase();
    const fallback = h('span', { class: `${cls} ovr-icon-text`, 'aria-hidden': 'true' }, letters);
    if (!url) return fallback;
    const img = h('img', { class: cls, src: url, alt: '', draggable: 'false' });
    img.addEventListener('error', () => img.replaceWith(fallback), { once: true });
    return img;
  }

  onInputKey(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.list.querySelector('.ovr-row')?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(this.timer);
      this.search().then(() => {
        const first = this.state.results[0];
        if (first) this.openItem(first.id, { fresh: true });
      });
    }
  }

  onListKey(e) {
    const rows = [...this.list.querySelectorAll('.ovr-row')];
    const i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === 'ArrowDown' && rows[i + 1]) rows[i + 1].focus();
    else if (e.key === 'ArrowUp') (rows[i - 1] || this.input).focus();
    else return;
    e.preventDefault();
  }

  async openItem(id, { fresh = false } = {}) {
    if (!fresh && this.state.card) this.history.push(this.state.card.id);
    if (fresh) this.history = [];
    const token = ++this.itemToken;
    const r = await this.ask({ action: 'recipes.item', id });
    if (token !== this.itemToken) return;
    if (!r.ok) return this.fail(r);
    if (!r.data) return;
    this.remember(r.data.icons);
    this.state.card = r.data;
    this.state.tab = r.data.recipes.length || !r.data.uses.length ? 'recipes' : 'uses';
    this.state.optIn = false;
    this.drawCard();
    this.drawList();
  }

  back() {
    const id = this.history.pop();
    if (id) this.openItem(id, { fresh: false }).then(() => this.history.pop());
  }

  showDetail(...nodes) {
    this.detail.replaceChildren(...nodes.filter(Boolean));
  }

  drawCard() {
    const c = this.state.card;
    const tr = this.tr;
    const tabs = [
      ['recipes', tr('rc_tabRecipes', { count: c.recipes.length + c.recipesMore })],
      ['uses', tr('rc_tabUses', { count: c.uses.length + c.usesMore })],
    ];
    const tab = this.state.tab;
    const list = tab === 'recipes' ? c.recipes : c.uses;
    const more = tab === 'recipes' ? c.recipesMore : c.usesMore;
    this.showDetail(
      h(
        'div',
        { class: 'ovr-head' },
        this.history.length ? h('button', { type: 'button', class: 'ovl-icon-btn', title: tr('rc_back'), 'aria-label': tr('rc_back'), onclick: () => this.back() }, icon('arrowLeft')) : null,
        this.itemIcon(c.id, c.name, 'ovr-icon big'),
        h('div', { class: 'ovr-head-text' }, h('div', { class: 'ovr-title' }, c.name), h('div', { class: 'ovr-sub ovl-selectable' }, c.id)),
        c.wiki ? h('button', { type: 'button', class: 'ovl-btn', title: tr('rc_wikiHint'), onclick: () => this.wiki() }, icon('external'), tr('rc_openWiki')) : null,
      ),
      this.state.optIn ? this.wikiOptIn() : null,
      h(
        'div',
        { class: 'ovr-tabs', role: 'tablist' },
        tabs.map(([id, label]) => h('button', { type: 'button', class: ['ovr-tab', id === tab && 'on'], role: 'tab', 'aria-selected': String(id === tab), onclick: () => this.setTab(id) }, label)),
      ),
      list.length
        ? h('div', { class: 'ovr-cards' }, list.map((r) => this.recipeCard(r)), more ? h('div', { class: 'ovr-none' }, tr('rc_more', { count: more })) : null)
        : h('div', { class: 'ovr-empty' }, icon('info'), tr(tab === 'recipes' ? 'rc_noRecipeHint' : 'rc_noUses')),
    );
    this.detail.scrollTop = 0;
  }

  setTab(id) {
    this.state.tab = id;
    this.drawCard();
  }

  async wiki() {
    const c = this.state.card;
    if (!c) return;
    if (!this.state.wikiAllowed) {
      this.state.optIn = true;
      this.drawCard();
      return;
    }
    const r = await this.ask({ action: 'recipes.wiki', id: c.id });
    if (r.ok && r.data?.opened) this.onWikiOpened?.();
    else if (r.ok && r.data?.code === 'optin') {
      this.state.wikiAllowed = false;
      this.state.optIn = true;
      this.drawCard();
    }
  }

  // Conexion opcional: se activa desde donde se usa (tambien esta en Ajustes > Privacidad)
  wikiOptIn() {
    const tr = this.tr;
    return h(
      'div',
      { class: 'ovr-optin', role: 'group', 'aria-label': tr('rc_wikiOptTitle') },
      h('div', { class: 'ovr-optin-text' }, h('strong', {}, tr('rc_wikiOptTitle')), h('span', {}, tr('rc_wikiOptText'))),
      h(
        'button',
        {
          type: 'button',
          class: 'ovl-btn primary',
          onclick: async () => {
            const r = await this.ask({ action: 'recipes.wikiAllow' });
            if (!r.ok) return;
            this.state.wikiAllowed = true;
            this.state.optIn = false;
            this.wiki();
          },
        },
        icon('check'),
        tr('rc_wikiOptEnable'),
      ),
    );
  }

  // ---------- Recetas ----------
  slot(s) {
    if (!s || !s.items?.length) return h('span', { class: 'ovr-slot empty', 'aria-hidden': 'true' });
    const first = s.items[0];
    const names = s.items.map((i) => i.name);
    if (s.more) names.push(this.tr('rc_andMore', { count: s.more }));
    const alt = s.items.length + (s.more || 0) > 1;
    return h(
      'button',
      {
        type: 'button',
        class: ['ovr-slot', alt && 'alt'],
        title: alt ? this.tr('rc_anyOf', { names: names.join(', ') }) : first.name,
        'aria-label': alt ? this.tr('rc_anyOf', { names: names.join(', ') }) : first.name,
        onclick: () => this.openItem(first.id),
      },
      this.itemIcon(first.id, first.name),
      alt ? h('span', { class: 'ovr-slot-alt', 'aria-hidden': 'true' }, `+${s.items.length + (s.more || 0) - 1}`) : null,
    );
  }

  resultSlot(result) {
    return h(
      'button',
      { type: 'button', class: 'ovr-slot result', title: result.name, 'aria-label': this.tr('rc_resultAria', { name: result.name, count: result.count }), onclick: () => this.openItem(result.id) },
      this.itemIcon(result.id, result.name),
      result.count > 1 ? h('span', { class: 'ovr-slot-count', 'aria-hidden': 'true' }, String(result.count)) : null,
    );
  }

  recipeCard(r) {
    const tr = this.tr;
    const label = STATION_KEY[r.station] ? tr(STATION_KEY[r.station]) : r.station;
    const notes = [];
    if (r.kind === 'shapeless') notes.push(tr('rc_shapeless'));
    if (r.time) notes.push(tr('rc_time', { seconds: fmtSeconds(r.time) }));
    if (r.xp) notes.push(tr('rc_xp', { xp: r.xp }));
    return h(
      'article',
      { class: `ovr-card ovr-k-${r.kind}` },
      h('div', { class: 'ovr-card-head' }, h('span', { class: 'ovr-station' }, label), notes.length ? h('span', { class: 'ovr-notes' }, notes.join(' · ')) : null),
      h('div', { class: 'ovr-layout' }, this.recipeInput(r), h('span', { class: 'ovr-arrow', 'aria-hidden': 'true' }, icon(r.kind === 'cooking' ? 'flame' : 'arrowRight')), this.resultSlot(r.result)),
    );
  }

  recipeInput(r) {
    if (r.kind === 'shaped' || r.kind === 'shapeless') {
      // Grilla de 3x3 como la mesa de crafteo; los mods con mesas mas grandes usan su tamano
      const shaped = r.kind === 'shaped';
      const width = shaped ? Math.max(3, r.width) : Math.max(3, Math.ceil(Math.sqrt(r.slots.length)));
      const rows = shaped ? Math.max(3, r.height) : Math.max(3, Math.ceil(r.slots.length / width));
      const cells = [];
      for (let i = 0; i < width * rows; i++) {
        if (shaped) {
          const x = i % width;
          const y = Math.floor(i / width);
          cells.push(x < r.width && y < r.height ? this.slot(r.slots[y * r.width + x]) : this.slot(null));
        } else cells.push(this.slot(r.slots[i] || null));
      }
      return h('div', { class: 'ovr-grid', style: { '--ovr-cols': String(width) } }, cells);
    }
    return h('div', { class: 'ovr-row-slots' }, r.slots.map((s) => this.slot(s)));
  }
}
