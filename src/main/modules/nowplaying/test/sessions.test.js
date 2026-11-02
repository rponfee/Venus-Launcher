'use strict';
// Elección de la sesión, nombres de apps, mezclador y estado para el overlay.
const test = require('node:test');
const assert = require('node:assert/strict');
const { appInfo, chooseSession, matchAudio, audioSummary, trackTiming, buildState, positionNow, stateChanged, sourcesList } = require('../sessions');
const { session } = require('./helpers');

const spotify = (over) => session({ id: 'Spotify.exe', app: 'Spotify.exe', ...over });
const chrome = (over) => session({ id: 'Chrome', app: 'Chrome', title: 'Video', ...over });
const edge = (over) => session({ id: 'MSEdge', app: 'MSEdge', title: 'Otro', ...over });

test('appInfo: apps conocidas, de la Tienda y desconocidas', () => {
  assert.deepEqual(appInfo('Spotify.exe'), { appName: 'Spotify', source: 'spotify' });
  assert.deepEqual(appInfo('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'), { appName: 'Spotify', source: 'spotify' });
  assert.deepEqual(appInfo('Chrome'), { appName: 'Google Chrome', source: 'browser' });
  assert.deepEqual(appInfo('MSEdge'), { appName: 'Microsoft Edge', source: 'browser' });
  assert.deepEqual(appInfo('308046B0AF4A39CB'), { appName: 'Firefox', source: 'browser' });
  assert.deepEqual(appInfo('AppleInc.AppleMusicWin_nzyj5cx40ttqa!App'), { appName: 'Apple Music', source: 'apple-music' });
  assert.deepEqual(appInfo('Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic'), { appName: 'Media Player', source: 'media-player' });
  assert.deepEqual(appInfo('com.github.th-ch.youtube-music'), { appName: 'YouTube Music', source: 'youtube-music' });
  assert.deepEqual(appInfo('CoolCompany.CoolPlayer_abcdefghijklm!App'), { appName: 'Cool Player', source: 'other' });
  assert.deepEqual(appInfo('C:\\Juegos\\mi_reproductor.exe'), { appName: 'Mi reproductor', source: 'other' });
  assert.deepEqual(appInfo(''), { appName: 'Windows', source: 'other' });
});

test('auto: Spotify sonando gana aunque Windows elija otra', () => {
  const list = [chrome({ status: 4 }), spotify({ status: 4 })];
  assert.equal(chooseSession(list, { choice: 'auto', systemId: 'Chrome' }).id, 'Spotify.exe');
});

test('auto: Spotify en pausa y otra sonando -> la que suena', () => {
  const list = [spotify({ status: 5 }), chrome({ status: 4 })];
  assert.equal(chooseSession(list, { choice: 'auto', systemId: 'Spotify.exe' }).id, 'Chrome');
});

test('auto: nada sonando -> Spotify si está; si no, la anterior o la de Windows', () => {
  assert.equal(chooseSession([chrome({ status: 5 }), spotify({ status: 5 })], { systemId: 'Chrome' }).id, 'Spotify.exe');
  assert.equal(chooseSession([chrome({ status: 5 }), edge({ status: 5 })], { systemId: 'MSEdge' }).id, 'MSEdge');
  assert.equal(chooseSession([chrome({ status: 5 }), edge({ status: 5 })], { systemId: 'MSEdge', prevId: 'Chrome' }).id, 'Chrome');
  assert.equal(chooseSession([chrome({ status: 3 })], {}).id, 'Chrome');
});

test('auto: dos sonando sin Spotify -> se mantiene la anterior (no salta)', () => {
  const list = [chrome({ status: 4 }), edge({ status: 4 })];
  assert.equal(chooseSession(list, { systemId: 'Chrome', prevId: 'MSEdge' }).id, 'MSEdge');
  assert.equal(chooseSession(list, { systemId: 'Chrome' }).id, 'Chrome');
});

test('system: la que elige Windows, y si no hay, como auto', () => {
  const list = [spotify({ status: 4 }), chrome({ status: 5 })];
  assert.equal(chooseSession(list, { choice: 'system', systemId: 'Chrome' }).id, 'Chrome');
  assert.equal(chooseSession(list, { choice: 'system', systemId: '' }).id, 'Spotify.exe');
});

test('app elegida: por id o por app; si no está abierta, como auto', () => {
  const list = [spotify({ status: 4 }), chrome({ status: 5 }), session({ id: 'Chrome#2', app: 'Chrome', status: 5 })];
  assert.equal(chooseSession(list, { choice: 'Chrome' }).id, 'Chrome');
  assert.equal(chooseSession(list, { choice: 'Chrome#2' }).id, 'Chrome#2');
  assert.equal(chooseSession(list, { choice: 'AppleInc.AppleMusicWin_nzyj5cx40ttqa!App' }).id, 'Spotify.exe');
});

test('sin sesiones -> null', () => {
  assert.equal(chooseSession([], {}), null);
  assert.equal(chooseSession(null, {}), null);
});

const AUDIO = [
  { pid: 10, exe: 'Spotify.exe', pkg: '', volume: 0.8, muted: false, active: false },
  { pid: 20, exe: 'chrome.exe', pkg: '', volume: 0.5, muted: false, active: false },
  { pid: 21, exe: 'chrome.exe', pkg: '', volume: 0.4, muted: true, active: true },
  { pid: 30, exe: 'Spotify.exe', pkg: 'SpotifyAB.SpotifyMusic_1.220.0.0_x64__zpdnekdrzrea0', volume: 0.6, muted: false, active: true },
  { pid: 40, exe: 'firefox.exe', pkg: '', volume: 1, muted: false, active: true },
  { pid: 50, exe: 'Microsoft.Media.Player.exe', pkg: 'Microsoft.ZuneMusic_11.2.0.0_x64__8wekyb3d8bbwe', volume: 1, muted: false, active: false },
];

