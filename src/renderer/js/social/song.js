// Cancion de perfil: reproductor chico en la tarjeta publica (play/pausa, volumen, silenciar) con la atribucion de la
// cancion (titulo, autor, licencia y enlace a la fuente) y el interruptor "No reproducir canciones de perfil"
// (settings.social.profileSongs, true por defecto). Desde la 4.6 la cancion se elige de Openverse (musica libre de Jamendo
// y Wikimedia Commons): el audio se reproduce directo desde ese sitio, el tramo de cardStyle.song { start, len } y solo
// si la persona activo la musica de perfil en Ajustes > Privacidad (settings.profileMusic.enabled). Arranca sola solo
// para los amigos del dueño (profile_public devuelve song solo a ellos) si el que mira lo permite y no esta jugando.
//   songPlayer(song, { name, autoplay }) -> Element con .destroy(), o null si la cancion no es valida; stopSongs() frena lo que suene.
import { h, icon, mount, switchEl } from '../ui.js';
import { t, loadNs } from '../i18n.js';
import { store } from '../store.js';
import { normalizeSong, playableWindow, clipProgress, gameBusy } from '../features/profile-editor/music-logic.js';
import { attributionEl, enableNotice, musicEnabled, ensureMusicCss, M } from '../features/profile-editor/music-ui.js';
import { volumeStep } from './logic.js';

await loadNs('profilemusic').catch(() => {});

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

