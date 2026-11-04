// Pestaña Instaladas: lista, permisos, activar, desactivar, desinstalar, modo seguro e instalar desde un archivo.
import { h, icon, mount, switchEl, confirmDialog, ok, fail, setBusy, emptyState, fmtBytes, fmtDate, modal } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import { extensionsState, onExtensions, refreshExtensions, availableUpdates, catalogAllowed, setExtensionEnabled } from '../../features/extensions.js';
import { openInstallDialog } from '../../features/extensions/install-dialog.js';
import { permRow, neverBlock, permTitle } from '../../features/extensions/perms.js';
import { downloadAndInstall } from './catalog.js';

// Elegir un archivo: el proceso principal lo valida entero antes de mostrar nada.
export async function installFromFile() {
  try {
    const sum = await api.invoke('extensions:inspectFile');
    if (!sum) return;
    await openInstallDialog(sum);
    await refreshExtensions();
  } catch (err) {
    fail(t('extensions.packageRejected'), err);
  }
}

function showPermissions(ext) {
  const m = modal({
    title: ext.name,
    subtitle: t('extensions.communityTag'),
    icon: 'puzzle',
    body: h(
      'div',
      { class: 'stack' },
      h('div', { class: 'small muted selectable' }, t('extensions.versionBy', { version: ext.version, author: ext.author })),
      ext.description ? h('p', { class: 'text-2 selectable xt-sum-desc' }, ext.description) : null,
      h('div', { class: 'label' }, ext.permissions.length ? t('extensions.permsHas') : t('extensions.permsNone')),
      ext.permissions.length ? h('div', { class: 'xt-perms' }, ext.permissions.map((p) => permRow(p))) : null,
      neverBlock(),
      h('div', { class: 'small muted selectable xt-sha' }, t(ext.source === 'catalog' ? 'extensions.sourceCatalog' : 'extensions.sourceLocal'), ` · ${t('extensions.pkgSize', { size: fmtBytes(ext.size) })} · ${t('extensions.installedAt', { date: fmtDate(ext.installedAt) })}`),
      h('div', { class: 'small muted selectable xt-sha' }, `SHA-256 ${ext.sha256}`),
    ),
    footer: [h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, t('extensions.close'))],
  });
}

function row(ext, safeMode) {
  const update = availableUpdates().get(ext.id);
  const act = async (fn, failKey) => {
    try {
      await fn();
    } catch (err) {
      fail(t(failKey), err);
    } finally {
      await refreshExtensions();
    }
  };
  const openBtn = h('button', { class: 'btn sm', type: 'button', disabled: !ext.enabled || safeMode, onclick: () => navigate(`ext-${ext.id}`) }, icon('play'), t('extensions.open'));
  const updateBtn = update
    ? h('button', { class: 'btn sm tonal', type: 'button' }, icon('download'), t('extensions.updateTo', { version: update.version }))
    : null;
  updateBtn?.addEventListener('click', async () => {
    const release = setBusy(updateBtn);
    await downloadAndInstall(update).catch((err) => fail(t('extensions.installFailed'), err));
    release();
    await refreshExtensions();
  });
  const removeBtn = h('button', { class: 'icon-btn sm danger', type: 'button', title: t('extensions.uninstall'), 'aria-label': t('extensions.uninstall') }, icon('trash'));
  removeBtn.addEventListener('click', async () => {
    if (!(await confirmDialog(t('extensions.uninstallTitle'), t('extensions.uninstallText', { name: ext.name }), { okText: t('extensions.uninstall'), cancelText: t('extensions.cancel'), danger: true }))) return;
    await act(() => api.invoke('extensions:uninstall', ext.id), 'extensions.uninstallFailed');
    ok(t('extensions.uninstalledOk', { name: ext.name }));
  });
  return h(
    'div',
    { class: ['card', 'xt-item', ext.blocked && 'blocked'] },
    h(
      'div',
      { class: 'xt-item-top' },
      h('span', { class: 'xt-item-icon', 'aria-hidden': 'true' }, icon('puzzle')),
      h(
        'div',
        { class: 'xt-item-main' },
        h('div', { class: 'xt-item-name' }, h('strong', { class: 'ellipsis', title: ext.name }, ext.name), h('span', { class: 'badge' }, `v${ext.version}`), ext.blocked ? h('span', { class: 'pill bad' }, t('extensions.blockedTag')) : null, ext.source === 'local' ? h('span', { class: 'pill warn' }, t('extensions.localTag')) : null),
        h('div', { class: 'small muted ellipsis', title: ext.author }, t('extensions.byAuthor', { author: ext.author })),
        ext.description ? h('div', { class: 'small text-2 xt-item-desc' }, ext.description) : null,
      ),
      switchEl(ext.enabled, (on) => act(() => setExtensionEnabled(ext.id, on), 'extensions.saveFailed'), t('extensions.enabledSwitch', { name: ext.name })),
    ),
    h(
      'div',
      { class: 'xt-item-perms' },
      ext.permissions.length ? ext.permissions.map((p) => h('span', { class: 'chip xt-chip' }, permTitle(p))) : h('span', { class: 'small muted' }, t('extensions.permsNoneShort')),
    ),
    ext.blocked ? h('div', { class: 'notice bad' }, icon('alert'), t('extensions.blockedNote')) : null,
    ext.hasHomeCard
      ? h(
          'div',
          { class: 'toggle-row xt-item-card' },
          h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('extensions.homeCardSwitch'))),
          switchEl(ext.homeCardEnabled, (on) => act(() => api.invoke('extensions:setHomeCard', ext.id, on), 'extensions.saveFailed'), t('extensions.homeCardSwitch')),
        )
      : null,
    h('div', { class: 'row wrap xt-item-actions' }, openBtn, updateBtn, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => showPermissions(ext) }, icon('shield'), t('extensions.details')), h('span', { class: 'spacer' }), removeBtn),
  );
}

export function installedTab() {
  const safeSlot = h('div');
  const listSlot = h('div', { class: 'stack xt-list' });

  function draw() {
    const { items, safeMode, safeModeForced } = extensionsState();
    mount(
      safeSlot,
      h(
        'div',
        { class: ['card', 'xt-safe', safeMode && 'on'] },
        h(
          'div',
          { class: 'toggle-row' },
          h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, icon('shield'), ' ', t('extensions.safeMode')), h('div', { class: 'tr-sub' }, safeModeForced ? t('extensions.safeModeForced') : t('extensions.safeModeText'))),
          switchEl(
            safeMode,
            (on) => api.invoke('extensions:setSafeMode', on).catch((err) => fail(t('extensions.saveFailed'), err)).then(refreshExtensions),
            t('extensions.safeMode'),
          ),
        ),
      ),
    );
    if (!items.length) {
      mount(listSlot, emptyState('puzzle', t('extensions.emptyTitle'), t('extensions.emptyText')));
      return;
    }
    mount(listSlot, items.map((x) => row(x, safeMode)));
  }

  const off = onExtensions(draw);
  draw();
  const el = h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'row wrap xt-actions' },
      h('button', { class: 'btn', type: 'button', onclick: installFromFile }, icon('upload'), t('extensions.installFromFile')),
      catalogAllowed() ? null : h('span', { class: 'small muted' }, t('extensions.catalogHint')),
    ),
    safeSlot,
    listSlot,
  );
  return { el, destroy: off };
}
