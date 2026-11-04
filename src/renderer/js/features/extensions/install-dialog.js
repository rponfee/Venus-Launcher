// Diálogo de instalación: resumen de permisos en lenguaje claro antes de escribir nada. Los textos que vienen de la
// extensión se dibujan como texto. Lo que viene de un archivo suelto lleva un aviso fuerte y una casilla obligatoria.
// openInstallDialog(resumen) -> Promise<vista instalada o null>. resumen es lo que devuelve extensions:inspect*.
import { h, icon, modal, ok, fail, setBusy, switchEl, fmtBytes } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { permRow, neverBlock } from './perms.js';

export function openInstallDialog(sum) {
  return new Promise((resolve) => {
    const m = sum.manifest;
    const isUpdate = Boolean(sum.installed);
    const added = new Set(sum.addedPermissions || []);
    const fromFile = sum.source !== 'catalog';
    // La tarjeta en Inicio se acepta aparte: arranca apagada y una actualización respeta lo que había.
    let homeCard = Boolean(m.homeCard && sum.installed?.homeCardEnabled);
    let risk = !fromFile;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const installBtn = h('button', { class: 'btn primary', type: 'button', disabled: !risk || !sum.launcherOk }, icon('download'), t(isUpdate ? 'extensions.updateAction' : 'extensions.installAction'));
    const riskRow = fromFile
      ? h(
          'label',
          { class: 'xt-check' },
          h('input', {
            type: 'checkbox',
            onchange: (e) => {
              risk = e.target.checked;
              installBtn.disabled = !risk || !sum.launcherOk;
            },
          }),
          h('span', {}, t('extensions.localRiskAccept')),
        )
      : null;

    const body = h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'xt-sum-head' },
        h('div', { class: 'xt-sum-name selectable' }, m.name),
        h('div', { class: 'small muted selectable' }, t('extensions.versionBy', { version: m.version, author: m.author })),
        m.description ? h('p', { class: 'text-2 selectable xt-sum-desc' }, m.description) : null,
      ),
      fromFile
        ? h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, h('strong', {}, t('extensions.localRiskTitle')), h('div', { class: 'small' }, t('extensions.localRiskText'))))
        : h('div', { class: 'notice info' }, icon('shieldCheck'), h('div', { class: 'small' }, t('extensions.catalogReviewed'))),
      !sum.launcherOk ? h('div', { class: 'notice bad' }, icon('alert'), t('extensions.launcherOld', { version: m.minLauncherVersion })) : null,
      isUpdate ? h('div', { class: 'notice info' }, icon('refresh'), t('extensions.updateFrom', { from: sum.installed.version, to: m.version })) : null,
      added.size && isUpdate ? h('div', { class: 'notice bad' }, icon('alert'), t('extensions.newPermsWarn')) : null,
      h('div', { class: 'label' }, m.permissions.length ? t('extensions.permsAsk') : t('extensions.permsNone')),
      m.permissions.length ? h('div', { class: 'xt-perms' }, m.permissions.map((p) => permRow(p, { isNew: isUpdate && added.has(p) }))) : null,
      m.homeCard
        ? h(
            'div',
            { class: 'toggle-row' },
            h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('extensions.homeCardAsk')), h('div', { class: 'tr-sub' }, t('extensions.homeCardAskText'))),
            switchEl(
              homeCard,
              (on) => {
                homeCard = on;
              },
              t('extensions.homeCardAsk'),
            ),
          )
        : null,
      neverBlock(),
      h('p', { class: 'small muted' }, t(isUpdate ? 'extensions.keepsState' : 'extensions.startsOff')),
      h('div', { class: 'small muted selectable xt-sha', title: sum.sha256 }, t('extensions.pkgInfo', { size: fmtBytes(sum.size), count: sum.fileCount, sha: `${sum.sha256.slice(0, 16)}…` })),
      riskRow,
    );

    const dlg = modal({
      title: t(isUpdate ? 'extensions.updateTitle' : 'extensions.installTitle'),
      subtitle: t('extensions.communityTag'),
      icon: 'puzzle',
      body,
      footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => dlg.close() }, t('extensions.cancel')), installBtn],
      onClose: () => finish(null),
    });

    installBtn.addEventListener('click', async () => {
      const release = setBusy(installBtn);
      try {
        const view = await api.invoke('extensions:install', sum.stageId, { accepted: [...m.permissions], homeCard });
        ok(t(isUpdate ? 'extensions.updatedOk' : 'extensions.installedOk', { name: view.name }), isUpdate ? '' : t('extensions.installedOkText'));
        finish(view);
        dlg.close();
      } catch (err) {
        fail(t('extensions.installFailed'), err);
        release();
      }
    });
  });
}
