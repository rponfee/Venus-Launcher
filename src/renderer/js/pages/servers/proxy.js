// Proxy (Velocity / Waterfall): que es, como conectar los servidores locales detras del proxy y
// acceso a su archivo de configuracion.
import { h, icon, mount, fail, ok, confirmDialog, copyText, skeleton, setBusy } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import { typeMeta, typeBadge, statusPill } from './common.js';
import { openFileEditor } from './settings.js';

const slugName = (s) => String(s.name || s.id).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || s.id;

export function proxyTab(container, ctx) {
  const srv = ctx.srv;
  const velocity = srv.type === 'velocity';
  const configFile = velocity ? 'velocity.toml' : 'config.yml';
  const listBox = h('div');

  async function draw() {
    mount(listBox, h('div', { class: 'card' }, skeleton('list', { rows: 2 })));
    let all = [];
    try {
      all = (await api.servers.list()).filter((s) => typeMeta(s.type).kind !== 'proxy');
    } catch (err) {
      mount(listBox, h('div', { class: 'notice bad sv-error' }, icon('alert'), h('div', {}, h('strong', {}, t('server.loadError')), h('div', {}, err.message)), h('button', { class: 'btn sm', onclick: draw }, icon('refresh'), t('common.retry'))));
      return;
    }
    const backends = [];
    for (const s of all) {
      const p = await api.servers.properties(s.id).catch(() => ({}));
      backends.push({ s, onlineMode: p['online-mode'] !== 'false', port: Number(p['server-port']) || s.port });
    }
    const snippet = velocity
      ? ['[servers]', ...backends.map((b) => `${slugName(b.s)} = "127.0.0.1:${b.port}"`), `try = [${backends[0] ? ` "${slugName(backends[0].s)}" ` : ''}]`, '', '[forced-hosts]'].join('\n')
      : ['servers:', ...backends.flatMap((b) => [`  ${slugName(b.s)}:`, `    motd: '${b.s.name.replace(/'/g, "''")}'`, `    address: 127.0.0.1:${b.port}`, '    restricted: false'])].join('\n');
    mount(
      listBox,
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'card-title' }, icon('server'), t('server.proxyBackends')), h('div', { class: 'card-sub' }, t('server.proxyBackendsSub'))), h('button', { class: 'icon-btn sm', title: t('common.refresh'), 'aria-label': t('common.refresh'), onclick: draw }, icon('refresh'))),
        backends.length
          ? h(
              'div',
              { class: 'list sv-entries' },
              backends.map((b) =>
                h(
                  'div',
                  { class: 'list-item' },
                  h('div', { class: 'li-main' }, h('div', { class: 'li-title sv-backend-title' }, h('span', { title: b.s.name }, b.s.name), typeBadge(b.s.type)), h('div', { class: 'li-sub' }, `127.0.0.1:${b.port} · ${b.onlineMode ? t('server.backendOnline') : t('server.backendOffline')}`)),
                  statusPill(b.s.state),
                  b.onlineMode
                    ? h(
                        'button',
                        {
                          class: 'btn sm',
                          title: t('server.prepareBackendHint'),
                          onclick: async (e) => {
                            const btn = e.currentTarget;
                            if (!(await confirmDialog(t('server.prepareBackend'), t('server.prepareBackendConfirm', { name: b.s.name }), { okText: t('server.prepareBackend') }))) return;
                            const release = setBusy(btn);
                            try {
                              await api.servers.setProperties(b.s.id, { 'online-mode': 'false' });
                              ok(t('server.backendPrepared', { name: b.s.name }));
                              draw();
                            } catch (err) {
                              release();
                              fail(t('server.errSave'), err);
                            }
                          },
                        },
                        icon('wrench'),
                        t('server.prepareBackend'),
                      )
                    : h('span', { class: 'pill good' }, icon('check'), t('server.backendReady')),
                  h('button', { class: 'icon-btn sm', title: t('server.openServer'), 'aria-label': `${t('server.openServer')}: ${b.s.name}`, onclick: () => navigate(`server/${b.s.id}`) }, icon('chevronRight')),
                ),
              ),
            )
          : h('div', { class: 'sv-mini-empty' }, icon('server'), h('span', {}, t('server.proxyNoBackends'))),
        backends.length
          ? h(
              'div',
              { class: 'stack sv-section' },
              h('div', { class: 'small text-2' }, t('server.proxySnippet', { file: configFile })),
              h('pre', { class: 'sv-snippet selectable' }, snippet),
              h('div', { class: 'row wrap' }, h('button', { class: 'btn sm', onclick: () => copyText(snippet) }, icon('copy'), t('common.copy')), h('button', { class: 'btn sm', onclick: () => openFileEditor(srv, configFile) }, icon('edit'), t('server.editConfig', { file: configFile }))),
              h('div', { class: 'tiny muted' }, velocity ? t('server.proxyForwardingHint') : t('server.waterfallHint')),
            )
          : null,
      ),
    );
  }

  mount(
    container,
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'card sv-proxy-explain' },
        h('h2', { class: 'card-title' }, icon('svProxy'), t('servers.proxyWhatTitle')),
        h('p', { class: 'small text-2' }, t('servers.proxyWhatText')),
        h('div', { class: 'sv-proxy-diagram', 'aria-hidden': 'true' }, h('span', { class: 'sv-pd-node' }, icon('users'), t('server.pdPlayers')), h('span', { class: 'sv-pd-arrow' }, icon('arrowRight')), h('span', { class: 'sv-pd-node accent' }, icon('svProxy'), typeMeta(srv.type).name, h('span', { class: 'tiny' }, `:${srv.port}`)), h('span', { class: 'sv-pd-arrow' }, icon('arrowRight')), h('span', { class: 'sv-pd-stack' }, h('span', { class: 'sv-pd-node' }, icon('server'), 'lobby'), h('span', { class: 'sv-pd-node' }, icon('server'), 'survival'))),
        h('ol', { class: 'steps' }, h('li', {}, t('servers.proxyStep1')), h('li', {}, t('servers.proxyStep2')), h('li', {}, t('servers.proxyStep3')), h('li', {}, t('servers.proxyStep4'))),
        srv.type === 'waterfall' ? h('div', { class: 'notice sv-section' }, icon('alert'), t('servers.wzWaterfallNote')) : null,
      ),
      listBox,
    ),
  );
  draw();
  return null;
}
