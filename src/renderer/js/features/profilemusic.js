// Musica de perfil (4.6): tarjeta de Ajustes > Privacidad con el interruptor de la conexion opcional.
// La cancion de un perfil se busca en Openverse (api.openverse.org) y suena desde Jamendo o Wikimedia Commons: mientras
// el interruptor este apagado (por defecto) no se contacta a ninguno de esos sitios, ni para buscar ni para escuchar.
// La busqueda y la pestaña del editor estan en features/profile-editor/music.js; el reproductor, en social/song.js.
import { h, icon, ok, fail, mount } from '../ui.js';
import { api } from '../store.js';
import { loadNs } from '../i18n.js';
import { registerSettingsCard } from '../settings-cards.js';
import { card, toggleRow } from '../pages/settings/shared.js';
import { M, musicEnabled, setMusicEnabled } from './profile-editor/music-ui.js';

let started = false;

export async function startup() {
  if (started) return;
  started = true;
  await loadNs('profilemusic').catch(() => {});
  registerSettingsCard('privacy', () => privacyCard());
}

function privacyCard() {
  const usage = h('p', { class: 'small muted pm-usage', role: 'status' });
  const paintUsage = async () => {
    try {
      const s = await api.invoke('profilemusic:status');
      mount(usage, M('cardUsage', { used: s.usedToday, max: s.limits.perDay, cached: s.cached }));
    } catch {
      mount(usage, []);
    }
  };
  const clear = h('button', { class: 'btn sm', type: 'button' }, icon('trash'), M('cardClear'));
  clear.addEventListener('click', async () => {
    try {
      await api.invoke('profilemusic:clearCache');
      ok(M('cardCleared'));
      paintUsage();
    } catch (err) {
      fail(M('cardClearFailed'), err);
    }
  });
  const row = toggleRow({
    title: M('cardSwitch'),
    sub: M('cardText'),
    checked: musicEnabled(),
    onChange: async (on) => {
      try {
        await setMusicEnabled(on);
        ok(M(on ? 'cardOn' : 'cardOff'));
      } catch (err) {
        fail(M('saveFailed'), err);
      }
    },
  });
  paintUsage();
  return card({ title: M('cardTitle'), iconName: 'music', anchor: 'profilemusic' }, row, h('p', { class: 'small muted' }, M('cardHosts')), usage, h('div', { class: 'row wrap' }, clear));
}
