// Control remoto y avisos por Discord del servidor local. Arranca solo con el launcher para avisar lo que pasa aunque
// la página del servidor no esté abierta: un dispositivo nuevo que entró y el control remoto que se apagó solo.
// Las tarjetas están en features/serverremote/remote.js y discord.js (las usa pages/servers). Ver docs/implementacion/servidores.md.
import { toast } from '../ui.js';
import { api } from '../store.js';
import { t, loadNs } from '../i18n.js';

let started = false;

export function startup() {
  if (started) return;
  started = true;
  api.on('serverremote:changed', async (id, ev) => {
    try {
      if (ev?.kind === 'connected') {
        await loadNs('serverremote');
        toast('info', t('serverremote.toastConnected'), t('serverremote.toastConnectedText', { device: ev.device }));
      } else if (ev?.kind === 'stopped' && (ev.reason === 'expired' || ev.reason === 'network')) {
        await loadNs('serverremote');
        toast('info', t('serverremote.toastStopped'), t(`serverremote.toastStopped_${ev.reason}`));
      }
    } catch (err) {
      console.warn('[serverremote] aviso:', err?.message || err);
    }
  });
}
