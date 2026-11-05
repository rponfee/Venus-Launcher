// Piezas de interfaz que comparten la tarjeta de perfil (social/song.js) y la pestaña Musica del editor
// (features/profile-editor/music.js): la atribucion de la cancion (titulo, autor, licencia con enlace a la fuente) y
// el interruptor de la conexion. Textos en el namespace profilemusic.
import { h, icon, ensureCss, fail } from '../../ui.js';
import { t } from '../../i18n.js';
import { store } from '../../store.js';
import { licenseLabel, songSource, normalizeSong } from './music-logic.js';

export const M = (k, vars) => t(`profilemusic.${k}`, vars);

// Conexion opcional (Ajustes > Privacidad): sin activar no se busca ni se reproduce nada de afuera
export const musicEnabled = () => store.settings?.profileMusic?.enabled === true;
export function setMusicEnabled(on) {
  return store.setSettings({ profileMusic: { enabled: Boolean(on) } });
}

export const ensureMusicCss = () => ensureCss('features/profilemusic');

// Texto de la licencia: "CC BY-SA 4.0", "CC0 1.0" o "Dominio publico 1.0"
export function licenseText(license, version) {
  return license === 'pdm' ? M('licensePdm') : licenseLabel(license, version);
}
export const sourceName = (source) => (source === 'wikimedia' ? M('sourceWikimedia') : M('sourceJamendo'));

// Enlace que abre el navegador del sistema. Solo se usa con direcciones que ya pasaron por normalizeSong.
export function externalLink(url, text, { cls = '', label } = {}) {
  const open = () => window.venus?.app?.openExternal?.(url);
  const a = h('a', { class: ['pm-link', cls], role: 'link', tabindex: '0', title: url, 'aria-label': label || undefined }, text);
  a.addEventListener('click', (e) => (e.preventDefault(), open()));
  a.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), open());
  });
  return a;
}

/**
 * Atribucion de una cancion: “Titulo” de Autor · CC BY-SA 4.0 · Jamendo. Todo es texto; los enlaces llevan a la pagina
 * de la pista (landing) y al texto de la licencia. song: lo guardado en cardStyle.song (se vuelve a validar).
 */
export function attributionEl(rawSong, { cls = '', withTitle = true } = {}) {
  const song = normalizeSong(rawSong);
  if (!song) return null;
  const source = songSource(song.url);
  const sep = () => h('span', { class: 'pm-dot', 'aria-hidden': 'true' }, '·');
  return h(
    'div',
    { class: ['pm-credit', cls] },
    withTitle ? externalLink(song.landing, `“${song.title}”`, { cls: 'pm-credit-title', label: M('openSource', { source: sourceName(source) }) }) : null,
    h('span', { class: 'pm-creator' }, song.creator ? M('attrBy', { creator: song.creator }) : M('creatorUnknown')),
    sep(),
    externalLink(song.licenseUrl, licenseText(song.license, song.licenseVersion), { cls: 'pm-license', label: M('openLicense') }),
    sep(),
    externalLink(song.landing, sourceName(source), { cls: 'pm-source', label: M('openSource', { source: sourceName(source) }) }),
  );
}

/** Aviso con boton para activar la conexion (lo usan la pestaña del editor y la tarjeta) */
export function enableNotice(onEnabled, { compact = false } = {}) {
  const btn = h('button', { class: 'btn sm primary', type: 'button' }, icon('wifi'), M('enable'));
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await setMusicEnabled(true);
      onEnabled?.();
    } catch (err) {
      btn.disabled = false;
      fail(M('saveFailed'), err);
    }
  });
  return h(
    'div',
    { class: ['notice', 'info', 'pm-optin', compact && 'compact'] },
    icon('shieldCheck'),
    h('div', { class: 'pm-optin-text' }, h('strong', {}, M('optinTitle')), h('div', { class: 'small' }, compact ? M('optinPlay') : M('optinText'))),
    btn,
  );
}
