// Plugins y mods del servidor: lista local (activar, desactivar, borrar), agregar jars, Modrinth,
// Simple Voice Chat con un clic (con la revision de compatibilidad) y el analisis de seguridad.
import { h, icon, mount, fail, ok, confirmDialog, emptyState, switchEl, fmtBytes, debounce, skeleton, setBusy } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import { typeMeta, failUnlessTask, compatAllows } from './common.js';

const VOICE_CHAT = '9eGKb6K1';
const VOICE_TYPES = new Set(['fabric', 'quilt', 'forge', 'neoforge', 'paper', 'purpur', 'spigot']);

export function addonsTab(container, ctx) {
  const srv = ctx.srv;
  const m = typeMeta(srv.type);
  if (m.kind === 'vanilla') {
    mount(container, h('div', { class: 'card' }, emptyState('puzzle', t('server.vanillaAddonsTitle'), t('server.vanillaAddonsText'))));
    return null;
  }
  const folders = m.kind === 'hybrid' ? ['mods', 'plugins'] : m.kind === 'mods' ? ['mods'] : ['plugins'];
  let folder = folders[0];
  let data = null;
  let query = '';
  const listBox = h('div', { class: 'list' });
  const tabsBox = h('div');

  // ctx.srv: los datos del servidor se actualizan despues de instalar (titulo e icono de lo nuevo)
  const records = () => {
    const out = {};
    for (const [pid, r] of Object.entries(ctx.srv?.modrinth?.projects || {})) out[r.file] = { ...r, projectId: pid };
    return out;
  };

  function drawList() {
    if (!data) return;
    const entry = (data.folders || []).find((f) => f.folder === folder) || { files: folder === data.folder ? data.files : [] };
    const recs = records();
    const files = entry.files.filter((f) => !f.isDir && (!query || f.file.toLowerCase().includes(query) || (recs[f.file.replace(/\.disabled$/, '')]?.title || '').toLowerCase().includes(query)));
    if (!entry.files.length) {
      mount(listBox, emptyState(folder === 'mods' ? 'package' : 'puzzle', t(`server.noAddons_${folder}`), t('server.noAddonsText')));
      return;
    }
    if (!files.length) {
      mount(listBox, emptyState('search', t('server.addonsNoMatch'), null, h('button', { class: 'btn', onclick: () => ((search.value = ''), (query = ''), drawList(), search.focus()) }, icon('x'), t('server.clearSearch'))));
      return;
    }
    mount(
      listBox,
      files.map((f) => {
        const rec = recs[f.file.replace(/\.disabled$/, '')];
        return h(
          'div',
          { class: ['list-item', !f.enabled && 'disabled'] },
          h('div', { class: 'li-icon' }, rec?.icon ? h('img', { src: rec.icon, alt: '', loading: 'lazy' }) : icon(folder === 'mods' ? 'package' : 'puzzle')),
          h('div', { class: 'li-main' }, h('div', { class: 'li-title', title: rec?.title || f.file }, rec?.title || f.file.replace(/\.jar(\.disabled)?$/i, '')), h('div', { class: 'li-sub', title: f.file }, [f.file, rec?.versionNumber ? (/^\d/.test(rec.versionNumber) ? `v${rec.versionNumber}` : rec.versionNumber) : null, fmtBytes(f.size)].filter(Boolean).join(' · '))),
          switchEl(f.enabled, async () => {
            try {
              await api.invoke('servers:toggleFile', srv.id, folder, f.file);
              load();
            } catch (err) {
              fail(t('common.error'), err);
            }
          }, f.enabled ? t('server.disableAddon') : t('server.enableAddon')),
          h(
            'button',
            {
              class: 'icon-btn sm danger',
              title: t('common.delete'),
              'aria-label': `${t('common.delete')}: ${rec?.title || f.file}`,
              onclick: async () => {
                if (!(await confirmDialog(t('server.deleteAddon'), t('server.deleteAddonConfirm', { name: rec?.title || f.file }), { danger: true, okText: t('common.delete') }))) return;
                await api.servers.deleteFile(srv.id, folder, f.file).catch((e) => fail(t('common.error'), e));
                load();
              },
            },
            icon('trash'),
          ),
        );
      }),
    );
  }

  function drawTabs() {
    if (folders.length < 2) {
      mount(tabsBox);
      return;
    }
    mount(
      tabsBox,
      h(
        'div',
        { class: 'segmented', role: 'tablist', 'aria-label': t('server.tab_addons') },
        folders.map((f) => {
          const count = ((data?.folders || []).find((x) => x.folder === f)?.files || []).length;
          return h('button', { class: f === folder ? 'active' : '', role: 'tab', 'aria-selected': f === folder ? 'true' : 'false', onclick: () => ((folder = f), drawTabs(), drawList()) }, icon(f === 'mods' ? 'package' : 'puzzle'), t(`server.folder_${f}`), h('span', { class: 'sv-count' }, String(count)));
        }),
      ),
    );
  }

  async function load() {
    try {
      data = await api.servers.content(srv.id);
      drawTabs();
      drawList();
    } catch (err) {
      mount(listBox, h('div', { class: 'notice bad sv-error' }, icon('alert'), h('div', {}, h('strong', {}, t('server.loadError')), h('div', {}, err.message)), h('button', { class: 'btn sm', onclick: () => (mount(listBox, skeleton('list', { rows: 3 })), load()) }, icon('refresh'), t('common.retry'))));
    }
  }

  const addFiles = async () => {
    const paths = await api.app.selectFiles({ multi: true, filters: [{ name: folder === 'mods' ? 'Mods' : 'Plugins', extensions: ['jar'] }] }).catch(() => []);
    if (!paths?.length) return;
    try {
      const added = await api.invoke('servers:addFiles', srv.id, folder, paths);
      ok(t('server.addonsAdded', { count: added.length }));
      load();
    } catch (err) {
      fail(t('common.error'), err);
    }
  };

  const installVoice = async (e) => {
    const done = setBusy(e.currentTarget);
    try {
      // Revision de compatibilidad (modulo compat): puede cambiar la version elegida u omitir el item
      const items = [{ projectId: VOICE_CHAT, type: m.kind === 'mods' ? 'mod' : 'plugin' }];
      if (!(await compatAllows({ kind: 'server', id: srv.id }, items)) || !items.length) return;
      await api.servers.installProject(srv.id, items[0].projectId, items[0].versionId || null);
      ok(t('server.voiceInstalled'), t('server.voiceInstalledText'));
      await ctx.refresh();
      load();
    } catch (err) {
      failUnlessTask(store, t('server.errInstallAddon'), err);
    } finally {
      done();
    }
  };

  const securityScan = async () => {
    try {
      const mod = await import('../../features/analysis.js');
      await mod.openSecurityScan({ serverId: srv.id });
    } catch (err) {
      console.error('[servers] analisis de seguridad', err);
      fail(t('server.securityFailed'), err);
    }
  };

  const search = h('input', { class: 'input', type: 'search', placeholder: t('server.addonsSearch'), 'aria-label': t('server.addonsSearch') });
  search.addEventListener('input', debounce(() => ((query = search.value.trim().toLowerCase()), drawList()), 120));
  const modrinthType = m.kind === 'mods' ? 'mod' : 'plugin';

  mount(
    container,
    h(
      'div',
      { class: 'stack' },
      m.id === 'folia' ? h('div', { class: 'notice' }, icon('alert'), t('server.foliaPlugins')) : null,
      m.kind === 'hybrid' ? h('div', { class: 'notice' }, icon('alert'), t('server.hybridAddons')) : null,
      h(
        'div',
        { class: 'sv-addons-bar' },
        h('button', { class: 'btn modrinth soft', onclick: () => navigate(`modrinth/-/${folder === 'mods' ? 'mod' : modrinthType}/${srv.id}`) }, icon('package'), t('server.searchModrinth')),
        h('button', { class: 'btn', onclick: addFiles }, icon('upload'), t('server.addJars')),
        VOICE_TYPES.has(srv.type) ? h('button', { class: 'btn', onclick: installVoice, title: t('server.voiceHint') }, icon('mic'), t('server.installVoice')) : null,
        h('button', { class: 'btn', onclick: securityScan, title: t('server.securityHint') }, icon('shieldCheck'), t('server.securityScan')),
        h('div', { class: 'input-icon sv-addons-search' }, icon('search'), search),
        h('button', { class: 'icon-btn', title: t('common.openFolder'), 'aria-label': t('common.openFolder'), onclick: () => api.invoke('servers:openPath', srv.id, folder).catch((e) => fail(t('common.error'), e)) }, icon('folderOpen')),
      ),
      folders.length > 1 ? tabsBox : null,
      h('div', { class: 'card flat sv-addons-list' }, listBox),
      h('div', { class: 'tiny muted' }, ctx.state() === 'offline' ? t('server.addonsHint') : t('server.addonsHintRunning')),
    ),
  );
  mount(listBox, skeleton('list', { rows: 3 }));
  load();
  const off = api.on('servers:changed', load);
  return () => off();
}
