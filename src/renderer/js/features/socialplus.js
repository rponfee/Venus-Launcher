// Stickers, traducción de mensajes, soundboard y efectos de voz (3.3). Lo que arranca solo: los textos y la tarjeta de
// Ajustes > Privacidad de la traducción. Los stickers y la traducción se dibujan en pages/messages/plus.js; el soundboard y
// los efectos, en voice/.
import { registerSettingsCard } from '../settings-cards.js';
import { loadNs } from '../i18n.js';
import { translatePrivacyCard } from './socialplus/translate-state.js';

let started = false;

export function startup() {
  if (started) return;
  started = true;
  loadNs('socialplus').catch(() => {});
  registerSettingsCard('privacy', () => translatePrivacyCard());
}
