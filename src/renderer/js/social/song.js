// Cancion del perfil (3.1): reproductor chico en la tarjeta publica (play/pausa, volumen, silenciar) con el
// interruptor "No reproducir canciones de perfil" (settings.social.profileSongs, true por defecto). Arranca sola solo
// para los amigos del dueño (profile_public devuelve song solo a ellos) si el que mira lo permite.
//   songPlayer(song, { name, autoplay }) -> Element con .destroy(); stopSongs() frena lo que suene.
import { h, icon, mount, switchEl } from '../ui.js';
import { t } from '../i18n.js';
import { store } from '../store.js';
import { isProfileAudioUrl } from '../features/profile-editor/model.js';
import { volumeStep } from './logic.js';

const players = new Set();
let volume = 0.6;

export const songsAllowed = () => store.settings?.social?.profileSongs !== false;

export async function setSongsAllowed(on) {
  try {
    await store.setSettings({ social: { profileSongs: Boolean(on) } });
  } catch (err) {
    console.warn('[profile] ajuste de canciones:', err?.message || err);
  }
  if (!on) stopSongs();
}

export function stopSongs() {
  for (const p of [...players]) p.destroy();
}

export function songPlayer(song, { name = '', autoplay = false } = {}) {
  if (!song || !isProfileAudioUrl(song.url)) return null;
  stopSongs(); // una sola cancion a la vez
  const audio = new Audio();
  audio.preload = 'auto';
  audio.volume = volume;
  audio.src = song.url;
  const title = song.title || t('profile.songUntitled');
  const playBtn = h('button', { class: 'icon-btn sm pf-song-play', type: 'button' }, icon('play'));
  const muteBtn = h('button', { class: 'icon-btn sm', type: 'button' }, icon('volume'));
  const range = h('input', { type: 'range', class: 'pf-song-vol', min: 0, max: 100, step: 5, value: Math.round(volume * 100), 'aria-label': t('profile.songVolume') });
  const bar = h('div', { class: 'pf-song-bar', 'aria-hidden': 'true' }, h('i'));
  const note = h('div', { class: 'pf-song-note', hidden: true }, t('profile.songNoAutoHint'));
  const toggle = switchEl(!songsAllowed(), (v) => {
    setSongsAllowed(!v);
    note.hidden = !v;
  }, t('profile.songNoAuto'));
  const el = h(
    'div',
    { class: 'pf-song', role: 'group', 'aria-label': name ? t('profile.songOf', { name }) : title },
    h('div', { class: 'pf-song-row' }, playBtn, h('div', { class: 'pf-song-main' }, h('div', { class: 'pf-song-title ellipsis', title }, icon('music'), h('span', {}, title)), bar), muteBtn, range),
    h('div', { class: 'pf-song-opt' }, h('span', {}, t('profile.songNoAuto')), toggle),
    note,
  );
  const sync = () => {
    const playing = !audio.paused && !audio.ended;
    mount(playBtn, icon(playing ? 'pause' : 'play'));
    playBtn.title = playBtn.ariaLabel = t(playing ? 'profile.songPause' : 'profile.songPlay');
    mount(muteBtn, icon(audio.muted || audio.volume === 0 ? 'volumeX' : 'volume'));
    muteBtn.title = muteBtn.ariaLabel = t(audio.muted ? 'profile.songUnmute' : 'profile.songMute');
    el.classList.toggle('playing', playing);
  };
  playBtn.addEventListener('click', () => {
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });
  muteBtn.addEventListener('click', () => {
    audio.muted = !audio.muted;
    sync();
  });
  range.addEventListener('input', () => {
    volume = Number(range.value) / 100;
    audio.volume = volume;
    audio.muted = false;
    sync();
  });
  el.addEventListener('keydown', (e) => {
    if (e.target !== range || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    volume = volumeStep(volume, e.key === 'ArrowUp' ? 1 : -1);
    range.value = String(Math.round(volume * 100));
    audio.volume = volume;
    sync();
  });
  audio.addEventListener('timeupdate', () => {
    const k = audio.duration > 0 ? audio.currentTime / audio.duration : 0;
    bar.firstChild.style.width = `${Math.round(k * 100)}%`;
  });
  for (const ev of ['play', 'pause', 'ended', 'volumechange']) audio.addEventListener(ev, sync);
  audio.addEventListener('error', () => {
    el.classList.add('failed');
    playBtn.disabled = true;
  });
  const player = {
    destroy() {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      players.delete(player);
      el.remove();
    },
  };
  players.add(player);
  // Si la tarjeta se cierra, la cancion para sola
  const mo = new MutationObserver(() => {
    if (!el.isConnected && players.has(player)) {
      mo.disconnect();
      player.destroy();
    }
  });
  setTimeout(() => el.isConnected && mo.observe(document.body, { childList: true, subtree: true }), 0);
  el.destroy = player.destroy;
  sync();
  if (autoplay && songsAllowed()) setTimeout(() => el.isConnected && audio.play().catch(() => {}), 150);
  return el;
}
