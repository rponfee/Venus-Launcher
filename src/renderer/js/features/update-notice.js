// Aviso de versión nueva en la edición portable y en macOS, que no se actualizan solas (modules/updater): una sola vez por
// versión (settings.updater.noticed). Solo aparece si el launcher buscó por su cuenta, es decir, con la búsqueda
// automática activada en Ajustes > Privacidad. Contrato: startup().
import { confirmDialog, fail } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { whenFree } from './whatsnew.js';

let started = false;

async function notice(state) {
  if (state?.status !== 'available' || !state.portable || !state.downloadUrl) return;
  if (store.settings?.updater?.noticed === state.version) return;
  await whenFree();
  if (store.settings?.updater?.noticed === state.version) return;
  store.setSettings({ updater: { noticed: state.version } }).catch((err) => console.warn('[update-notice]', err?.message || err));
  await loadNs('updates');
  const text = t(state.edition === 'mac' ? 'updates.noticeTextMac' : 'updates.noticeText');
  const go = await confirmDialog(t('updates.noticeTitle', { version: state.version }), text, { okText: t('updates.download'), cancelText: t('updates.noticeLater') });
  if (!go) return;
  api.app.openExternal(state.downloadUrl).catch((err) => fail(t('updates.openError'), err));
}

export function startup() {
  if (started) return;
  started = true;
  const info = store.info || {};
  if (info.skipOnboarding || info.devshot) return;
  api.on('updater:state', (state) => notice(state).catch((err) => console.warn('[update-notice]', err?.message || err)));
}
