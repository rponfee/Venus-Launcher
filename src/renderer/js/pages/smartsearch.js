// Buscador inteligente: pedidos en lenguaje natural -> kit de mods, texturas, shaders y mas,
// con la compatibilidad verificada para la version y el loader elegidos.
import { h, icon, mount, modal, toast, ok, fail, confirmDialog, selectEl, switchEl, fmtNumber, fmtAgo, LOADERS, loaderBadge, instanceLoaderKey, debounce, sectionTitle, reducedMotion } from '../ui.js';
import { store, api } from '../store.js';
import { t, has, loadNs, locale } from '../i18n.js';
import { navigate } from '../app.js';
import { createMoreFilters, emptyMore, morePayload, morePills, moreCount, clearMore, joinTerms, radioKeys } from '../features/searchfilters.js';

const T = (key, vars) => t(`smartsearch.${key}`, vars);
const hasT = (key) => has(`smartsearch.${key}`);

const TYPES = ['mod', 'resourcepack', 'shader', 'datapack', 'plugin', 'modpack'];
const TYPE_ICON = { mod: 'puzzle', resourcepack: 'palette', shader: 'sun', datapack: 'file', plugin: 'server', modpack: 'package' };
const MODE_ICON = { singleplayer: 'user', multiplayer: 'users', server: 'server' };
const EXAMPLES = [
  ['skull', 1],
  ['users', 2],
  ['flame', 3],
  ['swords', 4],
  ['gauge', 5],
  ['server', 6],
  ['moon', 7],
  ['cloud', 8],
];
const LOADER_FILTERS = ['auto', 'fabric', 'forge', 'neoforge', 'quilt', 'vanilla'];
const CREATE_LOADERS = ['fabric', 'forge', 'neoforge', 'quilt', 'vanilla', 'optifine'];
const MOD_LOADERS = ['fabric', 'forge', 'neoforge', 'quilt', 'legacyfabric'];
// Resultados por tipo que se pueden elegir (el modulo admite hasta MAX_PER_TYPE = 12); se recuerda en los ajustes
const PER_TYPE = [3, 5, 8, 12];
// Lo guardado en los ajustes puede ser cualquier valor de 1 a 12: se muestra la opcion mas cercana (sin valor, 5)
const nearestPerType = (v) => (Number(v) > 0 ? PER_TYPE.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a)) : 5);
const STAGES = ['interpret', 'ai', 'search', 'verify', 'rank'];
const PERF_ORDER = ['potato', 'low', 'medium', 'high', 'screenshot'];
const NOT_KIT = new Set(['modpack', 'plugin']);
const WARN_KEYS = new Set(['versionMismatch', 'modsNeedLoader', 'loaderMismatch', 'shadersNeedLoader', 'shadersNoHelper', 'conflict', 'conflictInstalled', 'badVersion', 'noVersion', 'aiFailed']);

// Lo que sobrevive a la navegacion dentro del launcher (volver a la pagina muestra el ultimo kit).
// filters incluye los de "Mas filtros" (emptyMore: frase, palabras excluidas, autor, descargas, dias, codigo abierto, entorno).
const session = { query: '', filters: null, result: null, selection: new Map(), reasonsState: null, pending: null, scroll: 0, pluginServer: null, moreOpen: false };

// Capacidades de "Mas filtros" en el buscador: Modrinth (autor = usuario exacto) y entorno solo para mods y modpacks
const moreCaps = () => ({ environment: true, authorMode: 'username', openSourceMode: 'license', envNote: T('envNote') });

// [hidden] pierde contra clases que definen display (.notice, .btn...): se usa una clase propia.
const show = (el, on) => {
  el.classList.toggle('ss-hidden', !on);
  return el;
};