export function songPlayer(rawSong, { name = '', autoplay = false } = {}) {
  const song = normalizeSong(rawSong); // la direccion del audio viene de otra persona: solo vale si pasa por aca
  if (!song) return null;
  ensureMusicCss();
  stopSongs(); // una sola cancion a la vez
  const title = song.title || t('profile.songUntitled');
  const el = h('div', { class: 'pf-song', role: 'group', 'aria-label': name ? t('profile.songOf', { name }) : title });
  const credit = attributionEl(song, { cls: 'pf-song-credit', withTitle: false }); // el titulo ya se ve arriba, en el reproductor
  let audio = null;
  let win = { start: song.start, len: song.len };
  let offStore = null;
  let drawnOn = null;
  // Si se activa o desactiva la conexion mientras la tarjeta esta abierta, se redibuja (desde Ajustes o desde el editor)
  const offSettings = store.on('settings', () => {
    if (!el.isConnected) return; // todavia no se monto, o ya se cerro (ahi lo limpia el observador de abajo)
    if (musicEnabled() !== drawnOn) draw();
  });

  const player = {
    destroy() {
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        audio = null;
      }
      offStore?.();
      offStore = null;
      offSettings();
      players.delete(player);
      el.remove();
    },
  };
  players.add(player);

  // Sin la conexion activada no se toca ningun sitio de afuera: solo se ve la atribucion y el boton para activarla
  function drawOff() {
    mount(
      el,
      h('div', { class: 'pf-song-row' }, h('div', { class: 'pf-song-main' }, h('div', { class: 'pf-song-title ellipsis', title }, icon('music'), h('span', {}, title)))),
      credit,
      enableNotice(() => draw(), { compact: true }),
    );
  }

  function drawOn() {
    audio = new Audio();
    // Sin autoplay no se pide nada hasta que la persona toca play (la vista previa del editor se redibuja a cada cambio)
    let wantAuto = autoplay && songsAllowed() && !gameBusy(store.running);
    audio.preload = wantAuto ? 'auto' : 'none';
    audio.volume = volume;
    audio.src = song.url;
    const playBtn = h('button', { class: 'icon-btn sm pf-song-play', type: 'button' }, icon('play'));
    const muteBtn = h('button', { class: 'icon-btn sm', type: 'button' }, icon('volume'));
    const range = h('input', { type: 'range', class: 'pf-song-vol', min: 0, max: 100, step: 5, value: Math.round(volume * 100), 'aria-label': t('profile.songVolume') });
    const bar = h('div', { class: 'pf-song-bar', 'aria-hidden': 'true' }, h('i'));
    const note = h('div', { class: 'pf-song-note', hidden: true }, t('profile.songNoAutoHint'));
    const gameNote = h('div', { class: 'pf-song-note', role: 'status', hidden: true }, icon('gamepad'), M('gamePaused'));
    const failNote = h('div', { class: 'pf-song-note', role: 'status', hidden: true }, icon('alert'), M('playFailed'));
    const toggle = switchEl(!songsAllowed(), (v) => {
      setSongsAllowed(!v);
      note.hidden = !v;
    }, t('profile.songNoAuto'));
    mount(
      el,
      h('div', { class: 'pf-song-row' }, playBtn, h('div', { class: 'pf-song-main' }, h('div', { class: 'pf-song-title ellipsis', title }, icon('music'), h('span', {}, title)), bar), muteBtn, range),
      credit,
      h('div', { class: 'pf-song-opt' }, h('span', {}, t('profile.songNoAuto')), toggle),
      note,
      gameNote,
      failNote,
    );
    const sync = () => {
      if (!audio) return;
      const playing = !audio.paused && !audio.ended;
      mount(playBtn, icon(playing ? 'pause' : 'play'));
      playBtn.title = playBtn.ariaLabel = t(playing ? 'profile.songPause' : 'profile.songPlay');
      mount(muteBtn, icon(audio.muted || audio.volume === 0 ? 'volumeX' : 'volume'));
      muteBtn.title = muteBtn.ariaLabel = t(audio.muted ? 'profile.songUnmute' : 'profile.songMute');
      el.classList.toggle('playing', playing);
    };
    const toStart = () => {
      try {
        audio.currentTime = win.start;
      } catch {
        /* todavia no se puede mover */
      }
    };
    playBtn.addEventListener('click', () => {
      if (!audio) return;
      if (audio.paused) {
        if (audio.currentTime < win.start || audio.currentTime >= win.start + win.len) toStart();
        audio.play().catch(() => {});
      } else audio.pause();
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
      if (audio) audio.volume = volume;
      sync();
    });
    // El tramo: arranca en start, suena len segundos y se detiene (con la duracion real del archivo a mano se acomoda)
    audio.addEventListener('loadedmetadata', () => {
      win = playableWindow(song, audio.duration);
      toStart();
      if (wantAuto) {
        wantAuto = false;
        if (audio.paused && !gameBusy(store.running)) audio.play().catch(() => {});
      }
    });
    audio.addEventListener('timeupdate', () => {
      if (audio.currentTime >= win.start + win.len) {
        audio.pause();
        toStart();
      }
      bar.firstChild.style.width = `${Math.round(clipProgress(audio.currentTime, win.start, win.len) * 100)}%`;
    });
    for (const ev of ['play', 'pause', 'ended', 'volumechange']) audio.addEventListener(ev, sync);
    audio.addEventListener('error', () => {
      el.classList.add('failed');
      playBtn.disabled = true;
      failNote.hidden = false;
    });
    // Pausa en juego: mientras Minecraft esta abierto (o abriendose) la cancion se detiene y no arranca sola
    const onRunning = () => {
      const busy = gameBusy(store.running);
      gameNote.hidden = !busy;
      if (busy && audio && !audio.paused) audio.pause();
    };
    offStore = store.on('running', onRunning);
    onRunning();
    sync();
    if (wantAuto) audio.load();
  }

  function draw() {
    offStore?.();
    offStore = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audio = null;
    }
    drawnOn = musicEnabled();
    if (drawnOn) drawOn();
    else drawOff();
  }

  // Si la tarjeta se cierra, la cancion para sola
  const mo = new MutationObserver(() => {
    if (!el.isConnected && players.has(player)) {
      mo.disconnect();
      player.destroy();
    }
  });
  setTimeout(() => el.isConnected && mo.observe(document.body, { childList: true, subtree: true }), 0);
  el.destroy = player.destroy;
  draw();
  return el;
}
