// Editor de server.properties: controles con tipo, descripciones, busqueda, grupos, avanzadas,
// propiedades desconocidas y editor de MOTD con vista previa de los codigos de color (§).
import { h, icon, mount, fail, ok, switchEl, selectEl, debounce, setBusy } from '../../ui.js';
import { api } from '../../store.js';
import { t, has } from '../../i18n.js';
import { MC_COLORS, MC_FORMATS, motdNodes, animateObfuscated, tryInvoke, serverTile, tabSkeleton } from './common.js';

const propsSkeleton = () => tabSkeleton({ cards: 2, rows: 4 });

const COLOR_NAMES = ['black', 'dark_blue', 'dark_green', 'dark_aqua', 'dark_red', 'dark_purple', 'gold', 'gray', 'dark_gray', 'blue', 'green', 'aqua', 'red', 'light_purple', 'yellow', 'white'];
const FORMAT_BUTTONS = [
  ['l', 'svBold', 'fmtBold'],
  ['o', 'svItalic', 'fmtItalic'],
  ['n', 'svUnderline', 'fmtUnderline'],
  ['m', 'svStrike', 'fmtStrike'],
  ['k', 'svShuffle', 'fmtObfuscated'],
  ['r', 'undo', 'fmtReset'],
];
const LEVEL_LABELS = {
  'minecraft:normal': 'normal',
  'minecraft:flat': 'flat',
  'minecraft:large_biomes': 'large_biomes',
  'minecraft:amplified': 'amplified',
  'minecraft:single_biome_surface': 'single_biome_surface',
  default: 'normal',
  flat: 'flat',
  largeBiomes: 'large_biomes',
  amplified: 'amplified',
};

const tr = (key, fallback) => (has(key) ? t(key) : fallback);

function optionLabel(key, value) {
  if (key === 'gamemode') return tr(`server.gamemode_${value}`, value);
  if (key === 'difficulty') return tr(`server.difficulty_${value}`, value);
  if (key === 'level-type') return LEVEL_LABELS[value] ? t(`servers.levelType_${LEVEL_LABELS[value]}`) : value;
  return value;
}

