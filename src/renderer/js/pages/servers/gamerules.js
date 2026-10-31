// Gamerules: en vivo con comandos si el servidor esta encendido; apagado se escriben en el mundo
// (level.dat o game_rules.dat) o quedan pendientes para aplicarse al iniciar.
import { h, icon, mount, fail, switchEl, debounce } from '../../ui.js';
import { api } from '../../store.js';
import { t, has } from '../../i18n.js';
import { tabSkeleton } from './common.js';

const GROUP_ICONS = { player: 'user', world: 'globe', spawning: 'sparkles', mobs: 'skull', drops: 'package', chat: 'message', misc: 'wrench' };
const tr = (key, fallback) => (has(key) ? t(key) : fallback);

export function gamerulesTab(container, ctx) {
  const srv = ctx.srv;
  let state = null;
  let query = '';
  let group = 'all';
  let onlyChanged = false;
  const notice = h('div');
  const list = h('div', { class: 'stack' });

  async function apply(patch, extra) {
    try {
      state = await api.invoke('servers:setGamerules', srv.id, patch || {}, extra || {});
      drawNotice();
      drawList();
    } catch (err) {
      fail(t('server.errRules'), err);
      await load();
    }
  }

  const labelOf = (r) => tr(`server.gr_${r.key}`, r.name || r.key);
  const descOf = (r) => tr(`server.gr_${r.key}_desc`, '');

  // errEl recibe el aviso de valor fuera de rango (debajo del control)
  function control(r, errEl) {
    const disabled = state.mode === 'busy';
    if (r.type === 'bool') {
      const sw = switchEl(Boolean(r.value), (v) => apply({ [r.key]: v }), labelOf(r));
      if (disabled) sw.querySelector('input').disabled = true;
      return sw;
    }
    const errId = `sv-gr-err-${String(r.key).replace(/[^\w-]/g, '_')}`;
    errEl.id = errId;
    const rangeText = r.min !== undefined && r.max !== undefined ? t('server.propRange', { min: r.min, max: r.max }) : t('server.propInteger');
    const input = h('input', { class: 'input sv-prop-num', type: 'number', value: r.value, min: r.min, max: r.max, step: 1, disabled, 'aria-label': labelOf(r), 'aria-describedby': errId });
    const commit = debounce(() => {
      const bad = !/^-?\d+$/.test(input.value) || (r.min !== undefined && Number(input.value) < r.min) || (r.max !== undefined && Number(input.value) > r.max);
      input.setAttribute('aria-invalid', bad ? 'true' : 'false');
      mount(errEl, bad ? [icon('alert'), h('span', {}, rangeText)] : null);
      if (!bad && Number(input.value) !== Number(r.value)) apply({ [r.key]: Number(input.value) });
    }, 700);
    input.addEventListener('input', commit);
    return input;
  }

  function row(r) {
    const changed = String(r.value) !== String(r.default);
    const errEl = h('div', { class: 'field-error', role: 'alert' });
    return h(
      'div',
      { class: ['sv-prop', changed && 'changed'] },
      h(
        'div',
        { class: 'sv-prop-text' },
        h(
          'div',
          { class: 'sv-prop-label' },
          labelOf(r),
          r.pending ? h('span', { class: 'badge warn', title: t('server.rulePendingHint') }, icon('clock'), t('server.rulePending')) : null,
          r.experimental ? h('span', { class: 'badge' }, t('server.experimental')) : null,
        ),
        h(
          'div',
          { class: 'sv-prop-key' },
          r.name || r.key,
          changed ? h('span', { class: 'sv-prop-def' }, t('server.defaultValue', { value: r.type === 'bool' ? (r.default ? t('common.yes') : t('common.no')) : String(r.default) })) : null,
        ),
        descOf(r) ? h('div', { class: 'sv-prop-desc' }, descOf(r)) : null,
      ),
      h(
        'div',
        { class: 'sv-prop-control row' },
        changed ? h('button', { class: 'icon-btn sm', title: t('server.resetDefault'), 'aria-label': `${t('server.resetDefault')}: ${labelOf(r)}`, disabled: state.mode === 'busy', onclick: () => apply({ [r.key]: r.default }) }, icon('undo')) : null,
        control(r, errEl),
      ),
      errEl,
    );
  }

  function drawNotice() {
    if (!state) return;
    const modeText = {
      live: ['zap', 'good', t('server.rulesLive')],
      file: ['save', 'info', t('server.rulesFile', { file: state.file || 'level.dat' })],
      pending: ['clock', '', state.worldExists ? t('server.rulesPendingFormat') : t('server.rulesPendingNoWorld')],
      busy: ['clock', '', t('server.rulesBusy')],
    }[state.mode];
    mount(
      notice,
      h(
        'div',
        { class: ['notice', modeText[1]] },
        icon(modeText[0]),
        h('div', { class: 'spacer' }, modeText[2], state.pendingCount ? h('div', { class: 'tiny sv-notice-sub' }, t('server.rulesPendingCount', { count: state.pendingCount })) : null),
      ),
    );
  }

  function drawList() {
    if (!state) return;
    const q = query;
    const rules = state.rules.filter((r) => r.available || r.inFile);
    const filtered = rules.filter((r) => (group === 'all' || r.group === group) && (!onlyChanged || String(r.value) !== String(r.default)) && (!q || `${r.key} ${r.name} ${labelOf(r)} ${descOf(r)}`.toLowerCase().includes(q)));
    const cards = [];
    for (const g of state.groups) {
      const entries = filtered.filter((r) => r.group === g);
      if (!entries.length) continue;
      cards.push(h('div', { class: 'card sv-group' }, h('h2', { class: 'card-title' }, icon(GROUP_ICONS[g] || 'sliders'), t(`server.grGroup_${g}`), h('span', { class: 'badge' }, String(entries.length))), h('div', { class: 'sv-group-rows' }, entries.map(row))));
    }
    const extra = (state.extra || []).filter((e) => !q || e.name.toLowerCase().includes(q));
    if (extra.length && (group === 'all' || group === 'misc')) {
      cards.push(
        h(
          'div',
          { class: 'card sv-group' },
          h('h2', { class: 'card-title' }, icon('puzzle'), t('server.rulesExtra')),
          h('div', { class: 'card-sub' }, t('server.rulesExtraHint')),
          h(
            'div',
            { class: 'sv-group-rows' },
            extra.map((e) => {
              const input = h('input', { class: 'input sv-prop-num', value: e.value, disabled: state.mode === 'busy' || state.mode === 'pending', 'aria-label': e.name });
              input.addEventListener(
                'input',
                debounce(() => input.value.trim() && input.value.trim() !== e.value && apply({}, { [e.name]: input.value.trim() }), 800),
              );
              return h('div', { class: 'sv-prop' }, h('div', { class: 'sv-prop-text' }, h('div', { class: 'sv-prop-label mono' }, e.name)), h('div', { class: 'sv-prop-control' }, input));
            }),
          ),
        ),
      );
    }
    mount(list, cards.length ? cards : h('div', { class: 'card' }, h('div', { class: 'sv-mini-empty' }, icon('search'), h('span', {}, t('server.noRulesMatch')))));
  }

  function drawToolbar() {
    const search = h('input', { class: 'input', type: 'search', placeholder: t('server.rulesSearch'), 'aria-label': t('server.rulesSearch') });
    search.addEventListener(
      'input',
      debounce(() => {
        query = search.value.trim().toLowerCase();
        drawList();
      }, 150),
    );
    const chips = h('div', { class: 'chips sv-group-chips', role: 'group', 'aria-label': t('server.groupsLabel') });
    const drawChips = () =>
      mount(
        chips,
        ['all', ...state.groups].map((g) =>
          h('button', { class: ['chip', g === group && 'active'], 'aria-pressed': g === group ? 'true' : 'false', onclick: () => ((group = g), drawChips(), drawList(), chips.querySelector('.chip.active')?.focus()) }, icon(GROUP_ICONS[g] || 'grid'), g === 'all' ? t('server.group_all') : t(`server.grGroup_${g}`)),
        ),
      );
    drawChips();
    return h(
      'div',
      { class: 'sv-props-bar' },
      h('div', { class: 'input-icon sv-props-search' }, icon('search'), search),
      h('div', { class: 'row sv-adv-toggle' }, h('span', { class: 'small text-2' }, t('server.onlyChanged')), switchEl(onlyChanged, (v) => ((onlyChanged = v), drawList()), t('server.onlyChanged'))),
      chips,
    );
  }

  async function load() {
    try {
      state = await api.invoke('servers:gamerules', srv.id);
      if (state.proxy) {
        mount(container, h('div', { class: 'notice info' }, icon('info'), t('server.proxyNoRules')));
        return;
      }
      mount(container, h('div', { class: 'stack' }, notice, drawToolbar(), list));
      drawNotice();
      drawList();
    } catch (err) {
      mount(container, h('div', { class: 'notice bad sv-error' }, icon('alert'), h('div', {}, h('strong', {}, t('server.loadError')), h('div', {}, err.message)), h('button', { class: 'btn sm', onclick: () => (mount(container, tabSkeleton({ cards: 2, rows: 4 })), load()) }, icon('refresh'), t('common.retry'))));
    }
  }

  mount(container, tabSkeleton({ cards: 2, rows: 4 }));
  load();
  let lastState = ctx.state();
  const offState = ctx.on('state', () => {
    // Solo recarga cuando cambia el modo (encendido/apagado), no con cada jugador que entra.
    const now = ctx.state();
    if ((now === 'online') !== (lastState === 'online') || (now === 'offline') !== (lastState === 'offline')) load();
    lastState = now;
  });
  return () => offState();
}