// Redibuja un contenedor sin perder el foco del teclado: vuelve al control nuevo con el mismo data-fk.
function keepFocus(container, render) {
  const a = document.activeElement;
  const fk = a && a !== document.body && container.contains(a) ? a.dataset?.fk : null;
  const out = render();
  if (fk) {
    const el = [...container.querySelectorAll('[data-fk]')].find((x) => x.dataset.fk === fk);
    if (el && !el.disabled && el.isConnected) el.focus({ preventScroll: true });
  }
  return out;
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

function listFormat(items) {
  try {
    return new Intl.ListFormat(locale(), { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

function loaderName(key) {
  if (key === 'vanilla') return LOADERS.vanilla.name;
  return LOADERS[key]?.name || key;
}

function hasModLoader(inst) {
  return Boolean(inst && MOD_LOADERS.includes(inst.loader));
}

export default {
  ns: ['smartsearch', 'searchfilters'],
  css: ['pages/smartsearch', 'features/searchfilters'],
  async render(root, params) {
    let disposed = false;
    const offs = [];
    const cardRefs = new Map(); // projectId -> { el, reason, it }
    const state = {
      ctx: { ai: false, aiConfigured: false, latestRelease: null, releases: [], prefs: { perType: 5, compatibleOnly: true, useAi: true }, history: [] },
      filters: session.filters,
      running: null,
      result: session.result,
      servers: [],
    };

    // ---------- Encabezado ----------
    const aiPill = h('div', { class: 'ss-ai-slot' });
    const head = h(
      'div',
      { class: 'page-head' },
      h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, T('title')), h('p', { class: 'page-sub' }, T('subtitle'))),
      h('div', { class: 'page-actions' }, aiPill, h('button', { class: 'btn ghost', type: 'button', onclick: () => openHistory() }, icon('history'), T('history'))),
    );

    function drawAiPill() {
      if (state.ctx.ai) {
        mount(aiPill, h('span', { class: 'ss-ai-pill on', title: T('useAiHint') }, icon('sparkles'), T('aiOn')));
        return;
      }
      mount(
        aiPill,
        h(
          'span',
          { class: 'ss-ai-pill', title: T('aiOffHint') },
          icon('cpu'),
          h('span', {}, T('aiOff')),
          h('button', { class: 'ss-ai-link', type: 'button', onclick: () => navigate('settings/ai') }, icon('settings'), T('aiConfigure')),
        ),
      );
    }

    // ---------- Pedido ----------
    const input = h('textarea', { class: 'ss-input', rows: 2, maxlength: 400, placeholder: T('placeholder'), 'aria-label': T('promptLabel'), spellcheck: 'false' });
    input.value = session.query || '';
    const goBtn = h('button', { class: 'btn primary ss-go', onclick: () => submit() }, icon('search'), T('search'));
    const preview = h('div', { class: 'ss-preview', 'aria-live': 'polite' });
    // Crece con el texto (el placeholder no cuenta: Chromium lo suma a scrollHeight).
    const autoGrow = () => {
      input.style.height = '';
      if (!input.value) return;
      input.style.height = 'auto';
      input.style.height = `${Math.min(Math.max(input.scrollHeight, 52), 150)}px`;
    };
    input.addEventListener('input', () => {
      session.query = input.value;
      autoGrow();
      previewSoon();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape' && state.running) {
        e.preventDefault();
        cancelRun();
      }
    });
    const hero = h(
      'section',
      { class: 'ss-hero' },
      h('div', { class: 'ss-prompt' }, h('div', { class: 'ss-prompt-icon' }, icon('sparkles')), input),
      h('div', { class: 'ss-prompt-foot' }, preview, h('span', { class: 'ss-hint' }, T('hintEnter')), goBtn),
      h(
        'div',
        { class: 'ss-examples' },
        h('span', { class: 'ss-examples-label' }, T('examplesLabel')),
        EXAMPLES.map(([ic, n]) =>
          h(
            'button',
            {
              type: 'button',
              class: 'chip ss-example',
              title: T(`ex${n}Query`),
              onclick: () => {
                input.value = T(`ex${n}Query`);
                session.query = input.value;
                autoGrow();
                submit();
              },
            },
            icon(ic),
            T(`ex${n}Label`),
          ),
        ),
      ),
    );

    // Vista previa de lo que se entiende mientras se escribe (sin IA, al instante)
    let previewToken = 0;
    const previewSoon = debounce(async () => {
      const q = input.value.trim();
      const token = ++previewToken;
      if (q.length < 3) {
        mount(preview);
        return;
      }
      try {
        const plan = await api.invoke('smartsearch:plan', q, { ...filtersPayload(), useAi: false });
        if (token !== previewToken || disposed) return;
        mount(preview, h('span', { class: 'ss-preview-label' }, T('previewLabel')), planChips(plan, { compact: true }));
      } catch {
        if (token === previewToken) mount(preview);
      }
    }, 300);

    // ---------- Filtros ----------
    const filtersBox = h('section', { class: 'card flat ss-filters', 'aria-label': T('filtersTitle') });
    const currentTarget = () => store.instances.find((i) => i.id === state.filters.instanceId) || null;
    const releases = () => state.ctx.releases || [];
    const savePrefs = debounce(() => {
      const { perType, compatibleOnly, useAi } = state.filters;
      api.invoke('smartsearch:savePrefs', { perType, compatibleOnly, useAi }).catch(() => {});
    }, 400);

    function filtersPayload() {
      const f = state.filters;
      return { instanceId: f.instanceId || null, mcVersion: f.mcVersion, loader: f.loader, types: f.types, perType: f.perType, compatibleOnly: f.compatibleOnly, useAi: f.useAi && state.ctx.ai, ...morePayload(f, moreCaps()) };
    }

    // "Mas filtros": el panel comparte con el catalogo de Modrinth (features/searchfilters.js). Los cambios de texto no
    // redibujan los filtros (se perderia el foco): solo actualizan el contador del boton.
    const moreBadge = h('span', { class: 'ss-more-count', 'aria-hidden': 'true' });
    const moreSr = h('span', { class: 'sr-only' });
    const moreClearBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn sm ghost',
        dataset: { fk: 'more-clear' },
        onclick: () => {
          clearMore(state.filters);
          moreForm?.refresh();
          syncMoreBadge();
        },
      },
      icon('x'),
      t('searchfilters.clear'),
    );
    let moreForm = null;
    function syncMoreBadge() {
      const n = moreCount(state.filters, moreCaps());
      moreBadge.textContent = String(n);
      moreBadge.hidden = !n;
      moreSr.textContent = n ? ` (${t('searchfilters.activeCount', { count: n })})` : '';
      moreClearBtn.disabled = !n;
    }
    function moreFiltersPanel() {
      moreForm = moreForm || createMoreFilters({ state: state.filters, caps: moreCaps, idPrefix: 'ss', onChange: syncMoreBadge });
      const open = session.moreOpen;
      syncMoreBadge();
      const toggle = h(
        'button',
        {
          type: 'button',
          class: 'btn ss-more-btn',
          'aria-expanded': open ? 'true' : 'false',
          'aria-controls': 'ss-more-panel',
          dataset: { fk: 'more' },
          onclick: () => {
            session.moreOpen = !session.moreOpen;
            if (session.moreOpen) moreForm.refresh();
            drawFilters();
            if (session.moreOpen) moreForm.el.querySelector('input')?.focus();
          },
        },
        icon('sliders'),
        t('searchfilters.title'),
        moreBadge,
        moreSr,
        h('span', { class: ['ss-caret', open && 'open'], 'aria-hidden': 'true' }, icon('chevronDown')),
      );
      const panel = h(
        'div',
        {
          class: 'ss-more',
          id: 'ss-more-panel',
          role: 'region',
          'aria-label': t('searchfilters.title'),
          hidden: !open,
          onkeydown: (e) => {
            if (e.key !== 'Escape' || !session.moreOpen) return;
            e.stopPropagation();
            session.moreOpen = false;
            drawFilters();
            filtersBox.querySelector('[data-fk="more"]')?.focus({ preventScroll: true });
          },
        },
        open ? moreForm.el : null,
        open ? h('div', { class: 'ss-more-foot' }, h('span', { class: 'ss-more-hint' }, icon('info'), T('moreHint')), h('span', { class: 'spacer' }), moreClearBtn) : null,
      );
      return h('div', { class: 'ss-more-wrap' }, toggle, panel);
    }

    // Interruptor con titulo y una linea de ayuda visible (antes la ayuda estaba solo en el tooltip)
    function toggleRow(text, hint, checked, onChange, disabled) {
      const sw = switchEl(checked, onChange, text);
      const box = sw.querySelector('input');
      box.dataset.fk = `toggle-${text}`;
      if (disabled) box.disabled = true;
      return h(
        'div',
        { class: ['ss-toggle', disabled && 'disabled'] },
        sw,
        h(
          'div',
          { class: 'ss-toggle-body' },
          h(
            'span',
            {
              class: 'ss-toggle-text',
              onclick: () => {
                if (!disabled) box.click();
              },
            },
            text,
          ),
          hint ? h('span', { class: 'ss-toggle-hint' }, hint) : null,
        ),
      );
    }

    // Los filtros se redibujan enteros al cambiar: el foco vuelve al mismo control
    function drawFilters() {
      keepFocus(filtersBox, renderFilters);
    }

    function renderFilters() {
      const f = state.filters;
      if (f.instanceId && !store.instances.some((i) => i.id === f.instanceId)) f.instanceId = '';
      const target = currentTarget();
      const autoVersion = target?.mcVersion || state.ctx.latestRelease;
      const versions = releases().slice();
      if (f.mcVersion !== 'auto' && !versions.includes(f.mcVersion)) versions.unshift(f.mcVersion);
      const field = (label, control) => h('label', { class: 'ss-field' }, h('span', { class: 'ss-field-label' }, label), control);
      const instSel = selectEl(
        [{ value: '', label: T('targetNone') }, ...store.instances.map((i) => ({ value: i.id, label: `${i.name} · ${i.mcVersion} · ${loaderName(instanceLoaderKey(i))}` }))],
        f.instanceId || '',
        (v) => {
          f.instanceId = v;
          drawFilters();
          drawDock();
          previewSoon();
        },
      );
      const verSel = selectEl(
        [{ value: 'auto', label: autoVersion ? T('versionAuto', { version: autoVersion }) : T('versionAutoPlain') }, ...versions.map((v) => ({ value: v, label: v }))],
        f.mcVersion,
        (v) => {
          f.mcVersion = v;
          previewSoon();
        },
      );
      const loaderSel = selectEl(
        LOADER_FILTERS.map((l) => ({ value: l, label: l === 'auto' ? T('loaderAuto') : l === 'vanilla' ? T('loaderVanilla') : loaderName(l) })),
        f.loader,
        (v) => {
          f.loader = v;
          previewSoon();
        },
      );
      instSel.dataset.fk = 'target';
      verSel.dataset.fk = 'version';
      loaderSel.dataset.fk = 'loader';
      // Resultados por tipo: se guarda en los ajustes (smartsearch:savePrefs) y vuelve a estar elegido al abrir el launcher
      const perTypeId = 'ss-pertype-label';
      const perType = h(
        'div',
        { class: 'segmented ss-seg', role: 'radiogroup', 'aria-labelledby': perTypeId, title: T('perTypeTitle'), onkeydown: radioKeys },
        PER_TYPE.map((n) =>
          h(
            'button',
            {
              type: 'button',
              role: 'radio',
              class: f.perType === n ? 'active' : '',
              'aria-checked': String(f.perType === n),
              tabindex: f.perType === n ? 0 : -1,
              dataset: { fk: `per-${n}` },
              onclick: () => {
                if (f.perType === n) return;
                f.perType = n;
                savePrefs();
                drawFilters();
              },
            },
            String(n),
          ),
        ),
      );
      const typesId = 'ss-types-label';
      const typeChips = h(
        'div',
        { class: 'chips ss-types', role: 'group', 'aria-labelledby': typesId },
        h(
          'button',
          {
            type: 'button',
            class: ['chip', !f.types.length && 'active'],
            'aria-pressed': String(!f.types.length),
            title: T('typesAutoHint'),
            dataset: { fk: 'type-auto' },
            onclick: () => {
              f.types = [];
              drawFilters();
              previewSoon();
            },
          },
          icon('wand'),
          T('typesAuto'),
        ),
        TYPES.map((tp) =>
          h(
            'button',
            {
              type: 'button',
              class: ['chip', f.types.includes(tp) && 'active'],
              'aria-pressed': String(f.types.includes(tp)),
              dataset: { fk: `type-${tp}` },
              onclick: () => {
                f.types = f.types.includes(tp) ? f.types.filter((x) => x !== tp) : [...f.types, tp];
                drawFilters();
                previewSoon();
              },
            },
            icon(TYPE_ICON[tp]),
            T(`type_${tp}`),
          ),
        ),
      );
      mount(
        filtersBox,
        h(
          'div',
          { class: 'ss-filter-grid' },
          field(T('filterTarget'), instSel),
          field(T('filterVersion'), verSel),
          field(T('filterLoader'), loaderSel),
          h('div', { class: 'ss-field ss-field-per' }, h('span', { class: 'ss-field-label', id: perTypeId }, T('filterPerType')), perType),
        ),
        h('div', { class: 'ss-filter-row' }, h('span', { class: 'ss-field-label', id: typesId }, T('filterTypes')), typeChips),
        moreFiltersPanel(),
        h(
          'div',
          { class: 'ss-toggles' },
          toggleRow(T('compatibleOnly'), T('compatibleOnlyHint'), f.compatibleOnly, (v) => {
            f.compatibleOnly = v;
            savePrefs();
          }),
          toggleRow(
            T('useAi'),
            state.ctx.ai ? T('useAiHint') : T('aiOffHint'),
            f.useAi && state.ctx.ai,
            (v) => {
              f.useAi = v;
              savePrefs();
            },
            !state.ctx.ai,
          ),
        ),
      );
    }

    // ---------- Chips del plan ----------
    function planChips(plan, { compact = false } = {}) {
      const chips = [];
      for (const tp of plan.types || []) chips.push(h('span', { class: 'ss-chip type' }, icon(TYPE_ICON[tp]), T(`type_${tp}`)));
      if (plan.mcVersion) {
        const title = [T(`versionFrom_${plan.versionSource}`), plan.versionNote ? T('versionMapped', plan.versionNote) : null].filter(Boolean).join('\n');
        chips.push(h('span', { class: 'ss-chip', title }, icon('layers'), plan.mcVersion));
      }
      const loader = plan.resolvedLoader || plan.loader;
      if (loader && (LOADERS[loader] || loader === 'vanilla')) {
        const b = loaderBadge(loader);
        b.classList.add('ss-chip-loader');
        b.title = T(`loaderFrom_${plan.loaderSource}`);
        chips.push(b);
      }
      if (plan.mode && plan.mode !== 'any') chips.push(h('span', { class: 'ss-chip' }, icon(MODE_ICON[plan.mode] || 'gamepad'), T(`mode_${plan.mode}`)));
      for (const th of plan.themes || []) {
        if (compact && th.minor) continue;
        if (!hasT(`theme_${th.id}`)) continue;
        chips.push(h('span', { class: ['ss-chip', 'theme', th.minor && 'minor'] }, T(`theme_${th.id}`)));
      }
      if (!compact) for (const th of plan.aiThemes || []) chips.push(h('span', { class: 'ss-chip ai', title: T('srcAi') }, icon('sparkles'), th));
      return chips;
    }

    // ---------- Resultados ----------
    const resultsBox = h('section', { class: 'ss-results', 'aria-live': 'polite' });
    const dock = h('div', { class: 'ss-dock ss-hidden' });

    function drawIdle() {
      cardRefs.clear();
      show(dock, false);
      mount(
        resultsBox,
        h(
          'ol',
          { class: 'ss-how', 'aria-label': T('howTitle') },
          [1, 2, 3].map((n) =>
            h(
              'li',
              { class: 'ss-how-step' },
              h('div', { class: 'ss-how-num', 'aria-hidden': 'true' }, String(n)),
              h('div', { class: 'ss-how-body' }, h('div', { class: 'ss-how-title' }, T(`how${n}Title`)), h('div', { class: 'ss-how-text' }, T(`how${n}Text`))),
            ),
          ),
        ),
        historySection(),
      );
    }

    // Lista de busquedas recientes. Al quitar una con el teclado, el foco pasa a la siguiente.
    function historyList(onPick, redraw) {
      const hist = state.ctx.history || [];
      if (!hist.length) return h('div', { class: 'ss-hist-empty' }, h('div', { class: 'ss-hist-empty-icon' }, icon('history')), h('div', {}, T('recentEmpty')));
      const list = h(
        'div',
        { class: 'ss-history', role: 'list' },
        hist.map((e, i) =>
          h(
            'div',
            { class: 'ss-hist', role: 'listitem' },
            h(
              'button',
              { type: 'button', class: 'ss-hist-run', title: T('runAgain'), onclick: () => onPick(e) },
              h('span', { class: 'ss-hist-icon', 'aria-hidden': 'true' }, icon(e.ai ? 'sparkles' : 'search')),
              h(
                'span',
                { class: 'ss-hist-main' },
                h('span', { class: 'ss-hist-q', title: e.query }, e.query),
                h(
                  'span',
                  { class: 'ss-hist-meta' },
                  h('span', {}, e.mcVersion ? T('historyMeta', { version: e.mcVersion, when: fmtAgo(e.at) }) : T('historyMetaNoVersion', { when: fmtAgo(e.at) })),
                  h('span', { class: 'ss-hist-types' }, (e.types || []).map((tp) => h('span', { title: T(`type_${tp}`) }, icon(TYPE_ICON[tp] || 'box'), h('span', { class: 'num' }, String(e.counts?.[tp] ?? ''))))),
                ),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                class: 'icon-btn sm ss-hist-x',
                title: T('removeRecent'),
                'aria-label': `${T('removeRecent')}: ${e.query}`,
                onclick: async (ev) => {
                  ev.stopPropagation();
                  const hadFocus = ev.currentTarget === document.activeElement;
                  try {
                    state.ctx.history = await api.invoke('smartsearch:removeHistory', e.id);
                  } catch {
                    state.ctx.history = hist.filter((x) => x.id !== e.id);
                  }
                  const box = redraw ? redraw() : !state.result && !state.running ? (drawIdle(), resultsBox) : null;
                  if (hadFocus && box) {
                    const xs = box.querySelectorAll('.ss-hist-x');
                    (xs[Math.min(i, xs.length - 1)] || input).focus({ preventScroll: true });
                  }
                },
              },
              icon('x'),
            ),
          ),
        ),
      );
      return list;
    }

    function historySection() {
      const hist = state.ctx.history || [];
      return h(
        'section',
        { class: 'ss-recent' },
        sectionTitle(
          T('recentTitle'),
          hist.length
            ? h(
                'button',
                {
                  class: 'btn ghost sm',
                  type: 'button',
                  onclick: async () => {
                    if (!(await confirmDialog(T('clearHistory'), T('clearHistoryConfirm'), { okText: T('clearHistory'), danger: true }))) return;
                    state.ctx.history = await api.invoke('smartsearch:clearHistory').catch(() => []);
                    drawIdle();
                    input.focus({ preventScroll: true });
                  },
                },
                icon('trash'),
                T('clearHistory'),
              )
            : null,
        ),
        historyList((e) => rerun(e)),
      );
    }

    function rerun(e) {
      input.value = e.query;
      session.query = e.query;
      autoGrow();
      if (e.filters) {
        if (e.filters.instanceId && store.instances.some((i) => i.id === e.filters.instanceId)) state.filters.instanceId = e.filters.instanceId;
        if (e.filters.mcVersion) state.filters.mcVersion = e.filters.mcVersion;
        if (e.filters.loader) state.filters.loader = e.filters.loader;
        if (Array.isArray(e.filters.types)) state.filters.types = e.filters.types;
        drawFilters();
      }
      runSearch(e.query);
    }

    function openHistory() {
      const box = h('div', { class: 'ss-history-modal' });
      const pick = (e) => {
        m.close();
        rerun(e);
      };
      // quitar una busqueda actualiza la lista del dialogo (y la de la pagina si se ve)
      const redraw = () => {
        mount(box, historyList(pick, redraw));
        if (!state.result && !state.running) drawIdle();
        return box;
      };
      mount(box, historyList(pick, redraw));
      const m = modal({ title: T('recentTitle'), size: 'wide', body: box });
    }

    // ---------- Progreso ----------
    let progressRefs = null;
    function drawProgress() {
      cardRefs.clear();
      show(dock, false);
      const run = state.running;
      const stages = STAGES.filter((s) => s !== 'ai' || run.aiUsed);
      const bar = h('i', { style: { width: '4%' } });
      const rows = new Map();
      const list = h(
        'ol',
        { class: 'ss-stages' },
        stages.map((s) => {
          const label = h('span', { class: 'ss-stage-label' }, T(`stage_${s}`));
          const count = h('span', { class: 'ss-stage-count' });
          const dot = h('span', { class: 'ss-stage-dot' });
          const row = h('li', { class: 'ss-stage' }, dot, label, count);
          rows.set(s, { row, count, dot });
          return row;
        }),
      );
      progressRefs = { bar, rows, stages };
      // tarjetas fantasma con la forma de las reales (casilla, icono, motivo, texto, etiquetas y boton)
      const bone = (cls, w) => h('span', { class: `skeleton ${cls}`, style: w ? { width: w } : null });
      const skelCard = (i) =>
        h(
          'div',
          { class: 'ss-card ss-skel' },
          h('div', { class: 'ss-card-top' }, bone('ss-sk-box'), bone('ss-card-icon'), h('div', { class: 'ss-card-main ss-sk-lines' }, bone('skeleton-line', `${48 + ((i * 17) % 34)}%`), bone('skeleton-line', '34%'))),
          bone('skeleton-line', `${56 + ((i * 11) % 30)}%`),
          h('div', { class: 'ss-sk-lines' }, bone('skeleton-line'), bone('skeleton-line', '78%')),
          h('div', { class: 'ss-card-foot' }, h('div', { class: 'ss-tags' }, bone('ss-sk-badge'), bone('ss-sk-badge')), bone('ss-sk-btn')),
        );
      mount(
        resultsBox,
        h(
          'div',
          { class: 'card ss-progress', role: 'status' },
          h(
            'div',
            { class: 'ss-progress-head' },
            h('div', { class: 'spinner', 'aria-hidden': 'true' }),
            h('div', { class: 'ss-progress-title' }, T('progressTitle')),
            h('span', { class: 'spacer' }),
            h('button', { class: 'btn ghost sm', type: 'button', onclick: () => cancelRun() }, icon('x'), T('cancel')),
          ),
          h('div', { class: 'progress ss-progress-bar' }, bar),
          list,
        ),
        h('div', { class: 'ss-skel-grid skeleton-group', 'aria-hidden': 'true' }, [0, 1, 2, 3].map(skelCard)),
      );
      updateProgress({ stage: run.stage, ...(run.counts[run.stage] || {}) });
    }

    function updateProgress(p) {
      if (!progressRefs || !state.running) return;
      const run = state.running;
      if (p.stage && STAGES.includes(p.stage)) {
        run.stage = p.stage;
        if (p.total !== undefined) run.counts[p.stage] = { done: p.done, total: p.total };
        if (p.stage === 'ai' && !run.aiUsed) {
          run.aiUsed = true;
          drawProgress();
          return;
        }
      }
      const idx = progressRefs.stages.indexOf(run.stage);
      progressRefs.stages.forEach((s, i) => {
        const r = progressRefs.rows.get(s);
        const st = i < idx ? 'done' : i === idx ? 'active' : 'pending';
        r.row.className = `ss-stage ${st}`;
        if (st === 'active') r.row.setAttribute('aria-current', 'step');
        else r.row.removeAttribute('aria-current');
        mount(r.dot, st === 'done' ? icon('check') : st === 'active' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : null);
        const c = run.counts[s];
        r.count.textContent = c && c.total ? T('stageCount', { done: c.done, total: c.total }) : '';
      });
      const frac = (c) => (c && c.total ? c.done / c.total : 0);
      const pct = { interpret: 6, ai: 14, search: 25 + 35 * frac(run.counts.search), verify: 60 + 32 * frac(run.counts.verify), rank: 95 }[run.stage] || 4;
      progressRefs.bar.style.width = `${Math.round(pct)}%`;
    }

    // ---------- Busqueda ----------
    function setRunning(on) {
      goBtn.disabled = on;
      mount(goBtn, on ? h('div', { class: 'spinner' }) : icon('search'), on ? T('searching') : T('search'));
    }

    async function submit() {
      const q = input.value.trim();
      if (!q) {
        input.focus();
        toast('info', T('errEmpty'));
        return;
      }
      runSearch(q);
    }

    async function runSearch(q) {
      if (!state.filters) return;
      if (state.running) cancelRun(true);
      const filters = { ...filtersPayload(), runId: newId() };
      session.query = q;
      state.running = { runId: filters.runId, stage: 'interpret', counts: {}, aiUsed: Boolean(filters.useAi) };
      const promise = api.invoke('smartsearch:run', q, filters);
      session.pending = { runId: filters.runId, promise, aiUsed: state.running.aiUsed };
      await follow(session.pending);
    }

    // Espera una busqueda en curso (tambien si se empezo antes de volver a la pagina).
    async function follow(pending) {
      if (!state.running || state.running.runId !== pending.runId) state.running = { runId: pending.runId, stage: 'interpret', counts: {}, aiUsed: pending.aiUsed };
      setRunning(true);
      drawProgress();
      try {
        const res = await pending.promise;
        if (session.pending === pending) {
          session.result = res;
          session.selection = new Map();
          session.reasonsState = res.aiReasons;
          session.scroll = 0;
        }
        if (disposed || state.running?.runId !== pending.runId) return;
        state.result = res;
        state.ctx.history = await api.invoke('smartsearch:history').catch(() => state.ctx.history);
        drawResults();
        resultsBox.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
      } catch (err) {
        if (disposed || state.running?.runId !== pending.runId) return;
        if (/cancel/i.test(err.message)) {
          toast('info', T('canceled'));
          if (state.result) drawResults();
          else drawIdle();
        } else drawError(err);
      } finally {
        if (session.pending === pending) session.pending = null;
        if (!disposed && state.running?.runId === pending.runId) {
          state.running = null;
          progressRefs = null;
          setRunning(false);
        }
      }
    }

    function cancelRun(silent) {
      const run = state.running;
      if (!run) return;
      api.invoke('smartsearch:cancel', run.runId).catch(() => {});
      if (silent) {
        state.running = null;
        session.pending = null;
      }
    }

    function drawError(err) {
      cardRefs.clear();
      show(dock, false);
      mount(
        resultsBox,
        h(
          'div',
          { class: 'notice bad ss-error', role: 'alert' },
          icon('alert'),
          h('div', { class: 'spacer' }, h('strong', {}, T('errSearch')), h('div', { class: 'ss-error-text' }, err.message)),
          h('button', { class: 'btn sm', type: 'button', onclick: () => submit() }, icon('refresh'), T('retry')),
        ),
      );
    }

    // ---------- Kit ----------
    const isSelected = (it) => (session.selection.has(it.id) ? session.selection.get(it.id) : it.selected);
    const selectable = (it) => it.type !== 'modpack' && it.compat !== 'incompatible';
    function kitItems() {
      if (!state.result) return [];
      return state.result.groups.filter((g) => !NOT_KIT.has(g.type)).flatMap((g) => g.items.filter((it) => selectable(it) && isSelected(it)));
    }
    function pluginItems() {
      const g = state.result?.groups.find((x) => x.type === 'plugin');
      return g ? g.items.filter((it) => selectable(it) && isSelected(it)) : [];
    }

    function summaryText(res) {
      const plan = res.plan;
      if (plan.summary) return plan.summary;
      const types = listFormat(plan.types.map((tp) => T(`typeLower_${tp}`)));
      return plan.mcVersion ? T('summaryLocal', { types, version: plan.mcVersion }) : T('summaryLocalNoVersion', { types });
    }

    const reasonsLine = h('div', { class: 'ss-u-reasons' });
    function drawReasonsLine() {
      const st = session.reasonsState;
      if (st === 'pending') mount(reasonsLine, h('span', { class: 'spinner' }), T('reasonsPending'));
      else if (st === 'failed') mount(reasonsLine, icon('info'), T('reasonsFailed'));
      else mount(reasonsLine);
      show(reasonsLine, st === 'pending' || st === 'failed');
    }

    // Filtros de "Mas filtros" que se aplicaron a esta busqueda (el modulo los devuelve ya saneados en res.filters)
    function appliedRow(res) {
      const f = res.filters || {};
      const m = { phrase: f.phrase || '', exclude: joinTerms(f.exclude || []), author: f.author || '', minDownloads: f.minDownloads || 0, updatedDays: f.updatedDays || 0, openSource: Boolean(f.openSource), environment: f.environment || '' };
      const pills = morePills(m, moreCaps());
      if (!pills.length) return null;
      return h('div', { class: 'ss-chips ss-applied' }, h('span', { class: 'ss-applied-label' }, icon('filter'), T('appliedFilters')), pills.map((p) => h('span', { class: 'ss-chip', title: p.label }, p.label)));
    }

    function understoodCard(res) {
      const plan = res.plan;
      const seconds = (res.stats?.ms || 0) / 1000;
      const searched = (plan.searches || []).filter((s) => s.query).map((s) => s.query);
      return h(
        'div',
        { class: 'card ss-understood' },
        h(
          'div',
          { class: 'ss-u-head' },
          h('span', { class: 'ss-u-label' }, icon('sparkles'), T('understood')),
          h('div', { class: 'ss-u-summary selectable' }, summaryText(res)),
          h('span', { class: ['badge', plan.source === 'ai' ? 'info' : ''], title: plan.source === 'ai' ? T('useAiHint') : T('aiOffHint') }, icon(plan.source === 'ai' ? 'sparkles' : 'cpu'), plan.source === 'ai' ? T('srcAi') : T('srcLocal')),
        ),
        h('div', { class: 'ss-chips' }, planChips(plan)),
        appliedRow(res),
        reasonsLine,
        h(
          'div',
          { class: 'ss-u-foot' },
          h('span', { class: 'ss-u-time num' }, icon('clock'), T('doneIn', { seconds: seconds.toLocaleString(locale(), { maximumFractionDigits: 1 }) })),
          searched.length ? h('span', { class: 'ss-u-searched', title: T('searchedFor', { list: [...new Set(searched)].join(' · ') }) }, icon('search'), h('span', { class: 'ellipsis' }, [...new Set(searched)].slice(0, 6).join(' · '))) : null,
        ),
      );
    }

    function warningsBox(res) {
      const list = res.warnings || [];
      if (!list.length && !res.versionSuggestion) return null;
      const rows = list.slice(0, 6).map((w) => {
        if (!hasT(`warn_${w.key}`)) return null;
        const warn = WARN_KEYS.has(w.key);
        const vars = { ...(w.vars || {}) };
        if (vars.loader) vars.loader = loaderName(vars.loader);
        if (vars.instLoader) vars.instLoader = loaderName(vars.instLoader);
        let action = null;
        if (['versionMismatch', 'modsNeedLoader', 'shadersNeedLoader', 'loaderMismatch'].includes(w.key) && kitItems().length) {
          action = h('button', { class: 'btn sm', type: 'button', onclick: () => createWithKit() }, icon('plus'), T('createWithKit'));
        } else if (w.key === 'pluginsNeedServer' && !eligibleServers().length) {
          action = h('button', { class: 'btn sm', type: 'button', onclick: () => navigate('servers') }, icon('server'), T('createServer'));
        } else if (w.key === 'aiFailed') {
          action = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => navigate('settings/ai') }, icon('settings'), T('aiConfigure'));
        }
        return h('div', { class: ['notice', !warn && 'info'] }, icon(warn ? 'alert' : 'info'), h('div', { class: 'spacer' }, T(`warn_${w.key}`, vars)), action);
      });
      const s = res.versionSuggestion;
      if (s) {
        rows.push(
          h(
            'div',
            { class: 'notice info' },
            icon('trending'),
            h('div', { class: 'spacer' }, T('suggestVersion', { type: T(`typeLower_${s.type}`), version: s.version, count: s.count })),
            h(
              'button',
              {
                class: 'btn sm',
                type: 'button',
                onclick: () => {
                  state.filters.mcVersion = s.version;
                  drawFilters();
                  runSearch(session.query || input.value.trim());
                },
              },
              icon('refresh'),
              T('suggestVersionBtn', { version: s.version }),
            ),
          ),
        );
      }
      return h('div', { class: 'ss-warnings' }, rows);
    }

    function reasonContent(it) {
      if (it.reason) return [icon('sparkles'), h('span', { title: T('aiReasonTitle') }, it.reason)];
      if (it.helper) return [icon('sparkles'), h('span', {}, T('whyHelper'))];
      const cat = (it.why || []).find((c) => hasT(`why_${c}`));
      const kw = it.matched?.[0] ? h('span', { class: 'ss-kw', title: T('whyMatch', { term: it.matched[0] }) }, it.matched[0]) : null;
      if (cat) return [icon('sparkles'), h('span', {}, T(`why_${cat}`)), kw];
      if (kw) return [icon('sparkles'), h('span', {}, T('whyMatch', { term: it.matched[0] }))];
      return null;
    }

    function compatBadge(it) {
      const plan = state.result.plan;
      const loaderTxt = it.type === 'mod' && plan.resolvedLoader ? loaderName(plan.resolvedLoader) : '';
      switch (it.compat) {
        case 'verified': {
          const title = [T('compatVerifiedTitle', { version: plan.mcVersion || '', loader: loaderTxt }).trim(), it.version?.number ? T('versionLabel', { number: it.version.number }) : null].filter(Boolean).join('\n');
          return h('span', { class: 'badge good', title }, icon('check'), T('compatVerified'));
        }
        case 'likely':
          return h('span', { class: 'badge' }, icon('info'), T('compatLikely'));
        case 'incompatible':
          return h('span', { class: 'badge bad' }, icon('x'), T('compatNo', { version: plan.mcVersion || '' }));
        case 'n/a': {
          const versions = (it.version?.gameVersions?.length ? it.version.gameVersions : it.gameVersions).slice(-2).join(', ');
          const loaders = it.loaders.map(loaderName).join('/');
          return versions ? h('span', { class: 'badge accent', title: T('modpackVersion', { versions }) }, icon('layers'), [versions, loaders].filter(Boolean).join(' · ')) : null;
        }
        default:
          return h('span', { class: 'badge warn' }, icon('alert'), T('compatUnknown'));
      }
    }

    // Exigencia de un shader: si trae varios perfiles es "ajustable"; si no, el mas liviano.
    function perfBadge(it) {
      const levels = PERF_ORDER.filter((p) => it.performance?.includes(p));
      if (!levels.length) return null;
      const title = levels.map((p) => (hasT(`perf_${p}`) ? T(`perf_${p}`) : p)).join(' · ');
      return h('span', { class: 'badge', title }, icon('gauge'), levels.length >= 3 ? T('perf_scalable') : T(`perf_${levels[0]}`));
    }

    function openModrinth(it) {
      api.app.openExternal(`https://modrinth.com/${it.type}/${encodeURIComponent(it.slug || it.id)}`).catch(() => {});
    }

    function card(it) {
      const canPick = selectable(it);
      const checked = canPick && isSelected(it);
      const reason = h('div', { class: ['ss-reason', it.reason && 'ai'] }, reasonContent(it));
      show(reason, reason.childNodes.length > 0);
      let box = null;
      if (canPick) {
        box = h('input', { type: 'checkbox', checked, 'aria-label': T('includeItem', { title: it.title }) });
      }
      const tags = [
        compatBadge(it),
        it.installed ? h('span', { class: 'badge modrinth' }, icon('check'), T('installedBadge')) : null,
        it.sideNote ? h('span', { class: 'badge' }, icon(it.sideNote === 'clientOnly' ? 'monitor' : 'server'), T(`side_${it.sideNote}`)) : null,
        it.resolution ? h('span', { class: 'badge' }, it.resolution) : null,
        perfBadge(it),
        ...it.conflicts.map((c) => h('span', { class: 'badge bad', title: T('conflictWith', { name: c.title }) }, icon('ban'), T('conflictWith', { name: c.title }))),
        it.deps.length ? h('span', { class: 'badge ss-deps', title: T('needs', { list: it.deps.map((d) => d.title).join(', ') }) }, icon('link'), T('needs', { list: it.deps.map((d) => d.title).join(', ') })) : null,
      ];
      // Instalar uno suelto es secundario (la accion principal es la barra del kit); el modpack es su propia accion
      const action =
        it.type === 'modpack'
          ? h('button', { class: 'btn sm tonal ss-card-cta', type: 'button', onclick: () => installModpack(it) }, icon('download'), T('installAsInstance'))
          : h('button', { class: 'btn sm', type: 'button', 'aria-label': `${T('install')}: ${it.title}`, onclick: () => installOne(it) }, icon('download'), T('install'));
      const img = h('img', { class: 'ss-card-icon', src: it.icon || 'assets/logo-64.png', alt: '', loading: 'lazy' });
      img.addEventListener('error', () => (img.src = 'assets/logo-64.png'), { once: true });
      const el = h(
        'article',
        { class: ['ss-card', checked && 'selected', it.installed && 'installed', it.compat === 'incompatible' && 'incompatible', it.helper && 'helper'], dataset: { id: it.id } },
        h(
          'div',
          { class: 'ss-card-top' },
          box ? h('label', { class: 'ss-pick', title: T('includeInKit') }, box, h('span', { class: 'ss-box' }, icon('check'))) : null,
          img,
          h(
            'div',
            { class: 'ss-card-main' },
            h(
              'div',
              { class: 'ss-card-title-row' },
              h('span', { class: 'ss-card-title', title: it.title }, it.title),
              it.helper ? h('span', { class: 'badge accent' }, T('helperBadge')) : null,
              it.fit === 'great' ? h('span', { class: 'ss-fit', title: T('fit_great'), role: 'img', 'aria-label': T('fit_great') }, icon('star')) : null,
            ),
            h(
              'div',
              { class: 'ss-card-meta' },
              it.author ? h('span', { class: 'ss-author', title: it.author }, T('by', { author: it.author })) : null,
              h('span', { class: 'num', title: T('downloadsTitle', { count: (it.downloads || 0).toLocaleString(locale()) }) }, icon('download'), fmtNumber(it.downloads)),
              it.updated ? h('span', { class: 'ss-updated', title: T('updatedTitle', { when: fmtAgo(it.updated) }) }, icon('clock'), fmtAgo(it.updated)) : null,
            ),
          ),
          h('button', { class: 'icon-btn sm ss-ext', type: 'button', title: T('openModrinth'), 'aria-label': `${T('openModrinth')}: ${it.title}`, onclick: () => openModrinth(it) }, icon('external')),
        ),
        reason,
        it.description ? h('div', { class: 'ss-desc', title: it.description }, it.description) : null,
        h('div', { class: 'ss-card-foot' }, h('div', { class: 'ss-tags' }, tags), action),
      );
      box?.addEventListener('change', () => {
        session.selection.set(it.id, box.checked);
        el.classList.toggle('selected', box.checked);
        drawDock();
      });
      cardRefs.set(it.id, { el, reason, it });
      return el;
    }

    function noteText(g) {
      const type = T(`typeLower_${g.type}`);
      if (g.note.key === 'fewResults') return T('note_fewResults', { count: g.note.vars?.count || 0 });
      if (g.note.key === 'noCompatible') return T('note_noCompatible', { type, version: state.result.plan.mcVersion || '' });
      return T('note_noResults', { type });
    }

    function eligibleServers() {
      return state.servers.filter((s) => ['paper', 'purpur'].includes(s.type));
    }

    function pluginControls() {
      const eligible = eligibleServers();
      if (!eligible.length) return h('button', { class: 'btn sm', type: 'button', title: T('pluginsNoServer'), onclick: () => navigate('servers') }, icon('plus'), T('createServer'));
      if (!eligible.some((s) => s.id === session.pluginServer)) session.pluginServer = eligible[0].id;
      const server = () => eligible.find((s) => s.id === session.pluginServer);
      const btn = h('button', { class: 'btn sm tonal ss-card-cta', type: 'button', onclick: () => installPlugins(server()) }, icon('download'), T('pluginsInstall', { name: server().name }));
      const sel = selectEl(
        eligible.map((s) => ({ value: s.id, label: `${s.name} · ${s.mcVersion}` })),
        session.pluginServer,
        (v) => {
          session.pluginServer = v;
          mount(btn, icon('download'), T('pluginsInstall', { name: server().name }));
        },
      );
      sel.setAttribute('aria-label', T('pluginsTarget'));
      return h('div', { class: 'ss-plugin-target' }, sel, btn);
    }

    function groupSection(g) {
      const pickable = g.items.filter(selectable);
      const real = g.items.filter((i) => !i.helper).length;
      const allOn = pickable.length && pickable.every(isSelected);
      const toggleAll =
        !NOT_KIT.has(g.type) || g.type === 'plugin'
          ? pickable.length > 1
            ? h(
                'button',
                {
                  class: 'btn ghost sm',
                  type: 'button',
                  'aria-pressed': allOn ? 'true' : 'false',
                  dataset: { fk: `all-${g.type}` },
                  onclick: () => {
                    for (const it of pickable) session.selection.set(it.id, !allOn);
                    drawResults(true);
                  },
                },
                icon(allOn ? 'x' : 'check'),
                allOn ? T('selectNone') : T('selectAll'),
              )
            : null
          : null;
      const titleId = `ss-group-${g.type}`;
      return h(
        'section',
        { class: 'ss-group', dataset: { type: g.type }, 'aria-labelledby': titleId },
        h(
          'div',
          { class: 'ss-group-head' },
          h('div', { class: ['ss-group-icon', `t-${g.type}`], 'aria-hidden': 'true' }, icon(TYPE_ICON[g.type])),
          h('h2', { class: 'ss-group-title', id: titleId }, T(`type_${g.type}`)),
          h('span', { class: 'pill num ss-group-count' }, String(real)),
          h('span', { class: 'ss-line', 'aria-hidden': 'true' }),
          toggleAll,
          g.type === 'plugin' && g.items.length ? pluginControls() : null,
          h('button', { class: 'btn ghost sm', type: 'button', onclick: () => navigate(`modrinth/${state.filters.instanceId || '-'}/${g.type}`) }, T('seeMore'), icon('chevronRight')),
        ),
        g.note ? h('div', { class: 'ss-group-note' }, icon('info'), h('span', {}, noteText(g))) : null,
        g.items.length ? h('div', { class: 'ss-grid' }, g.items.map(card)) : null,
      );
    }

    function drawResults(keepScroll) {
      const res = state.result;
      if (!res) return drawIdle();
      const scroll = root.scrollTop;
      cardRefs.clear();
      drawReasonsLine();
      keepFocus(resultsBox, () => mount(resultsBox, understoodCard(res), warningsBox(res), res.groups.map(groupSection)));
      drawDock();
      if (keepScroll) root.scrollTop = scroll;
    }

    // ---------- Barra del kit ----------
    function installBlock() {
      const items = kitItems();
      const target = currentTarget();
      const plan = state.result?.plan;
      if (!items.length) return T('nothingSelected');
      if (!target) return T('noTarget');
      if (plan?.mcVersion && target.mcVersion !== plan.mcVersion) return T('disabledVersion', { name: target.name, instVersion: target.mcVersion, version: plan.mcVersion });
      if (items.some((i) => i.type === 'mod') && !hasModLoader(target)) return T('disabledLoader', { name: target.name });
      return null;
    }

    function drawDock() {
      if (!state.result) {
        show(dock, false);
        return;
      }
      const items = kitItems();
      const target = currentTarget();
      const block = installBlock();
      const canCreate = items.length > 0 && Boolean(state.result.plan.mcVersion);
      show(dock, state.result.groups.some((g) => g.items.length && !NOT_KIT.has(g.type)));
      const installLabel = target ? T('installAllIn', { name: target.name }) : T('installAll');
      mount(
        dock,
        h(
          'div',
          { class: 'ss-dock-info', 'aria-live': 'polite' },
          h('div', { class: 'ss-dock-count' }, h('span', { class: 'ss-dock-ico', 'aria-hidden': 'true' }, icon('package')), h('span', { class: 'num' }, T('selectedCount', { count: items.length }))),
          block ? h('div', { class: 'ss-dock-why', title: block }, block) : null,
        ),
        h(
          'div',
          { class: 'ss-dock-actions' },
          h('button', { class: 'btn', type: 'button', disabled: !canCreate, onclick: () => createWithKit() }, icon('plus'), T('createWithKit')),
          h('button', { class: 'btn primary ss-dock-go', type: 'button', disabled: Boolean(block), title: block || installLabel, onclick: () => installAll() }, icon('download'), h('span', { class: 'ellipsis' }, installLabel)),
        ),
      );
    }

    // La barra del kit aparece cuando los resultados estan a la vista (no tapa el pedido ni los filtros).
    const dockObserver = new IntersectionObserver(([entry]) => dock.classList.toggle('ss-dock-away', !entry.isIntersecting), { root, rootMargin: '0px 0px -38% 0px' });
    dockObserver.observe(resultsBox);

    // El panel de tareas (abajo a la derecha) no tiene que tapar los botones del kit.
    const tasksDock = document.getElementById('tasks');
    const syncTasks = () => dock.classList.toggle('tasks-open', Boolean(tasksDock?.children.length));
    const tasksObserver = tasksDock ? new MutationObserver(syncTasks) : null;
    tasksObserver?.observe(tasksDock, { childList: true });
    syncTasks();

    // ---------- Instalacion ----------
    async function compatCheck(target, items) {
      try {
        await loadNs('compat');
        const mod = await import('../features/compat.js');
        if (typeof mod.checkBeforeInstall !== 'function') return true;
        return (await mod.checkBeforeInstall({ target, items: items.map((i) => ({ projectId: i.id, versionId: i.version?.id || undefined })) })) !== false;
      } catch (err) {
        console.warn('[smartsearch] compat:', err);
        return true;
      }
    }

    async function installOne(it) {
      const project = {
        id: it.id,
        project_id: it.id,
        slug: it.slug,
        title: it.title,
        description: it.description,
        icon_url: it.icon,
        project_type: it.type,
        author: it.author,
        downloads: it.downloads,
        follows: it.follows,
        categories: it.categories,
        game_versions: it.gameVersions,
        latest_version: it.latestVersion,
      };
      try {
        await loadNs('install');
        const mod = await import('../features/install.js');
        await mod.openInstallDialog(project, {
          type: it.type,
          instanceId: it.type === 'plugin' ? undefined : state.filters.instanceId || undefined,
          serverId: it.type === 'plugin' ? session.pluginServer || undefined : undefined,
        });
      } catch (err) {
        console.error('[smartsearch] install:', err);
        fail(T('installUnavailable'), err);
      }
    }

    async function installModpack(it) {
      if (!(await confirmDialog(T('modpackTitle', { name: it.title }), T('modpackText', { name: it.title }), { okText: T('installAsInstance') }))) return;
      const versionId = it.version?.id || it.latestVersion;
      toast('info', T('modpackInstalling', { name: it.title }));
      try {
        const inst = await api.modrinth.installModpack({ versionId });
        await store.refreshInstances();
        ok(T('modpackDone'), inst?.name || it.title);
      } catch (err) {
        fail(T('modpackFailed'), err);
      }
    }

    // Ventana de progreso de una instalacion del kit.
    async function runJob(target, items, { world = null, prepare = false } = {}) {
      const jobId = newId();
      const bar = h('i', { style: { width: '0%' } });
      const summary = h('div', { class: 'small muted', 'aria-live': 'polite' }, T('installBackground'));
      const rows = items.map((it) => {
        const stateEl = h('span', { class: 'ss-job-state' }, T('state_pending'));
        const extra = h('div', { class: 'ss-job-extra' });
        const row = h('div', { class: 'ss-job-row pending' }, h('img', { src: it.icon || 'assets/logo-64.png', alt: '' }), h('div', { class: 'ss-job-main' }, h('div', { class: 'ss-job-title', title: it.title }, it.title), extra), stateEl);
        return { row, stateEl, extra };
      });
      const openBtn = h('button', { class: 'btn ss-hidden', type: 'button', onclick: () => (m.close(), navigate(`${target.kind === 'server' ? 'server' : 'instance'}/${target.id}`)) }, icon('arrowRight'), T('openInstance'));
      const m = modal({
        title: T('installing', { name: target.name }),
        size: 'wide',
        body: h('div', { class: 'stack' }, h('div', { class: 'progress' }, bar), h('div', { class: 'ss-job-list' }, rows.map((r) => r.row)), summary),
        footer: [openBtn, h('button', { class: 'btn primary', type: 'button', onclick: () => m.close() }, T('close'))],
      });
      let finished = 0;
      const off = api.on('smartsearch:installProgress', (p) => {
        if (p.jobId !== jobId || !rows[p.index]) return;
        const r = rows[p.index];
        r.row.className = `ss-job-row ${p.state}`;
        mount(r.stateEl, p.state === 'installing' ? h('span', { class: 'spinner' }) : icon(p.state === 'done' ? 'check' : p.state === 'error' ? 'alert' : 'x'), T(`state_${p.state}`));
        if (p.state === 'error') mount(r.extra, h('div', { class: 'ss-job-err' }, p.error));
        if (p.state === 'done') {
          const extraTitles = (p.installed || []).filter((x) => x !== items[p.index].title);
          if (extraTitles.length) mount(r.extra, h('div', { class: 'ss-job-also' }, T('alsoInstalled', { list: extraTitles.join(', ') })));
        }
        if (['done', 'error', 'skipped'].includes(p.state)) finished++;
        bar.style.width = `${Math.round((finished / items.length) * 100)}%`;
      });
      try {
        const res = await api.invoke('smartsearch:installKit', {
          target: { kind: target.kind, id: target.id },
          items: items.map((i) => ({ projectId: i.id, versionId: i.version?.id || null, type: i.type, title: i.title })),
          world,
          prepare,
          jobId,
        });
        bar.style.width = '100%';
        mount(summary, icon(res.ok === res.total ? 'check' : 'alert'), h('div', {}, T('installDone', { ok: res.ok, total: res.total })));
        summary.className = res.ok === res.total ? 'notice good' : 'notice';
        if (res.ok === res.total) ok(T('kitInstalled'), target.name);
        else toast('info', T('kitPartial'), T('installDone', { ok: res.ok, total: res.total }));
        if (target.kind === 'instance') {
          for (const r of res.results || []) {
            if (r.state !== 'done') continue;
            const item = items.find((i) => i.id === r.projectId);
            if (item && state.result?.plan.mcVersion === store.instances.find((x) => x.id === target.id)?.mcVersion) item.installed = true;
            session.selection.set(r.projectId, false);
          }
        }
      } catch (err) {
        if (/cancel/i.test(err.message)) mount(summary, T('installCanceled'));
        else {
          mount(summary, icon('alert'), h('div', {}, h('strong', {}, T('installFailed')), h('div', { class: 'ss-error-text' }, err.message)));
          summary.className = 'notice bad';
          fail(T('installFailed'), err);
        }
      } finally {
        off();
        show(openBtn, true);
        await store.refreshInstances().catch(() => {});
        if (!disposed && state.result) drawResults(true);
      }
    }

    async function installAll() {
      const target = currentTarget();
      const items = kitItems();
      if (!target || !items.length || installBlock()) return;
      const hasDatapacks = items.some((i) => i.type === 'datapack');
      let worlds = [];
      if (hasDatapacks) worlds = await api.instances.content(target.id, 'saves').catch(() => []);
      const worldSel = worlds.length ? selectEl(worlds.map((w) => ({ value: w.name, label: w.name })), worlds[0].name) : null;
      const list = worldSel ? items : items.filter((i) => i.type !== 'datapack');
      const counts = {};
      for (const it of list) counts[it.type] = (counts[it.type] || 0) + 1;
      const choice = await new Promise((resolve) => {
        const m = modal({
          title: T('installTitle', { name: target.name }),
          body: h(
            'div',
            { class: 'stack' },
            h('p', { class: 'text-2', style: { margin: 0 } }, T('installIntro', { count: list.length })),
            h('div', { class: 'ss-install-sum' }, Object.entries(counts).map(([tp, n]) => h('span', { class: 'ss-chip type' }, icon(TYPE_ICON[tp]), `${T(`type_${tp}`)} · ${n}`))),
            hasDatapacks ? (worldSel ? h('label', { class: 'field' }, h('span', { class: 'label' }, T('worldLabel')), worldSel) : h('div', { class: 'notice' }, icon('info'), T('noWorlds'))) : null,
          ),
          footer: [
            h('button', { class: 'btn ghost', onclick: () => m.close() }, T('cancel')),
            h(
              'button',
              {
                class: 'btn primary',
                disabled: !list.length,
                onclick: () => {
                  resolve({ world: worldSel?.value || null });
                  m.close();
                },
              },
              icon('download'),
              T('installConfirm'),
            ),
          ],
          onClose: () => resolve(null),
        });
      });
      if (!choice || !list.length) return;
      if (!(await compatCheck({ kind: 'instance', id: target.id }, list))) return;
      await runJob({ kind: 'instance', id: target.id, name: target.name }, list, { world: choice.world });
    }

    async function installPlugins(server) {
      const items = pluginItems();
      if (!server || !items.length) return;
      if (!(await compatCheck({ kind: 'server', id: server.id }, items))) return;
      await runJob({ kind: 'server', id: server.id, name: server.name }, items);
    }

    function suggestedName(res) {
      const th = res.plan.themes?.find((x) => !x.minor && hasT(`theme_${x.id}`));
      if (th) return T('kitName', { name: T(`theme_${th.id}`) });
      const q = (session.query || '').trim();
      return q.length > 40 ? `${q.slice(0, 40).trim()}…` : q || T('title');
    }

    async function createWithKit() {
      const res = state.result;
      if (!res) return;
      const rec = res.recommended || {};
      const items = kitItems();
      if (!items.length || !rec.mcVersion) return;
      const nameInput = h('input', { class: 'input', value: suggestedName(res), maxlength: 60 });
      const versions = releases().includes(rec.mcVersion) ? releases() : [rec.mcVersion, ...releases()];
      const versionSel = selectEl(versions.map((v) => ({ value: v, label: v })), rec.mcVersion);
      const loaderSel = selectEl(CREATE_LOADERS.map((l) => ({ value: l, label: loaderName(l) })), rec.loader || 'fabric');
      const changed = h('div', { class: 'notice' }, icon('info'), T('createChanged'));
      const irisNote = h('div', { class: 'notice info' }, icon('sun'), T('createIris'));
      const hasShaders = items.some((i) => i.type === 'shader');
      const sync = () => {
        show(changed, versionSel.value !== rec.mcVersion || loaderSel.value !== rec.loader);
        show(irisNote, hasShaders && loaderSel.value === 'fabric');
      };
      versionSel.addEventListener('change', sync);
      loaderSel.addEventListener('change', sync);
      sync();
      const loaderLabel = loaderName(rec.loader || 'vanilla');
      const choice = await new Promise((resolve) => {
        const m = modal({
          title: T('createTitle'),
          body: h(
            'div',
            { class: 'stack' },
            h('div', { class: 'notice info' }, icon('sparkles'), T('createNote', { loader: loaderLabel, version: rec.mcVersion })),
            h('label', { class: 'field' }, h('span', { class: 'label' }, T('createName')), nameInput),
            h('div', { class: 'form-grid' }, h('label', { class: 'field' }, h('span', { class: 'label' }, T('createVersion')), versionSel), h('label', { class: 'field' }, h('span', { class: 'label' }, T('createLoader')), loaderSel)),
            changed,
            irisNote,
            items.some((i) => i.type === 'datapack') ? h('div', { class: 'notice' }, icon('info'), T('createDatapacks')) : null,
          ),
          footer: [
            h('button', { class: 'btn ghost', onclick: () => m.close() }, T('cancel')),
            h(
              'button',
              {
                class: 'btn primary',
                onclick: () => {
                  resolve({ name: nameInput.value.trim(), mcVersion: versionSel.value, loader: loaderSel.value });
                  m.close();
                },
              },
              icon('plus'),
              T('createConfirm'),
            ),
          ],
          onClose: () => resolve(null),
        });
        setTimeout(() => nameInput.focus(), 30);
      });
      if (!choice) return;
      const same = choice.mcVersion === rec.mcVersion && choice.loader === rec.loader;
      const canMods = MOD_LOADERS.includes(choice.loader);
      const list = items
        .filter((i) => i.type !== 'datapack')
        .filter((i) => i.type !== 'mod' || canMods)
        .filter((i) => !(i.helper && !canMods))
        .map((i) => (same ? i : { ...i, version: null }));
      let inst;
      try {
        inst = await api.invoke('smartsearch:createInstance', {
          name: choice.name,
          mcVersion: choice.mcVersion,
          loader: choice.loader,
          preset: hasShaders && choice.loader === 'fabric' ? 'iris' : null,
        });
        await store.refreshInstances();
        state.filters.instanceId = inst.id;
        drawFilters();
        ok(T('created'), inst.name);
      } catch (err) {
        fail(T('createFailed'), err);
        return;
      }
      if (!list.length) return;
      if (!(await compatCheck({ kind: 'instance', id: inst.id }, list))) return;
      await runJob({ kind: 'instance', id: inst.id, name: inst.name }, list, { prepare: true });
    }

    // ---------- Eventos ----------
    offs.push(
      api.on('smartsearch:progress', (p) => {
        if (state.running && p.runId === state.running.runId) updateProgress(p);
      }),
    );
    offs.push(
      api.on('smartsearch:reasons', (r) => {
        const res = session.result;
        if (!res || r.runId !== res.runId) return;
        session.reasonsState = r.error ? 'failed' : 'done';
        for (const g of res.groups) {
          for (const it of g.items) {
            const x = r.items?.[it.id];
            if (!x) continue;
            it.reason = x.reason;
            it.fit = x.fit;
          }
        }
        if (disposed || state.result !== res) return;
        drawReasonsLine();
        for (const [id, ref] of cardRefs) {
          if (!r.items?.[id]) continue;
          mount(ref.reason, reasonContent(ref.it));
          show(ref.reason, true);
          ref.reason.classList.add('ai');
          const row = ref.el.querySelector('.ss-card-title-row');
          if (ref.it.fit === 'great' && row && !row.querySelector('.ss-fit')) row.append(h('span', { class: 'ss-fit', title: T('fit_great') }, icon('star')));
        }
      }),
    );
    offs.push(
      store.on('instances', () => {
        if (disposed) return;
        drawFilters();
        drawDock();
      }),
    );

    // ---------- Armado inicial ----------
    // .ss-page es contenedor de consultas: el diseño se adapta al ancho real del contenido (no al de la ventana)
    mount(root, h('div', { class: 'ss-page' }, head, hero, filtersBox, resultsBox, dock));
    // mientras llega el contexto (versiones, preferencias, historial) los filtros muestran su forma
    mount(
      filtersBox,
      h(
        'div',
        { class: 'ss-filter-grid', 'aria-hidden': 'true' },
        [0, 1, 2, 3].map(() => h('div', { class: 'ss-field' }, h('span', { class: 'skeleton skeleton-line ss-sk-label' }), h('span', { class: 'skeleton ss-sk-field' }))),
      ),
    );
    autoGrow();
    try {
      state.ctx = { ...state.ctx, ...(await api.invoke('smartsearch:context')) };
    } catch (err) {
      console.warn('[smartsearch] contexto:', err);
    }
    if (disposed) return () => {};
    if (!state.filters) {
      const p = state.ctx.prefs || {};
      state.filters = {
        instanceId: store.selectedInstance()?.id || '',
        mcVersion: 'auto',
        loader: 'auto',
        types: [],
        perType: nearestPerType(p.perType),
        compatibleOnly: p.compatibleOnly !== false,
        useAi: p.useAi !== false,
        ...emptyMore(),
      };
      session.filters = state.filters;
    }
    drawAiPill();
    drawFilters();
    api.servers
      .list()
      .then((list) => {
        state.servers = list || [];
        if (!disposed && state.result?.groups.some((g) => g.type === 'plugin' && g.items.length)) drawResults(true);
      })
      .catch(() => {});

    const preQuery = params?.[0] ? String(params[0]).trim() : '';
    if (preQuery) {
      input.value = preQuery;
      session.query = preQuery;
      autoGrow();
      runSearch(preQuery);
    } else if (session.pending) {
      follow(session.pending);
    } else if (state.result) {
      drawResults();
      root.scrollTop = session.scroll || 0;
    } else {
      drawIdle();
    }
    if (input.value.trim()) previewSoon();
    else setTimeout(() => !disposed && input.focus(), 50);

    return () => {
      disposed = true;
      session.scroll = root.scrollTop;
      tasksObserver?.disconnect();
      dockObserver.disconnect();
      for (const off of offs) {
        try {
          off();
        } catch {
          /* ignorar */
        }
      }
    };
  },
};
