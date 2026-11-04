// Recetas, wiki, contadores y asistente en el overlay: lo que le toca a la ventana principal del launcher (el resto esta
// en js/overlay/ y src/main/modules/overlay.js; ver docs/implementacion/overlay.md).
//   startup()  -> le pasa al overlay los eventos del asistente (el asistente solo le habla a esta ventana), abre las
//                 pantallas que pide un panel del overlay y suma a Ajustes > Privacidad la conexion opcional de la wiki.
import { h, icon, switchEl, fail } from '../ui.js';
import { api } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { registerSettingsCard } from '../settings-cards.js';
import { netAllowed, setNetAllowed } from './netprefs.js';

const NS = 'overlaytools';
let started = false;
let active = false;

function wikiCard() {
  const onChange = (on) => setNetAllowed({ wiki: on }).catch((err) => fail(t('overlaytools.wiki_saveError'), err));
  return h(
    'section',
    { class: 'card ovt-card', dataset: { anchor: 'overlay-wiki' } },
    h('h3', { class: 'card-title' }, icon('globe'), t('overlaytools.wiki_title')),
    h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('overlaytools.wiki_toggle')), h('div', { class: 'tr-sub' }, t('overlaytools.wiki_text'))), switchEl(netAllowed('wiki'), onChange, t('overlaytools.wiki_toggle'))),
  );
}

export async function startup() {
  if (started) return;
  started = true;
  await loadNs(NS).catch((err) => console.warn('[overlaytools] textos', err));
  registerSettingsCard('privacy', () => wikiCard());

  // Con el overlay activo, los eventos del asistente siguen hasta su panel (y a los avisos con el panel cerrado)
  api.on('overlay:state', (s) => {
    active = Boolean(s?.active);
  });
  api
    .invoke('overlay:status')
    .then((s) => {
      active = Boolean(s?.active);
    })
    .catch(() => {});
  api.on('assistant:event', (convId, ev) => {
    if (active) api.invoke('overlay:assistantEvent', convId, ev).catch(() => {});
  });

  // Un panel pidio abrir una pantalla del launcher (planes, sesion, ajustes de la IA)
  api.on('overlay:route', async (route) => {
    try {
      const { navigate } = await import('../app.js');
      navigate(route);
    } catch (err) {
      console.warn('[overlaytools] ruta', err?.message || err);
    }
  });
}
