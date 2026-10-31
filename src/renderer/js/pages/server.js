// Detalle de un servidor local: cabecera con estado y acciones + pestañas (consola, jugadores,
// propiedades, reglas, mundo, complementos, red, ajustes; los proxies tienen su propia pestaña).
import { h, icon, mount, emptyState, setBusy } from '../ui.js';
import { store, api } from '../store.js';
import { t } from '../i18n.js';
import { navigate } from '../app.js';
import { loadTypes, typeMeta, typeBadge, serverTile, statusPill, serverTask, taskBar, tryInvoke, failUnlessTask } from './servers/common.js';
import { consoleTab } from './servers/console.js';
import { playersTab } from './servers/players.js';
import { propertiesTab } from './servers/properties.js';
import { gamerulesTab } from './servers/gamerules.js';
import { worldTab } from './servers/world.js';
import { addonsTab } from './servers/addons.js';
import { networkTab, rankInstances, playOnServer } from './servers/network.js';
import { settingsTab } from './servers/settings.js';
import { proxyTab } from './servers/proxy.js';

function tabsFor(srv) {
  const m = typeMeta(srv.type);
  if (m.kind === 'proxy') {
    return [
      { id: 'console', icon: 'terminal', render: consoleTab },
      { id: 'proxy', icon: 'svProxy', render: proxyTab },
      { id: 'addons', icon: 'puzzle', render: addonsTab, label: t('server.tab_plugins') },
      { id: 'network', icon: 'network', render: networkTab },
      { id: 'settings', icon: 'settings', render: settingsTab },
    ];
  }
  const addonLabel = m.kind === 'mods' ? t('server.tab_mods') : m.kind === 'hybrid' ? t('server.tab_addons') : t('server.tab_plugins');
  return [
    { id: 'console', icon: 'terminal', render: consoleTab },
    { id: 'players', icon: 'users', render: playersTab },
    { id: 'properties', icon: 'sliders', render: propertiesTab },
    { id: 'rules', icon: 'list', render: gamerulesTab },
    { id: 'world', icon: 'globe', render: worldTab },
    m.kind === 'vanilla' ? null : { id: 'addons', icon: m.kind === 'mods' ? 'package' : 'puzzle', render: addonsTab, label: addonLabel },
    { id: 'network', icon: 'network', render: networkTab },
    { id: 'settings', icon: 'settings', render: settingsTab },
  ].filter(Boolean);
}