test('matchAudio: ejecutable, paquete de la Tienda, navegadores y Firefox', () => {
  assert.deepEqual(matchAudio('Spotify.exe', AUDIO).map((a) => a.pid), [10, 30]);
  assert.deepEqual(matchAudio('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify', AUDIO).map((a) => a.pid), [30]);
  assert.deepEqual(matchAudio('Chrome', AUDIO).map((a) => a.pid), [20, 21]);
  assert.deepEqual(matchAudio('Chrome#2', AUDIO).map((a) => a.pid), [20, 21]);
  assert.deepEqual(matchAudio('308046B0AF4A39CB', AUDIO).map((a) => a.pid), [40]);
  assert.deepEqual(matchAudio('Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic', AUDIO).map((a) => a.pid), [50]);
  assert.deepEqual(matchAudio('MSEdge', AUDIO), []);
  assert.deepEqual(matchAudio('', AUDIO), []);
  assert.deepEqual(matchAudio('Spotify.exe', null), []);
});

test('audioSummary: volumen de la que suena, silencio si están todas silenciadas', () => {
  assert.deepEqual(audioSummary(matchAudio('Chrome', AUDIO)), { available: true, level: 0.4, muted: false, pids: [20, 21] });
  assert.deepEqual(audioSummary([AUDIO[2]]), { available: true, level: 0.4, muted: true, pids: [21] });
  assert.deepEqual(audioSummary([]), { available: false, level: null, muted: false, pids: [] });
});

test('trackTiming: suma lo que pasó solo si está sonando y no pasa la duración', () => {
  const now = 1800000010000;
  assert.deepEqual(trackTiming(spotify({ status: 4, position: 30000, updated: now - 4000 }), now), { position: 34000, duration: 180000 });
  assert.deepEqual(trackTiming(spotify({ status: 5, position: 30000, updated: now - 4000 }), now), { position: 30000, duration: 180000 });
  assert.deepEqual(trackTiming(spotify({ status: 4, position: 179000, updated: now - 9000 }), now), { position: 180000, duration: 180000 });
  // Sin hora de la app: se cuenta desde que llegó el mensaje
  assert.deepEqual(trackTiming(spotify({ status: 4, position: 1000, updated: 0 }), now, now - 2000), { position: 3000, duration: 180000 });
  // Línea de tiempo que no empieza en 0
  assert.deepEqual(trackTiming(spotify({ status: 5, start: 5000, position: 15000, end: 65000 }), now), { position: 10000, duration: 60000 });
});

test('buildState: forma del contrato del overlay', () => {
  const now = 1800000000000;
  const st = buildState(spotify({ status: 4, position: 1000, updated: now }), { art: 'data:image/jpeg;base64,AA==', now });
  assert.deepEqual(st, {
    title: 'Canción', artist: 'Artista', album: 'Disco', art: 'data:image/jpeg;base64,AA==', playing: true, position: 1000, duration: 180000,
    source: 'spotify', appName: 'Spotify', appId: 'Spotify.exe', status: 'playing', positionAt: now, canSeek: true,
  });
  assert.equal(buildState(null), null);
  assert.equal(buildState(spotify({ end: 0 }), { now }).canSeek, false, 'sin duración no se puede saltar');
});

test('positionNow y stateChanged', () => {
  const now = 1800000000000;
  const a = buildState(spotify({ status: 4, position: 10000, updated: now }), { now });
  assert.equal(positionNow(a, now + 5000), 15000);
  // Mismo tema avanzando normalmente: no cambió
  const b = buildState(spotify({ status: 4, position: 15000, updated: now + 5000 }), { now: now + 5000 });
  assert.equal(stateChanged(a, b, now + 5000), false);
  // Salto (seek)
  const c = buildState(spotify({ status: 4, position: 90000, updated: now + 5000 }), { now: now + 5000 });
  assert.equal(stateChanged(a, c, now + 5000), true);
  // Pausa, otra canción, portada nueva, aparecer/desaparecer
  assert.equal(stateChanged(a, { ...a, playing: false }, now), true);
  assert.equal(stateChanged(a, { ...a, title: 'Otra' }, now), true);
  assert.equal(stateChanged(a, { ...a, art: 'data:image/jpeg;base64,BB==' }, now), true);
  assert.equal(stateChanged(null, a, now), true);
  assert.equal(stateChanged(a, null, now), true);
  assert.equal(stateChanged(null, null, now), false);
});

test('sourcesList: marca la elegida y la de Windows', () => {
  const list = sourcesList([spotify({ status: 5 }), chrome({ status: 4 })], { selectedId: 'Chrome', systemId: 'Spotify.exe' });
  assert.deepEqual(list, [
    { id: 'Spotify.exe', appName: 'Spotify', source: 'spotify', title: 'Canción', artist: 'Artista', playing: false, system: true, selected: false },
    { id: 'Chrome', appName: 'Google Chrome', source: 'browser', title: 'Video', artist: 'Artista', playing: true, system: false, selected: true },
  ]);
});
