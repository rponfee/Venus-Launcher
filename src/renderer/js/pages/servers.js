// Servidores locales: lista, asistente de creacion y "servidor espejo" a partir de una instancia.
import { h, icon, mount, fail, copyText, fmtAgo, setBusy } from '../ui.js';
import { store, api } from '../store.js';
import { t } from '../i18n.js';
import { navigate } from '../app.js';
import { loadTypes, typeMeta, typeBadge, serverTile, statusPill, serverTask, taskBar, tryInvoke, memLabel, failUnlessTask } from './servers/common.js';
import { openCreateWizard } from './servers/create.js';
import { openMirrorDialog } from './servers/mirror.js';

// Tarjetas de esqueleto con la forma de una tarjeta real (se anuncian una sola vez como "Cargando...")
function listSkeleton() {
  const bone = (cls) => h('span', { class: `skeleton ${cls}` });
  return h(
    'div',
    { class: 'skeleton-group', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    h('span', { class: 'sr-only' }, t('common.loading')),
    h(
      'div',
      { class: 'skeleton-shapes sv-list', 'aria-hidden': 'true' },
      [0, 1, 2].map(() => h('div', { class: 'sv-skel-card' }, bone('sv-skel-tile'), h('div', { class: 'skeleton-lines' }, bone('skeleton-line title'), bone('skeleton-line')), bone('sv-skel-btn'))),
    ),
  );
}

export default {
  ns: ['servers', 'server'],
  css: ['pages/servers', 'pages/server'],
  async render(root) {
    await loadTypes();
    const listBox = h('div', { class: 'sv-list', 'aria-live': 'polite' });
    const aside = h('aside', { class: 'sv-aside', 'aria-label': t('servers.friendsTitle') });
    let servers = [];
    let icons = {};
    let loaded = false;

    const afterCreate = (srv) => navigate(`server/${srv.id}`);
    const create = () => openCreateWizard({ onCreated: afterCreate });
    const mirror = () => openMirrorDialog({ onCreated: afterCreate });

    const startStop = async (e, s) => {
      e.stopPropagation();
      const done = setBusy(e.currentTarget);
      try {
        if (s.state === 'offline') await api.servers.start(s.id);
        else await api.servers.stop(s.id);
      } catch (err) {
        failUnlessTask(store, s.state === 'offline' ? t('servers.errStart') : t('servers.errStop'), err);
      } finally {
        done();
      }
    };

    const card = (s) => {
      const task = serverTask(store, s.id);
      const m = typeMeta(s.type);
      const proxy = m.kind === 'proxy';
      const players = s.state === 'online' && !proxy ? t('servers.playersCount', { count: s.players.length }) : null;
      const meta = [
        t('servers.metaPort', { port: s.port }),
        memLabel(s.memory?.max || 2048),
        !s.lastStarted ? t('servers.metaNeverStarted') : Date.now() - s.lastStarted < 60000 ? t('servers.metaUsedNow') : t('servers.metaUsed', { when: fmtAgo(s.lastStarted) }),
      ].join(' · ');
      return h(
        'div',
        {
          class: ['sv-card', s.state !== 'offline' && 'is-on', task && 'is-busy'],
          role: 'link',
          tabindex: 0,
          'aria-label': t('servers.openServer', { name: s.name }),
          onclick: () => navigate(`server/${s.id}`),
          onkeydown: (e) => {
            if (e.key === 'Enter' && e.target === e.currentTarget) navigate(`server/${s.id}`);
          },
        },
        serverTile(s, icons[s.id], 52),
        h(
          'div',
          { class: 'sv-card-main' },
          h('div', { class: 'sv-card-title' }, h('span', { class: 'sv-card-name ellipsis', title: s.name }, s.name), typeBadge(s.type), h('span', { class: 'badge' }, proxy ? null : icon('box'), proxy ? s.mcVersion : `Minecraft ${s.mcVersion}`)),
          h('div', { class: 'sv-card-meta' }, statusPill(s.state, players), h('span', { class: 'small muted ellipsis', title: meta }, meta)),
          task ? taskBar(task) : !s.installed ? h('div', { class: 'sv-card-note sv-warn-text' }, icon('download'), h('span', {}, t('servers.notInstalled'))) : null,
          s.mirror?.instanceName ? h('div', { class: 'sv-card-note' }, icon('copy'), h('span', { class: 'ellipsis' }, t('servers.mirrorOf', { name: s.mirror.instanceName }))) : null,
        ),
        h(
          'div',
          { class: 'sv-card-actions' },
          s.state === 'offline'
            ? h('button', { class: 'btn good', disabled: Boolean(task) || s.busy, 'aria-label': t('servers.startOf', { name: s.name }), onclick: (e) => startStop(e, s) }, icon('play'), t('servers.start'))
            : h('button', { class: 'btn danger', disabled: s.state === 'stopping', 'aria-label': t('servers.stopOf', { name: s.name }), onclick: (e) => startStop(e, s) }, icon('stop'), s.state === 'stopping' ? t('servers.stopping') : t('servers.stop')),
          h('button', { class: 'icon-btn', title: t('common.openFolder'), 'aria-label': t('servers.openFolderOf', { name: s.name }), onclick: (e) => (e.stopPropagation(), api.servers.openFolder(s.id).catch((err) => fail(t('common.error'), err))) }, icon('folder')),
        ),
      );
    };

    const headActions = h(
      'div',
      { class: 'page-actions' },
      h('button', { class: 'btn', onclick: mirror, title: t('servers.mirrorHint') }, icon('copy'), t('servers.mirrorCta')),
      h('button', { class: 'btn primary', onclick: create }, icon('plus'), t('servers.create')),
    );

    const drawList = () => {
      if (!loaded) return;
      // Sin servidores, las acciones viven en el estado vacio (una sola accion principal)
      headActions.hidden = !servers.length;
      if (!servers.length) {
        mount(
          listBox,
          h(
            'div',
            { class: 'card sv-empty' },
            h('div', { class: 'sv-empty-art', 'aria-hidden': 'true' }, icon('server')),
            h('h2', { class: 'sv-empty-title' }, t('servers.emptyTitle')),
            h('p', { class: 'sv-empty-text' }, t('servers.emptyText')),
            h('div', { class: 'row wrap sv-empty-actions' }, h('button', { class: 'btn primary lg', onclick: create }, icon('plus'), t('servers.createFirst')), h('button', { class: 'btn lg', onclick: mirror, title: t('servers.mirrorHint') }, icon('copy'), t('servers.mirrorCta'))),
            h(
              'div',
              { class: 'sv-empty-points' },
              [
                ['layers', 'emptyPoint1'],
                ['copy', 'emptyPoint2'],
                ['users', 'emptyPoint3'],
              ].map(([ic, k]) => h('div', { class: 'sv-empty-point' }, icon(ic), h('span', {}, t(`servers.${k}`)))),
            ),
          ),
        );
        return;
      }
      const running = servers.filter((s) => s.state !== 'offline').length;
      mount(
        listBox,
        h('div', { class: 'sv-list-head' }, h('span', { class: 'label' }, t('servers.count', { count: servers.length })), running ? h('span', { class: 'pill good' }, h('span', { class: 'status-dot online' }), t('servers.runningCount', { count: running })) : null),
        servers.map(card),
      );
    };

    const drawAside = async () => {
      const addrs = await api.servers.addresses().catch(() => []);
      mount(
        aside,
        h(
          'div',
          { class: 'card' },
          h('h2', { class: 'card-title' }, icon('wifi'), t('servers.friendsTitle')),
          h('div', { class: 'card-sub' }, t('servers.friendsSub')),
          h(
            'div',
            { class: 'stack sv-friends' },
            h('div', { class: 'sv-friend-row' }, h('span', { class: 'sv-friend-k' }, t('servers.friendsYou')), h('span', { class: 'kbd selectable' }, 'localhost')),
            addrs.length
              ? addrs.slice(0, 3).map((a) =>
                  h('div', { class: 'sv-friend-row' }, h('span', { class: 'sv-friend-k ellipsis', title: a.name }, t('servers.friendsLan')), h('span', { class: 'kbd selectable', title: a.address }, a.address), h('button', { class: 'icon-btn sm', title: t('common.copy'), 'aria-label': t('servers.copyAddress', { address: a.address }), onclick: () => copyText(a.address) }, icon('copy'))),
                )
              : h('div', { class: 'small muted' }, t('servers.friendsNoLan')),
            h('div', { class: 'sv-friend-note' }, t('servers.friendsInternet')),
            h('div', { class: 'tiny muted' }, t('servers.friendsOffline')),
          ),
        ),
        h(
          'div',
          { class: 'card sv-guide' },
          h('h2', { class: 'card-title' }, icon('compass'), t('servers.guideTitle')),
          [
            ['vanilla', 'guideVanilla'],
            ['paper', 'guidePlugins'],
            ['fabric', 'guideMods'],
            ['velocity', 'guideProxy'],
          ].map(([type, k]) => h('div', { class: 'sv-guide-row' }, typeBadge(type), h('span', {}, t(`servers.${k}`)))),
        ),
      );
    };

    const load = async () => {
      try {
        servers = await api.servers.list();
        store.servers = servers;
        icons = (await tryInvoke('servers:icons', [], {})) || {};
      } catch (err) {
        headActions.hidden = false;
        mount(
          listBox,
          h(
            'div',
            { class: 'notice bad sv-error' },
            icon('alert'),
            h('div', {}, h('strong', {}, t('servers.loadError')), h('div', {}, err.message)),
            h('button', { class: 'btn sm', onclick: () => (mount(listBox, listSkeleton()), load()) }, icon('refresh'), t('common.retry')),
          ),
        );
        return;
      }
      loaded = true;
      drawList();
    };

    mount(
      root,
      h(
        'div',
        { class: 'sv-root' },
        h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, t('servers.title')), h('p', { class: 'page-sub' }, t('servers.subtitle'))), headActions),
        h('div', { class: 'sv-layout' }, listBox, aside),
      ),
    );
    mount(listBox, listSkeleton());
    drawAside();
    await load();

    let pending = null;
    const reload = () => {
      clearTimeout(pending);
      pending = setTimeout(load, 150);
    };
    const offs = [
      api.on('server:state', reload),
      api.on('servers:changed', reload),
      store.on('task', (task) => {
        if (task.meta?.serverId) {
          drawList();
          if (task.state !== 'running') reload();
        }
      }),
    ];
    return () => {
      clearTimeout(pending);
      offs.forEach((o) => o());
    };
  },
};
