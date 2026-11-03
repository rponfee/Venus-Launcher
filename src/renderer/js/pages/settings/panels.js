// Ajustes > secciones que muestran paneles de otros modulos (contratos de docs/arquitectura.md):
// Apariencia y Accesibilidad (a11y, con Temas de features/themes.js), En el juego (overlay, capture y nowplaying) y
// Descargas y almacenamiento (storage). Discord Rich Presence y Avisos están en Privacidad (general.js).
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
  // Temas compartibles y galería de la comunidad (features/themes.js)
  const themes = h('div', { class: 'cfg-embed-host', dataset: { anchor: 'themes' } });
  body.append(themes);
  embedPanel(themes, { load: () => import('../../features/themes.js'), fn: 'themesPanel', ns: ['themes'] }, ctx);
}

// En el juego: overlay (features/overlay.js), grabación y capturas (features/capture.js) y música (features/nowplaying.js)
export function renderIngame(body, ctx) {
  const overlay = h('div', { class: 'cfg-embed-host', dataset: { anchor: 'overlay' } });
  const capture = h('div', { class: 'cfg-embed-host', dataset: { anchor: 'capture' } });
  const music = h('div', { class: 'cfg-embed-host', dataset: { anchor: 'music' } });
  body.append(sectionHead('ingame', 'gamepad'), overlay, capture, music);
  embedPanel(overlay, { load: () => import('../../features/overlay.js'), fn: 'overlayPanel', ns: ['overlay'] }, ctx);
  embedPanel(capture, { load: () => import('../../features/capture.js'), fn: 'capturePanel', ns: ['capture'] }, ctx);
  embedPanel(music, { load: () => import('../../features/nowplaying.js'), fn: 'nowPlayingPanel', ns: ['nowplaying'] }, ctx);
}

export function renderA11y(body, ctx) {
  single(body, ctx, { id: 'a11y', iconName: 'accessibility', load: () => import('../../a11y.js'), fn: 'accessibilityPanel', ns: ['a11y', 'appearance'] });
}

export function renderStorage(body, ctx) {
  const downloads = h('div', { class: 'cfg-embed-host', dataset: { anchor: 'downloads' } });
  // Descargas programadas (features/tools/schedule.js, 3.1): franja horaria en la que bajan las descargas
  const schedule = h('div', { class: 'cfg-embed-host', dataset: { anchor: 'schedule' } });
  const storage = h('div', { class: 'cfg-embed-host', dataset: { anchor: 'disk' } });
  // Estado de los servicios (features/svcstatus.js): ¿es tu conexión o un servicio caído?
  const services = h('div', { class: 'cfg-embed-host', dataset: { anchor: 'services' } });
  body.append(sectionHead('storage', 'drive'), downloads, schedule, services, storage);
  const load = () => import('../../features/storage.js');
  embedPanel(downloads, { load, fn: 'downloadsPanel', ns: ['storage'], label: t('settings.storageDownloads'), iconName: 'download' }, ctx);
  embedPanel(schedule, { load: () => import('../../features/tools/schedule.js'), fn: 'schedulePanel', ns: ['tools'] }, ctx);
  embedPanel(services, { load: () => import('../../features/svcstatus.js'), fn: 'statusCard', ns: ['svcstatus'] }, ctx);
  embedPanel(storage, { load, fn: 'storagePanel', ns: ['storage'], label: t('settings.storageDisk'), iconName: 'drive' }, ctx);
}
