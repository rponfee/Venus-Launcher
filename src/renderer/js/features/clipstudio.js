// Estudio de clips: montaje, timelapse, subir clips, OBS y galeria publica. Lo que corre con el launcher abierto aunque no se
// abra la pagina de Clips: tarjetas de Ajustes (OBS, timelapse y cuentas para subir).
// Las ventanas estan en features/clipstudio/ y la galeria en pages/clips/gallery.js. Guia: docs/implementacion/clips.md.
//   startup()
import { h, icon, ensureCss, mount, fail, ok, confirmDialog, setBusy } from '../ui.js';
import { api } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { navigate } from '../app.js';
import { registerSettingsCard } from '../settings-cards.js';
import './clipstudio/icons.js';
import { obsPanel } from './clipstudio/obs-panel.js';

const C = (key, vars) => t(`clipstudio.${key}`, vars);
let started = false;

// Tarjeta del timelapse: el ajuste es por instancia y vive en su dialogo
function timelapseCard() {
  return h(
    'section',
    { class: 'card cs-card', dataset: { anchor: 'timelapse' } },
    h('div', { class: 'cap-head' }, h('div', { class: 'cap-logo', 'aria-hidden': 'true' }, icon('clock')), h('div', { class: 'cap-head-text' }, h('div', { class: 'card-title' }, C('timelapseTitle')), h('div', { class: 'cap-sub' }, C('timelapseCardText')))),
    h(
      'div',
      { class: 'row wrap' },
      h(
        'button',
        {
          class: 'btn sm',
          type: 'button',
          onclick: async () => {
            try {
              const { openTimelapse } = await import('./clipstudio/timelapse.js');
              openTimelapse({});
            } catch (err) {
              fail(C('openFailed'), err);
            }
          },
        },
        icon('settings'),
        C('timelapseConfigure'),
      ),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => navigate('clips') }, icon('image'), C('openClips')),
    ),
  );
}

// Cuentas conectadas para subir clips. Sin los identificadores de las aplicaciones no se muestra nada.
function uploadCard(ctx) {
  const host = h('div', { class: 'cs-slot', dataset: { anchor: 'upload' } });
  async function draw() {
    let st = null;
    try {
      st = await api.invoke('clipupload:status');
    } catch (err) {
      console.warn('[clipstudio] subir:', err?.message || err);
    }
    if (!ctx.alive()) return;
    const list = ['youtube', 'tiktok'].filter((p) => st?.[p]?.configured);
    if (!list.length) return mount(host);
    mount(
      host,
      h(
        'section',
        { class: 'card cs-card' },
        h('div', { class: 'cap-head' }, h('div', { class: 'cap-logo', 'aria-hidden': 'true' }, icon('upload')), h('div', { class: 'cap-head-text' }, h('div', { class: 'card-title' }, C('accountsTitle')), h('div', { class: 'cap-sub' }, C('accountsText')))),
        list.map((p) => {
          const name = C(`provider_${p}`);
          const connected = st[p].connected;
          const btn = h('button', { class: 'btn sm', type: 'button' }, icon(connected ? 'csLogOut' : 'logIn'), connected ? C('revokeOk') : C('connect', { name }));
          btn.addEventListener('click', async () => {
            if (connected && !(await confirmDialog(C('revokeTitle'), C('revokeText', { name }), { okText: C('revokeOk'), danger: true }))) return;
            const done = setBusy(btn);
            try {
              await api.invoke(connected ? 'clipupload:revoke' : 'clipupload:connect', p);
              ok(connected ? C('revokeDone') : C('connectDone', { name }));
            } catch (err) {
              if (err?.code !== 'cancelled') fail(connected ? C('revokeFailed') : C('connectFailed'), err);
            } finally {
              done();
            }
            draw();
          });
          return h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, name), h('div', { class: 'tr-sub' }, connected ? C('accountConnected') : C('accountNotConnected'))), btn);
        }),
      ),
    );
    return null;
  }
  draw();
  return host;
}

export function startup() {
  if (started) return;
  started = true;
  ensureCss('features/clipstudio');
  const ready = loadNs('clipstudio').catch((err) => console.warn('[clipstudio] textos', err));
  // Las tarjetas se registran ya (Ajustes puede abrirse enseguida) y se dibujan cuando estan los textos
  const slot = (build) =>
    registerSettingsCard('ingame', (ctx) => {
      const host = h('div', { class: 'cs-slot' });
      ready.then(() => {
        if (ctx.alive()) mount(host, build(ctx));
      });
      return host;
    });
  slot(() => timelapseCard());
  slot((ctx) => uploadCard(ctx));
  slot(() => obsPanel());

}
