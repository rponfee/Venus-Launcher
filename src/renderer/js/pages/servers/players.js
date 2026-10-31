// Jugadores: conectados ahora (OP, modo de juego, expulsar, banear) y listas de operadores,
// lista blanca, baneos e IPs baneadas (comandos si esta encendido, JSON si esta apagado).
import { h, icon, mount, fail, ok, confirmDialog, selectEl, switchEl, avatarImg, skeleton, setBusy, fmtAgo } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';

const LISTS = [
  { id: 'ops', icon: 'crown', add: 'op', remove: 'deop' },
  { id: 'whitelist', icon: 'shieldCheck', add: 'whitelistAdd', remove: 'whitelistRemove' },
  { id: 'banned', icon: 'ban', add: 'ban', remove: 'pardon' },
  { id: 'bannedIps', icon: 'globe', add: 'banIp', remove: 'pardonIp' },
];

export function playersTab(container, ctx) {
  const srv = ctx.srv;
  let data = null;
  let listId = 'ops';
  let busy = false;
  const onlineBox = h('div');
  const listsBox = h('div');
  const head = h('div');

  async function act(action, target, extra = {}, msgKey, btn = null) {
    if (busy) return;
    busy = true;
    const release = btn ? setBusy(btn) : null;
    try {
      data = await api.invoke('servers:playerAction', srv.id, action, target, extra);
      if (msgKey) ok(t(`server.${msgKey}`, { name: target }));
      draw();
    } catch (err) {
      fail(t('server.errPlayerAction'), err);
    } finally {
      busy = false;
      release?.();
    }
  }

  const drawHead = () => {
    if (!data) return;
    mount(
      head,
      h(
        'div',
        { class: ['notice', data.onlineMode ? 'info' : ''] },
        icon(data.onlineMode ? 'shieldCheck' : 'shieldAlert'),
        h('div', {}, h('strong', {}, data.onlineMode ? t('server.onlineModeOn') : t('server.onlineModeOff')), ' ', data.onlineMode ? t('server.onlineModeOnText') : t('server.onlineModeOffText')),
      ),
    );
  };

  const drawOnline = () => {
    const live = data?.state === 'online';
    const players = data?.online || [];
    const rows = players.map((p) => {
      const sub = [p.ip ? `IP ${p.ip}` : null, p.since ? t('server.connectedSince', { when: fmtAgo(p.since) }) : null].filter(Boolean).join(' · ');
      const modeSel = selectEl(
        [{ value: '', label: t('server.gamemodeAction') }, ...['survival', 'creative', 'adventure', 'spectator'].map((m) => ({ value: m, label: t(`server.gamemode_${m}`) }))],
        '',
        (v) => v && act('gamemode', p.name, { mode: v }, 'toastGamemode'),
        'select sv-select-sm',
      );
      modeSel.setAttribute('aria-label', t('server.gamemodeOf', { name: p.name }));
      return h(
        'div',
        { class: 'sv-player', role: 'listitem' },
        avatarImg(p.name, 64, 'sv-avatar'),
        h('div', { class: 'sv-player-main' }, h('div', { class: 'sv-player-name ellipsis', title: p.name }, p.name), sub ? h('div', { class: 'sv-player-sub', title: p.uuid || '' }, sub) : null),
        modeSel,
        h('button', { class: 'icon-btn sm', title: t('server.makeOp'), 'aria-label': `${t('server.makeOp')}: ${p.name}`, onclick: (e) => act('op', p.name, {}, 'toastOp', e.currentTarget) }, icon('crown')),
        h('button', { class: 'icon-btn sm', title: t('server.kick'), 'aria-label': `${t('server.kick')}: ${p.name}`, onclick: (e) => act('kick', p.name, {}, 'toastKick', e.currentTarget) }, icon('logout')),
        h(
          'button',
          {
            class: 'icon-btn sm danger',
            title: t('server.ban'),
            'aria-label': `${t('server.ban')}: ${p.name}`,
            onclick: async () => {
              if (await confirmDialog(t('server.ban'), t('server.banConfirm', { name: p.name }), { danger: true, okText: t('server.ban') })) act('ban', p.name, {}, 'toastBan');
            },
          },
          icon('ban'),
        ),
      );
    });
    mount(
      onlineBox,
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head' },
          h('h2', { class: 'card-title' }, icon('users'), t('server.onlineNow'), h('span', { class: 'badge' }, String(players.length))),
          live ? h('button', { class: 'btn sm ghost', title: t('server.refreshListHint'), onclick: () => api.servers.command(srv.id, 'list').then(() => setTimeout(load, 800)).catch(() => {}) }, icon('refresh'), t('common.refresh')) : null,
        ),
        rows.length
          ? h('div', { class: 'sv-players-list', role: 'list' }, rows)
          : h('div', { class: 'sv-mini-empty' }, icon(live ? 'users' : 'power'), h('span', {}, live ? t('server.nobodyOnline') : t('server.playersOffline'))),
      ),
    );
  };

  const entryRow = (spec, e) => {
    const isIp = spec.id === 'bannedIps';
    const title = isIp ? e.ip : e.name;
    const sub = [];
    if (spec.id === 'ops') sub.push(t('server.opLevel', { level: e.level ?? 4 }));
    if (!isIp && e.uuid) sub.push(e.uuid);
    if (e.reason && e.reason !== 'Banned by an operator.') sub.push(e.reason);
    if (e.expires && e.expires !== 'forever') sub.push(t('server.banExpires', { when: e.expires }));
    return h(
      'div',
      { class: 'list-item' },
      isIp ? h('div', { class: 'li-icon' }, icon('globe')) : h('div', { class: 'li-icon' }, avatarImg(e.name, 64, '')),
      h('div', { class: 'li-main' }, h('div', { class: 'li-title', title: title || '' }, title || '?'), sub.length ? h('div', { class: 'li-sub selectable', title: sub.join(' · ') }, sub.join(' · ')) : null),
      h(
        'button',
        {
          class: 'icon-btn sm danger',
          title: t(`server.remove_${spec.id}`),
          'aria-label': `${t(`server.remove_${spec.id}`)}: ${title}`,
          onclick: async () => {
            if (spec.id === 'ops' || (await confirmDialog(t(`server.remove_${spec.id}`), t('server.removeEntryConfirm', { name: title }), { okText: t('common.remove') }))) act(spec.remove, title);
          },
        },
        icon(spec.id === 'banned' || spec.id === 'bannedIps' ? 'undo' : 'x'),
      ),
    );
  };

  const drawLists = () => {
    if (!data) return;
    const spec = LISTS.find((l) => l.id === listId);
    const entries = data[listId] || [];
    const nameInput = h('input', { class: 'input', placeholder: listId === 'bannedIps' ? t('server.ipPlaceholder') : t('server.namePlaceholder'), maxlength: listId === 'bannedIps' ? 45 : 16, spellcheck: 'false', 'aria-label': t(`server.add_${listId}`) });
    const reason = listId === 'banned' || listId === 'bannedIps' ? h('input', { class: 'input', placeholder: t('server.reasonPlaceholder'), maxlength: 120, 'aria-label': t('server.reasonPlaceholder') }) : null;
    let level = 4;
    const levelSel = listId === 'ops' && !data.running ? selectEl([1, 2, 3, 4].map((n) => ({ value: n, label: t('server.opLevel', { level: n }) })), level, (v) => (level = Number(v)), 'select sv-select-sm') : null;
    levelSel?.setAttribute('aria-label', t('server.opLevelLabel'));
    const addBtn = h('button', { class: 'btn' }, icon('plus'), t('common.add'));
    const submit = () => {
      const v = nameInput.value.trim();
      if (!v) {
        nameInput.focus();
        return;
      }
      act(spec.add, v, { reason: reason?.value || '', level }, `toastAdded_${listId}`, addBtn);
    };
    addBtn.addEventListener('click', submit);
    nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    // Pestañas de las listas: flechas, Inicio y Fin cambian de lista
    const selectList = (id, focus = false) => {
      listId = id;
      drawLists();
      if (focus) listsBox.querySelector('.sv-list-tabs button.active')?.focus();
    };
    const tabs = h(
      'div',
      {
        class: 'segmented sv-list-tabs',
        role: 'tablist',
        'aria-label': t('server.manageTitle'),
        onkeydown: (e) => {
          const move = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
          if (!move && e.key !== 'Home' && e.key !== 'End') return;
          e.preventDefault();
          const i = LISTS.findIndex((l) => l.id === listId);
          const j = e.key === 'Home' ? 0 : e.key === 'End' ? LISTS.length - 1 : (i + move + LISTS.length) % LISTS.length;
          selectList(LISTS[j].id, true);
        },
      },
      LISTS.map((l) =>
        h(
          'button',
          { class: l.id === listId ? 'active' : '', role: 'tab', tabindex: l.id === listId ? 0 : -1, 'aria-selected': l.id === listId ? 'true' : 'false', onclick: () => selectList(l.id) },
          icon(l.icon),
          t(`server.list_${l.id}`),
          h('span', { class: 'sv-count' }, String((data[l.id] || []).length)),
        ),
      ),
    );
    const whitelistToggle =
      listId === 'whitelist'
        ? h(
            'div',
            { class: 'toggle-row' },
            h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('server.whitelistEnabled')), h('div', { class: 'tr-sub' }, t('server.whitelistEnabledHint'))),
            switchEl(data.whitelistEnabled, async (v) => {
              try {
                await api.servers.setProperties(srv.id, { 'white-list': String(v) });
                if (data.state === 'online') await api.servers.command(srv.id, `whitelist ${v ? 'on' : 'off'}`);
                data.whitelistEnabled = v;
              } catch (err) {
                fail(t('server.errPlayerAction'), err);
              }
            }, t('server.whitelistEnabled')),
          )
        : null;
    mount(
      listsBox,
      h(
        'div',
        { class: 'card sv-card-q' },
        h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, icon('shield'), t('server.manageTitle'))),
        tabs,
        h(
          'div',
          { role: 'tabpanel', 'aria-label': t(`server.list_${listId}`) },
          h('div', { class: 'sv-list-hint' }, t(`server.listHint_${listId}`)),
          whitelistToggle,
          h('div', { class: 'sv-add-row' }, nameInput, reason, levelSel, addBtn),
          h('div', { class: 'list sv-entries' }, entries.length ? entries.map((e) => entryRow(spec, e)) : h('div', { class: 'sv-mini-empty' }, icon(spec.icon), h('span', {}, t(`server.empty_${listId}`)))),
        ),
      ),
    );
  };

  const draw = () => {
    drawHead();
    drawOnline();
    drawLists();
  };

  const layout = () => mount(container, h('div', { class: 'stack' }, head, h('div', { class: 'sv-two-col' }, onlineBox, listsBox)));

  async function load() {
    try {
      data = await api.invoke('servers:playerLists', srv.id);
      if (!container.contains(listsBox)) layout();
      draw();
    } catch (err) {
      mount(
        container,
        h('div', { class: 'notice bad sv-error' }, icon('alert'), h('div', {}, h('strong', {}, t('server.loadError')), h('div', {}, err.message)), h('button', { class: 'btn sm', onclick: () => (showSkeleton(), load()) }, icon('refresh'), t('common.retry'))),
      );
    }
  }

  // Mientras carga: esqueleto con la forma de las dos tarjetas
  const showSkeleton = () => {
    layout();
    mount(onlineBox, h('div', { class: 'card' }, skeleton('list', { rows: 2 })));
    mount(listsBox, h('div', { class: 'card' }, skeleton('list', { rows: 3 })));
  };

  showSkeleton();
  load();
  const offState = ctx.on('state', () => load());
  return () => offState();
}
