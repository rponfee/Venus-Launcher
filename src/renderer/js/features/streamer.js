// Modo streamer (settings.privacy.streamer): mientras esta activado, el launcher esconde lo que no conviene
// mostrar en un directo o una grabacion. Se enciende en Ajustes > Privacidad, en Ctrl+K ("Modo streamer") o
// con el indicador de la barra de titulo, y se guarda entre sesiones.
//   - En la interfaz: <body class="streamer"> difumina lo marcado con .priv (codigos de amigo y de pack, codigos
//     de sala, direcciones IP y de servidores, nombres de amigos y mensajes) y los toasts pasan por maskText().
//   - En el overlay del juego y en Discord Rich Presence lo aplica el proceso principal (modules/streamer.js).
// Contrato: startup() (idempotente), isStreamer() -> bool, setStreamer(on) -> Promise, toggleStreamer().
import { h, icon, ok, fail, mount, setTextFilter } from '../ui.js';
import { store } from '../store.js';
import { t, loadNs, onLanguageChange } from '../i18n.js';
import { navigate } from '../app.js';
import { maskText } from './streamer/mask.js';

export const isStreamer = () => store.settings?.privacy?.streamer === true;

export async function setStreamer(on) {
  const next = Boolean(on);
  if (isStreamer() === next) return next;
  try {
    await store.setSettings({ privacy: { streamer: next } });
    await loadNs('common');
    ok(t(next ? 'common.streamerOn' : 'common.streamerOff'), next ? t('common.streamerOnText') : undefined);
  } catch (err) {
    fail(t('common.streamerSaveError'), err);
  }
  return isStreamer();
}

export const toggleStreamer = () => setStreamer(!isStreamer());

function paint() {
  const on = isStreamer();
  document.body.classList.toggle('streamer', on);
  setTextFilter(on ? maskText : null);
  const pill = document.getElementById('tb-streamer');
  if (!pill) return;
  pill.hidden = !on;
  if (on) {
    mount(pill, icon('eyeOff'), h('span', {}, t('common.streamerIndicator')));
    pill.title = t('common.streamerIndicatorTitle');
    pill.setAttribute('aria-label', t('common.streamerIndicatorTitle'));
  }
}

let started = false;
export async function startup() {
  if (started) return paint();
  started = true;
  await loadNs('common').catch(() => {});
  document.getElementById('tb-streamer')?.addEventListener('click', () => navigate('settings/privacy/streamer'));
  store.on('settings', paint);
  onLanguageChange(() => loadNs('common').then(paint).catch(() => {}));
  if (!store.settings) await store.refreshSettings().catch(() => null);
  paint();
  try {
    const { registerCommands } = await import('../a11y.js');
    registerCommands(() => [
      {
        id: 'streamer.toggle',
        title: t('common.streamerCmd'),
        sub: t('common.streamerCmdSub'),
        group: 'actions',
        icon: 'eyeOff',
        keywords: t('common.streamerCmdKeywords'),
        state: isStreamer(),
        run: () => toggleStreamer(),
      },
    ]);
  } catch (err) {
    console.warn('[streamer] paleta', err?.message || err);
  }
}
