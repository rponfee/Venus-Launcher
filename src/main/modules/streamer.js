'use strict';
// Modo streamer (settings.privacy.streamer): mientras esta activado, el launcher esconde lo que no conviene
// mostrar en un directo o una grabacion: codigos de amigo y de pack, direcciones IP y de servidores, nombres
// de amigos y el contenido de los mensajes. Lo aplican:
//   - el overlay del juego (overlay.js pasa cada evento por maskEvent antes de mostrarlo),
//   - Discord Rich Presence (sin mundo ni servidor mientras esta activado),
//   - la interfaz (features/streamer.js: difumina lo marcado con .priv, tapa los toasts y el indicador de la barra).
// Sin canales propios: la interfaz lee y cambia settings.privacy.streamer. Este modulo avisa por el overlay
// cuando cambia durante una partida (el launcher suele estar minimizado) y expone isOn() a los otros modulos.
const mask = require('./streamer/mask');

let on = false;

const isOn = () => on;

function register({ onQuit }) {
  const settings = require('../core/settings');
  const read = (s) => s?.privacy?.streamer === true;
  settings
    .get()
    .then((s) => {
      on = read(s);
    })
    .catch(() => {});
  const off = settings.onChange((s, patch) => {
    if (!patch?.privacy || !('streamer' in patch.privacy)) return;
    const next = read(s);
    if (next === on) return;
    on = next;
    if (!on) mask.resetAliases();
    try {
      const overlay = require('./overlay');
      const { t } = require('../core/i18n');
      overlay.onStreamerChange?.(on);
      if (overlay.status().running) overlay.push({ kind: 'alert', icon: 'info', title: t(on ? 'overlay.streamerOnTitle' : 'overlay.streamerOffTitle'), body: on ? t('overlay.streamerOnBody') : undefined });
    } catch (err) {
      console.warn('[streamer] overlay', err?.message || err);
    }
  });
  onQuit?.(() => off());
}

module.exports = { register, isOn, maskText: mask.maskText, maskEvent: mask.maskEvent };
