// Ajustes > secciones que muestran paneles de otros modulos (contratos de docs/arquitectura.md):
// Apariencia y Accesibilidad (a11y) y Descargas y almacenamiento (storage). Discord Rich Presence está en
// Privacidad (general.js).
import { h } from '../../ui.js';
import { t } from '../../i18n.js';
import { sectionHead, embedPanel } from './shared.js';

function single(body, ctx, { id, iconName, load, fn, ns }) {
  const host = h('div', { class: 'cfg-embed-host' });
  body.append(sectionHead(id, iconName), host);
  embedPanel(host, { load, fn, ns }, ctx);
}

export function renderAppearance(body, ctx) {
  single(body, ctx, { id: 'appearance', iconName: 'palette', load: () => import('../../appearance.js'), fn: 'appearancePanel', ns: ['appearance', 'a11y'] });
}

export function renderA11y(body, ctx) {
  single(body, ctx, { id: 'a11y', iconName: 'accessibility', load: () => import('../../a11y.js'), fn: 'accessibilityPanel', ns: ['a11y', 'appearance'] });
}

export function renderStorage(body, ctx) {
  const downloads = h('div', { class: 'cfg-embed-host', dataset: { anchor: 'downloads' } });
  const storage = h('div', { class: 'cfg-embed-host', dataset: { anchor: 'disk' } });
  body.append(sectionHead('storage', 'drive'), downloads, storage);
  const load = () => import('../../features/storage.js');
  embedPanel(downloads, { load, fn: 'downloadsPanel', ns: ['storage'], label: t('settings.storageDownloads'), iconName: 'download' }, ctx);
  embedPanel(storage, { load, fn: 'storagePanel', ns: ['storage'], label: t('settings.storageDisk'), iconName: 'drive' }, ctx);
}