export default {
  ns: ['servers', 'server'],
  css: ['pages/servers', 'pages/server'],
  async render(root, params) {
    const [id, tabId = 'console'] = params;
    await loadTypes();
    let srv;
    try {
      srv = await api.servers.get(id);
    } catch {
      mount(
        root,
        h(
          'div',
          { class: 'sv-root' },
          h('button', { class: 'back-link', onclick: () => navigate('servers') }, icon('chevronLeft'), t('server.backToServers')),
          h('div', { class: 'card' }, emptyState('server', t('server.notFound'), t('server.notFoundText'), h('button', { class: 'btn primary', onclick: () => navigate('servers') }, icon('chevronLeft'), t('server.backToServers')))),
        ),
      );
      return null;
    }
    const tabs = tabsFor(srv);
    const tab = tabs.find((x) => x.id === tabId) || tabs[0];
    let state = srv.state;
    let players = srv.players || [];
    let iconData = await tryInvoke('servers:icon', [srv.id], null).catch(() => null);
    const listeners = new Map();
    const emit = (evt) => (listeners.get(evt) || new Set()).forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.error('[servers]', err);
      }
    });
    const ctx = {
      get srv() {
        return srv;
      },
      state: () => state,
      players: () => players,
      on(evt, fn) {
        if (!listeners.has(evt)) listeners.set(evt, new Set());
        listeners.get(evt).add(fn);
        return () => listeners.get(evt)?.delete(fn);
      },
      async refresh() {
        try {
          srv = await api.servers.get(id);
          state = srv.state;
          players = srv.players || [];
          iconData = await tryInvoke('servers:icon', [srv.id], iconData).catch(() => iconData);
          drawHead();
          emit('server');
        } catch {
          /* el servidor se borro */
        }
      },
    };

    const headBox = h('div', { class: 'sv-head-wrap' });
    const body = h('div', { class: 'sv-body', id: 'sv-tabpanel', role: 'tabpanel', 'aria-labelledby': `sv-tab-${tab.id}`, tabindex: '-1' });
    const proxy = typeMeta(srv.type).kind === 'proxy';

    // Acciones de la cabecera: el boton muestra que esta trabajando mientras dura la accion
    const act = async (e, fn, errKey) => {
      const btn = e.currentTarget;
      const iconOnly = btn.classList.contains('icon-btn');
      const done = iconOnly ? null : setBusy(btn);
      if (iconOnly) {
        btn.disabled = true;
        btn.classList.add('sv-busy');
        btn.setAttribute('aria-busy', 'true');
      }
      try {
        await fn();
      } catch (err) {
        failUnlessTask(store, t(`servers.${errKey}`), err);
      } finally {
        if (done) done();
        else {
          btn.disabled = false;
          btn.classList.remove('sv-busy');
          btn.removeAttribute('aria-busy');
        }
      }
    };

    const quickPlay = () => {
      const best = rankInstances(srv)[0];
      if (!best) {
        navigate(`server/${srv.id}/network`);
        return;
      }
      playOnServer(srv, best.inst.id);
    };

    const top = h('div', { class: 'sv-head' });
    const taskSlot = h('div', { class: 'sv-head-task' });
    // Pestañas: la elegida queda en el orden de Tab; las flechas, Inicio y Fin mueven el foco y Enter la abre
    const tabsNav = h(
      'nav',
      { class: 'sv-tabs', role: 'tablist', 'aria-label': t('server.tabsLabel') },
      tabs.map((x) =>
        h(
          'button',
          {
            class: ['sv-tab', x.id === tab.id && 'active'],
            id: `sv-tab-${x.id}`,
            role: 'tab',
            'aria-selected': x.id === tab.id ? 'true' : 'false',
            'aria-controls': 'sv-tabpanel',
            tabindex: x.id === tab.id ? 0 : -1,
            title: x.label || t(`server.tab_${x.id}`),
            onclick: () => x.id !== tab.id && navigate(`server/${srv.id}/${x.id}`),
          },
          icon(x.icon),
          h('span', {}, x.label || t(`server.tab_${x.id}`)),
        ),
      ),
    );
    tabsNav.addEventListener('keydown', (e) => {
      if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
      const list = [...tabsNav.querySelectorAll('.sv-tab')];
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length;
      list.forEach((b, k) => (b.tabIndex = k === j ? 0 : -1));
      list[j].focus();
    });
    mount(headBox, h('button', { class: 'back-link', onclick: () => navigate('servers') }, icon('chevronLeft'), t('server.backToServers')), top, taskSlot, tabsNav);
    let hadTask = false;

    function drawTask() {
      const task = serverTask(store, srv.id);
      mount(taskSlot, task ? taskBar(task) : null);
      taskSlot.classList.toggle('hidden', !task);
      if (Boolean(task) !== hadTask) {
        hadTask = Boolean(task);
        drawHead();
      }
    }

    function drawHead() {
      const task = serverTask(store, srv.id);
      hadTask = Boolean(task);
      const m = typeMeta(srv.type);
      const extra = state === 'online' && !proxy ? t('servers.playersCount', { count: players.length }) : null;
      const actions = [];
      if (state === 'offline') {
        actions.push(h('button', { class: 'btn lg good', disabled: Boolean(task) || srv.busy, onclick: (e) => act(e, () => api.servers.start(srv.id), 'errStart') }, icon('play'), t('servers.start')));
      } else {
        if (state === 'online' && !proxy) actions.push(h('button', { class: 'btn lg primary', onclick: quickPlay, title: t('server.playHint') }, icon('gamepad'), t('server.play')));
        if (state === 'online') actions.push(h('button', { class: 'icon-btn sv-icon-lg', title: t('servers.restart'), 'aria-label': t('servers.restart'), onclick: (e) => act(e, () => api.invoke('servers:restart', srv.id), 'errStart') }, icon('svRestart')));
        // Detener / Forzar quedan separados de Jugar
        if (actions.length) actions.push(h('span', { class: 'sv-sep', 'aria-hidden': 'true' }));
        if (state === 'stopping') actions.push(h('button', { class: 'btn lg danger', title: t('servers.killHint'), onclick: (e) => act(e, () => api.servers.kill(srv.id), 'errStop') }, icon('zap'), t('servers.kill')));
        else actions.push(h('button', { class: 'btn lg danger', onclick: (e) => act(e, () => api.servers.stop(srv.id), 'errStop') }, icon('stop'), t('servers.stop')));
      }
      mount(
        top,
        serverTile(srv, iconData, 68),
        h(
          'div',
          { class: 'sv-head-main' },
          h('h1', { class: 'page-title ellipsis', title: srv.name }, srv.name),
          h(
            'div',
            { class: 'row wrap sv-head-meta' },
            typeBadge(srv.type, srv.build ? `#${srv.build}` : null),
            h('span', { class: 'badge' }, proxy ? null : icon('box'), proxy ? srv.mcVersion : `Minecraft ${srv.mcVersion}`),
            statusPill(state, extra),
            h('span', { class: 'small muted' }, t('servers.metaPort', { port: srv.port })),
            m.experimental ? h('span', { class: 'badge warn' }, t('servers.experimental')) : null,
            !srv.installed && !task ? h('span', { class: 'badge warn', title: t('servers.notInstalled') }, icon('download'), t('server.notInstalledBadge')) : null,
          ),
        ),
        h('div', { class: 'sv-head-actions' }, actions),
      );
      mount(taskSlot, task ? taskBar(task) : null);
      taskSlot.classList.toggle('hidden', !task);
    }

    mount(root, h('div', { class: 'sv-root' }, headBox, body));
    drawHead();
    let cleanupTab = null;
    try {
      cleanupTab = tab.render(body, ctx) || null;
    } catch (err) {
      console.error('[servers]', err);
      mount(body, h('div', { class: 'notice bad' }, icon('alert'), err.message));
    }

    const offs = [
      api.on('server:state', (sid, st) => {
        if (sid !== srv.id) return;
        const changed = st.state !== state;
        state = st.state;
        players = st.players || [];
        srv = { ...srv, state, players, playerInfo: st.playerInfo || srv.playerInfo };
        drawHead();
        emit('state');
        if (changed && state === 'offline') ctx.refresh();
      }),
      api.on('servers:changed', () => ctx.refresh()),
      store.on('task', (task) => {
        if (task.meta?.serverId !== srv.id) return;
        drawTask();
        if (task.state !== 'running') ctx.refresh();
      }),
    ];
    return () => {
      offs.forEach((o) => o());
      if (typeof cleanupTab === 'function') cleanupTab();
    };
  },
};