// ---------- Editor de MOTD ----------
export function motdEditor({ value, name, players, iconData, onChange }) {
  const area = h('textarea', { class: 'textarea sv-motd-input', rows: 2, spellcheck: 'false', 'aria-label': t('server.motdLabel') });
  area.value = value || '';
  const preview = h('div', { class: 'sv-motd-text' });
  const counter = h('span', { class: 'sv-count-text', 'aria-live': 'polite' });
  const render = () => {
    mount(preview, motdNodes(area.value));
    const lines = area.value.split('\n');
    const visible = lines.map((l) => l.replace(/§[0-9a-fk-or]/gi, '').length);
    counter.textContent = t('server.motdCountLines', { a: visible[0] || 0, b: visible[1] || 0 });
    counter.classList.toggle('sv-warn-text', lines.length > 2 || visible.some((n) => n > 45));
  };
  const insert = (code) => {
    const start = area.selectionStart ?? area.value.length;
    const end = area.selectionEnd ?? area.value.length;
    const sel = area.value.slice(start, end);
    // Con texto seleccionado se aplica el formato solo a ese tramo (y se resetea al final).
    const text = sel ? `§${code}${sel}§r` : `§${code}`;
    area.setRangeText(text, start, end, 'end');
    area.focus();
    render();
    onChange(area.value);
  };
  area.addEventListener('input', () => {
    if (area.value.split('\n').length > 2) area.value = area.value.split('\n').slice(0, 2).join('\n');
    render();
    onChange(area.value);
  });
  render();
  const box = h(
    'div',
    { class: 'sv-motd' },
    h(
      'div',
      { class: 'sv-motd-tools', role: 'toolbar', 'aria-label': t('server.motdTools') },
      h(
        'div',
        { class: 'sv-swatches' },
        Object.entries(MC_COLORS).map(([code, color], i) =>
          h('button', { class: 'sv-swatch', style: { background: color }, title: `${t(`server.color_${COLOR_NAMES[i]}`)} (§${code})`, 'aria-label': t(`server.color_${COLOR_NAMES[i]}`), onclick: () => insert(code) }),
        ),
      ),
      h(
        'div',
        { class: 'sv-fmt' },
        FORMAT_BUTTONS.map(([code, ic, k]) => h('button', { class: 'icon-btn sm', title: `${t(`server.${k}`)} (§${code})`, 'aria-label': t(`server.${k}`), onclick: () => insert(code) }, icon(ic))),
        h('button', { class: 'btn sm ghost', title: t('server.motdSectionHint'), 'aria-label': t('server.motdSectionHint'), onclick: () => insert('') }, '§'),
      ),
    ),
    area,
    h('div', { class: 'sv-motd-meta' }, h('span', { class: 'spacer' }, t('server.motdHint')), counter),
    h(
      'div',
      { class: 'sv-motd-preview', role: 'group', 'aria-label': t('server.motdPreview') },
      h('div', { class: 'sv-motd-icon' }, iconData ? h('img', { src: iconData, alt: '' }) : serverTile({ type: 'vanilla' }, null, 48)),
      h('div', { class: 'sv-motd-body' }, h('div', { class: 'sv-motd-name' }, h('span', {}, name), h('span', { class: 'sv-motd-players' }, players, h('span', { class: 'sv-ping', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'), h('i')))), preview),
    ),
  );
  animateObfuscated(preview);
  return { el: box, set: (v) => ((area.value = v), render()) };
}

export function propertiesTab(container, ctx) {
  const srv = ctx.srv;
  let state = null;
  let draft = {};
  let query = '';
  let group = 'all';
  let showAdvanced = false;
  let iconData = null;
  const content = h('div', { class: 'stack' });
  const bar = h('div', { class: 'sv-savebar hidden', role: 'region', 'aria-label': t('server.unsaved') });

  const current = (key) => (key in draft ? draft[key] : state.values[key]);
  const dirtyCount = () => Object.keys(draft).filter((k) => draft[k] !== state.values[k]).length;
  const setDraft = (key, value) => {
    if (value === state.values[key] || (value === null && state.values[key] === undefined)) delete draft[key];
    else draft[key] = value;
    drawBar();
  };

  function drawBar() {
    const n = state ? dirtyCount() : 0;
    bar.classList.toggle('hidden', !n);
    mount(
      bar,
      icon('edit'),
      h('span', { class: 'spacer', role: 'status' }, t('server.unsavedCount', { count: n })),
      h('button', { class: 'btn ghost', onclick: () => ((draft = {}), draw()) }, t('server.discard')),
      h('button', { class: 'btn primary', onclick: (e) => save(e.currentTarget) }, icon('save'), t('common.save')),
    );
  }

  async function save(btn) {
    const patch = {};
    for (const [k, v] of Object.entries(draft)) if (v !== state.values[k]) patch[k] = v;
    if (!Object.keys(patch).length) return;
    const release = btn ? setBusy(btn) : null;
    try {
      await api.servers.setProperties(srv.id, patch);
      draft = {};
      ok(t('server.propsSaved'), ctx.state() !== 'offline' ? t('server.propsSavedRestart') : null);
      await load();
      ctx.refresh();
    } catch (err) {
      fail(t('server.errSave'), err);
    } finally {
      release?.();
    }
  }

  const labelOf = (e) => tr(`server.${e.labelKey}`, e.key);
  const descOf = (e) => tr(`server.${e.descKey}`, '');

  // Control de una propiedad. errEl recibe el aviso de valor invalido (debajo de la descripcion).
  function control(e, errEl) {
    const raw = current(e.key);
    const val = raw === undefined ? String(e.default) : raw;
    const errId = `sv-prop-err-${e.key.replace(/[^\w-]/g, '_')}`;
    const showErr = (input, text) => {
      input.setAttribute('aria-invalid', text ? 'true' : 'false');
      mount(errEl, text ? [icon('alert'), h('span', {}, text)] : null);
    };
    if (e.type === 'bool') return switchEl(val === 'true', (v) => setDraft(e.key, String(v)), labelOf(e));
    if (e.type === 'enum' || e.special === 'levelType') {
      const values = [...(e.values || [])];
      if (val && !values.includes(val)) values.push(val);
      const sel = selectEl(values.map((v) => ({ value: v, label: optionLabel(e.key, v) })), val, (v) => setDraft(e.key, v), 'select sv-prop-select');
      sel.setAttribute('aria-label', labelOf(e));
      return sel;
    }
    if (e.type === 'int') {
      const input = h('input', { class: 'input sv-prop-num', type: 'number', value: val, min: e.min, max: e.max, step: 1, 'aria-label': labelOf(e), 'aria-describedby': errId });
      errEl.id = errId;
      const rangeText = e.min !== undefined && e.max !== undefined ? t('server.propRange', { min: e.min, max: e.max }) : t('server.propInteger');
      input.addEventListener('input', () => {
        const bad = input.value === '' || !/^-?\d+$/.test(input.value) || (e.min !== undefined && Number(input.value) < e.min) || (e.max !== undefined && Number(input.value) > e.max);
        showErr(input, bad ? rangeText : null);
        if (!bad) setDraft(e.key, String(Number(input.value)));
      });
      return input;
    }
    const input = h('input', { class: 'input', type: e.secret ? 'password' : e.special === 'url' ? 'url' : 'text', value: raw ?? '', placeholder: e.default ? String(e.default) : '', spellcheck: 'false', 'aria-label': labelOf(e) });
    input.addEventListener('input', () => {
      if (e.special === 'sha1') {
        const bad = input.value && !/^[0-9a-fA-F]{40}$/.test(input.value.trim());
        errEl.id = errId;
        input.setAttribute('aria-describedby', errId);
        showErr(input, bad ? t('server.propSha1') : null);
      }
      setDraft(e.key, input.value);
    });
    if (!e.secret) return input;
    const eye = h('button', { class: 'icon-btn sm', title: t('server.showSecret'), 'aria-label': t('server.showSecret'), 'aria-pressed': 'false', onclick: () => {
      input.type = input.type === 'password' ? 'text' : 'password';
      eye.setAttribute('aria-pressed', String(input.type === 'text'));
      mount(eye, icon(input.type === 'password' ? 'eye' : 'eyeOff'));
    } }, icon('eye'));
    return h('div', { class: 'sv-secret' }, input, eye);
  }

  function row(e) {
    const val = current(e.key);
    const modified = e.key in draft && draft[e.key] !== state.values[e.key];
    const isDefault = val === undefined || String(val) === String(e.default);
    const wide = e.type === 'string';
    const errEl = h('div', { class: 'field-error', role: 'alert' });
    return h(
      'div',
      { class: ['sv-prop', wide && 'wide', modified && 'modified', !e.available && 'unavailable'], dataset: { key: e.key } },
      h(
        'div',
        { class: 'sv-prop-text' },
        h('div', { class: 'sv-prop-label' }, labelOf(e), modified ? h('span', { class: 'sv-dot', title: t('server.modified'), role: 'img', 'aria-label': t('server.modified') }) : null, !e.available ? h('span', { class: 'badge warn' }, t('server.notInVersion')) : null, e.adv ? h('span', { class: 'badge' }, t('server.advanced')) : null),
        h('div', { class: 'sv-prop-key' }, e.key, !isDefault ? h('span', { class: 'sv-prop-def' }, t('server.defaultValue', { value: String(e.default) === '' ? t('server.emptyValue') : optionLabel(e.key, String(e.default)) })) : null),
        descOf(e) ? h('div', { class: 'sv-prop-desc' }, descOf(e)) : null,
      ),
      h('div', { class: 'sv-prop-control' }, control(e, errEl)),
      errEl,
    );
  }

  function matchesQuery(e) {
    if (!query) return true;
    return `${e.key} ${labelOf(e)} ${descOf(e)}`.toLowerCase().includes(query);
  }

  function visible(e) {
    if (e.special === 'motd') return false;
    if (!e.available && state.values[e.key] === undefined) return false;
    if (e.adv && !showAdvanced && !query) return false;
    if (group !== 'all' && e.group !== group) return false;
    return matchesQuery(e);
  }

  function onlineModeCard() {
    const e = state.schema.find((x) => x.key === 'online-mode');
    if (!e || (group !== 'all' && group !== 'security') || !matchesQuery(e)) return null;
    const on = (current('online-mode') ?? 'true') === 'true';
    return h(
      'div',
      { class: ['card', 'sv-online-card', on ? 'on' : 'off'] },
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'qa-icon' }, icon(on ? 'shieldCheck' : 'shieldAlert')),
        h('div', { class: 'spacer' }, h('h2', { class: 'card-title' }, labelOf(e), h('span', { class: 'sv-prop-key' }, 'online-mode')), h('div', { class: 'small text-2' }, on ? t('server.onlineModeOnText') : t('server.onlineModeOffText'))),
        switchEl(on, (v) => {
          setDraft('online-mode', String(v));
          if (!v && state.values['enforce-secure-profile'] !== 'false' && state.schema.find((x) => x.key === 'enforce-secure-profile')?.available) setDraft('enforce-secure-profile', 'false');
          draw();
        }, labelOf(e)),
      ),
      h('div', { class: 'sv-hint' }, t('server.onlineModeTip')),
    );
  }

  function motdCard() {
    const e = state.schema.find((x) => x.key === 'motd');
    if ((group !== 'all' && group !== 'general') || (query && !matchesQuery(e))) return null;
    const ed = motdEditor({
      value: current('motd') ?? e.default,
      name: srv.name,
      players: `0/${current('max-players') || 20}`,
      iconData,
      onChange: (v) => setDraft('motd', v),
    });
    return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('message'), labelOf(e)), h('span', { class: 'sv-prop-key' }, 'motd')), ed.el);
  }

  function unknownCard() {
    if ((group !== 'all' && group !== 'advanced') || (!state.unknown.length && query)) return null;
    const list = state.unknown.filter((u) => !query || `${u.key} ${u.value}`.toLowerCase().includes(query));
    const keyIn = h('input', { class: 'input mono', placeholder: t('server.newKey'), maxlength: 80, 'aria-label': t('server.newKey') });
    const valIn = h('input', { class: 'input', placeholder: t('server.newValue'), 'aria-label': t('server.newValue') });
    const add = () => {
      const k = keyIn.value.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(k)) {
        fail(t('server.errKey'));
        return;
      }
      state.unknown.push({ key: k, value: '' });
      setDraft(k, valIn.value);
      draw();
    };
    return h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('fileText'), t('server.otherProps'))),
      h('div', { class: 'card-sub' }, t('server.otherPropsHint')),
      list.length
        ? h(
            'div',
            { class: 'sv-group-rows' },
            list.map((u) => {
              const deleted = draft[u.key] === null;
              const input = h('input', { class: 'input', value: current(u.key) ?? '', disabled: deleted, spellcheck: 'false', 'aria-label': u.key });
              input.addEventListener('input', () => setDraft(u.key, input.value));
              return h(
                'div',
                { class: ['sv-prop', 'wide', deleted && 'deleted'] },
                h('div', { class: 'sv-prop-text' }, h('div', { class: 'sv-prop-label mono' }, u.key)),
                h('div', { class: 'sv-prop-control row' }, input, h('button', { class: 'icon-btn sm danger', title: deleted ? t('server.restoreKey') : t('server.deleteKey'), 'aria-label': deleted ? t('server.restoreKey') : t('server.deleteKey'), onclick: () => (deleted ? delete draft[u.key] : setDraft(u.key, null), draw()) }, icon(deleted ? 'undo' : 'trash'))),
              );
            }),
          )
        : h('div', { class: 'sv-mini-empty' }, icon('fileText'), h('span', {}, t('server.noOtherProps'))),
      h('div', { class: 'sv-add-row' }, keyIn, valIn, h('button', { class: 'btn', onclick: add }, icon('plus'), t('common.add'))),
    );
  }

  const toolbar = () => {
    const search = h('input', { class: 'input', type: 'search', value: query, placeholder: t('server.propsSearch'), 'aria-label': t('server.propsSearch') });
    search.addEventListener(
      'input',
      debounce(() => {
        query = search.value.trim().toLowerCase();
        drawGroups();
      }, 150),
    );
    return h(
      'div',
      { class: 'sv-props-bar' },
      h('div', { class: 'input-icon sv-props-search' }, icon('search'), search),
      h('div', { class: 'row sv-adv-toggle' }, h('span', { class: 'small text-2' }, t('server.showAdvanced')), switchEl(showAdvanced, (v) => ((showAdvanced = v), drawGroups()), t('server.showAdvanced'))),
      h(
        'div',
        { class: 'chips sv-group-chips', role: 'group', 'aria-label': t('server.groupsLabel') },
        ['all', ...state.groups].map((g) =>
          h('button', { class: ['chip', g === group && 'active'], 'aria-pressed': g === group ? 'true' : 'false', onclick: () => ((group = g), draw(), content.querySelector('.sv-group-chips .chip.active')?.focus()) }, icon(GROUP_ICONS[g] || 'sliders'), t(`server.group_${g}`)),
        ),
      ),
    );
  };

  const groupsBox = h('div', { class: 'stack' });
  function drawGroups() {
    const cards = [];
    const special = [motdCard(), onlineModeCard()].filter(Boolean);
    cards.push(...special);
    for (const g of state.groups) {
      if (group !== 'all' && group !== g) continue;
      const entries = state.schema.filter((e) => e.group === g && e.key !== 'online-mode' && visible(e));
      if (!entries.length) continue;
      cards.push(h('div', { class: 'card sv-group' }, h('h2', { class: 'card-title' }, icon(GROUP_ICONS[g] || 'sliders'), t(`server.group_${g}`)), h('div', { class: 'sv-group-rows' }, entries.map(row))));
    }
    const unknown = unknownCard();
    if (unknown) cards.push(unknown);
    if (!cards.length) cards.push(h('div', { class: 'card' }, h('div', { class: 'sv-mini-empty' }, icon('search'), h('span', {}, t('server.noPropsMatch')))));
    mount(groupsBox, cards);
  }

  const notesBox = h('div', { class: 'stack' });
  function drawNotes() {
    if (!state) return;
    const notes = [];
    if (!state.exists) notes.push(h('div', { class: 'notice info' }, icon('info'), t('server.propsNotYet')));
    if (ctx.state() !== 'offline') notes.push(h('div', { class: 'notice info' }, icon('info'), h('div', { class: 'spacer' }, t('server.propsRunning'))));
    mount(notesBox, notes);
    notesBox.classList.toggle('hidden', !notes.length);
  }

  function draw() {
    if (!state) return;
    mount(content, notesBox, toolbar(), groupsBox);
    drawNotes();
    drawGroups();
    drawBar();
  }

  async function load() {
    try {
      state = await api.invoke('servers:propertiesState', srv.id);
      iconData = await tryInvoke('servers:icon', [srv.id], null).catch(() => null);
      draw();
    } catch (err) {
      mount(content, h('div', { class: 'notice bad sv-error' }, icon('alert'), h('div', {}, h('strong', {}, t('server.loadError')), h('div', {}, err.message)), h('button', { class: 'btn sm', onclick: () => (mount(content, propsSkeleton()), load()) }, icon('refresh'), t('common.retry'))));
    }
  }

  mount(container, h('div', { class: 'sv-props' }, content, bar));
  mount(content, propsSkeleton());
  load();
  const offState = ctx.on('state', drawNotes);
  return () => offState();
}

const GROUP_ICONS = { all: 'grid', general: 'sliders', world: 'globe', players: 'users', security: 'shield', network: 'network', performance: 'gauge', advanced: 'wrench' };
