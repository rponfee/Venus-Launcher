'use strict';
// Musica de perfil (features/profile-editor/music-logic.js): validacion de la cancion guardada, tramo de 30 s,
// etiquetas y estados. Uso: node --test "src/renderer/js/features/profile-editor/test/"
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = require('url').pathToFileURL(path.join(__dirname, '..', 'music-logic.js')).href;
let L;
test.before(async () => {
  L = await import(SRC);
});

const TRACK = {
  provider: 'openverse',
  id: '3de3576d-6bc6-4493-a75d-cd48e40e154d',
  source: 'jamendo',
  title: 'Pista de prueba',
  creator: 'Autora de prueba',
  license: 'by-sa',
  licenseVersion: '4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
  landing: 'https://www.jamendo.com/track/1132192',
  url: 'https://prod-1.storage.jamendo.com/?trackid=1132192&format=mp32',
  duration: 202,
  genres: ['jazz'],
};

test('songFromTrack arma exactamente el formato de cardStyle.song', () => {
  const s = L.songFromTrack(TRACK, { start: 40 });
  assert.deepEqual(s, {
    provider: 'openverse',
    id: TRACK.id,
    title: 'Pista de prueba',
    creator: 'Autora de prueba',
    license: 'by-sa',
    licenseVersion: '4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    landing: TRACK.landing,
    url: TRACK.url,
    start: 40,
    len: 30,
  });
  assert.deepEqual(Object.keys(s).sort(), [...L.SONG_KEYS].sort());
  assert.deepEqual(L.normalizeSong(s), s);
});

test('el tramo se acomoda dentro de la pista', () => {
  assert.equal(L.songFromTrack(TRACK, { start: 9999 }).start, 172);
  assert.equal(L.songFromTrack({ ...TRACK, duration: 12 }, { start: 5 }).len, 12);
  assert.equal(L.songFromTrack({ ...TRACK, duration: 12 }, { start: 5 }).start, 0);
  assert.equal(L.clipLength(12), 12);
  assert.equal(L.clipLength(500), 30);
  assert.equal(L.clipLength(0), 30);
  assert.equal(L.clampStart(-4, 30, 200), 0);
  assert.equal(L.clampStart(500, 30, 200), 170);
  assert.equal(L.clampStart('x', 30, 200), 0);
});

test('normalizeSong rechaza hosts, licencias NC y formatos que no son los del servidor', () => {
  const good = L.songFromTrack(TRACK);
  const ng = (patch) => assert.equal(L.normalizeSong({ ...good, ...patch }), null, JSON.stringify(patch));
  ng({ url: 'https://evil.example/a.mp3' });
  ng({ url: 'http://prod-1.storage.jamendo.com/?trackid=1&format=mp32' });
  ng({ url: 'https://prod-1.storage.jamendo.com.evil.example/?trackid=1&format=mp32' });
  ng({ url: 'https://cdn.freesound.org/previews/1/1_1-hq.mp3' });
  ng({ url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Tema.wav' });
  ng({ landing: 'https://evil.example/' });
  ng({ landing: 'https://commons.wikimedia.org/w/index.php?curid=1' });
  ng({ license: 'by-nc', licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/' });
  ng({ license: 'cc0' });
  ng({ licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/deed.es' });
  ng({ provider: 'jamendo' });
  ng({ id: 'abc' });
  ng({ title: '' });
  ng({ creator: 3 });
  ng({ start: 1.5 });
  ng({ len: 31 });
  ng({ len: 0 });
  ng({ extra: true });
  assert.equal(L.normalizeSong(null), null);
  assert.equal(L.normalizeSong({ url: good.url }), null);
  assert.equal(L.normalizeSong('x'), null);
  // el texto se limpia pero la cancion sigue siendo valida
  const dirty = L.normalizeSong({ ...good, title: '<b>Hola</b>  mundo', creator: '' });
  assert.equal(dirty.title, 'b Hola /b mundo');
  assert.equal(dirty.creator, '');
});

test('Wikimedia: audio y pagina de origen del mismo sitio', () => {
  const wiki = L.songFromTrack({
    ...TRACK,
    license: 'cc0',
    licenseVersion: '1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    url: 'https://upload.wikimedia.org/wikipedia/commons/b/b2/Frederic_Chopin_Piano_Sonata_No.2_in_B_flat_minor_Op35_-_III.ogg',
    landing: 'https://commons.wikimedia.org/w/index.php?curid=46103355',
  });
  assert.ok(wiki);
  assert.equal(L.songSource(wiki.url), 'wikimedia');
  assert.equal(L.normalizeSong({ ...wiki, landing: TRACK.landing }), null, 'pagina de otro sitio');
  assert.equal(L.licenseLabel('cc0', '1.0'), 'CC0 1.0');
  assert.equal(L.licenseLabel('by-sa', '3.0'), 'CC BY-SA 3.0');
  assert.equal(L.licenseLabel('by-nc', '3.0'), '');
});

test('trackPlayable: la vista previa solo suena con direcciones conocidas', () => {
  assert.equal(L.trackPlayable(TRACK), true);
  assert.equal(L.trackPlayable({ ...TRACK, url: 'https://evil.example/a.mp3' }), false);
  assert.equal(L.trackPlayable({ ...TRACK, license: 'by-nc' }), false);
  assert.equal(L.trackPlayable(null), false);
});

test('progreso del tramo y ventana real segun la duracion del archivo', () => {
  assert.equal(L.clipProgress(40, 40, 30), 0);
  assert.equal(L.clipProgress(55, 40, 30), 0.5);
  assert.equal(L.clipProgress(100, 40, 30), 1);
  assert.equal(L.clipProgress(10, 40, 30), 0);
  assert.equal(L.clipProgress(NaN, 40, 30), 0);
  assert.equal(L.clipProgress(5, 0, 0), 0);
  const song = { start: 150, len: 30 };
  assert.deepEqual(L.playableWindow(song, 300), { start: 150, len: 30 });
  assert.deepEqual(L.playableWindow(song, 160), { start: 130, len: 30 });
  assert.deepEqual(L.playableWindow(song, 100), { start: 0, len: 30 });
  assert.deepEqual(L.playableWindow(song, 20), { start: 0, len: 20 });
  assert.deepEqual(L.playableWindow(song, NaN), { start: 150, len: 30 });
});

test('reloj, juego abierto y errores de la busqueda', () => {
  assert.equal(L.fmtClock(83), '1:23');
  assert.equal(L.fmtClock(5), '0:05');
  assert.equal(L.fmtClock(-3), '0:00');
  assert.equal(L.fmtClock('x'), '0:00');
  assert.equal(L.gameBusy({}), false);
  assert.equal(L.gameBusy(null), false);
  assert.equal(L.gameBusy({ a: { state: 'running' } }), true);
  assert.equal(L.gameBusy({ a: { state: 'preparing' } }), true);
  assert.deepEqual(L.errorInfo({ error: 'rate_limited', retryAfter: 24.2 }), { code: 'rate_limited', retryAfter: 25 });
  assert.deepEqual(L.errorInfo({ error: 'algo raro' }), { code: 'network', retryAfter: 0 });
  assert.deepEqual(L.errorInfo(null), { code: 'network', retryAfter: 0 });
  assert.equal(L.errorInfo({ error: 'daily_limit', retryAfter: 9e9 }).retryAfter, 86400);
});

test('fmtWait: segundos, minutos u horas segun cuanto falte', () => {
  assert.deepEqual(L.fmtWait(25), { unit: 'seconds', n: 25 });
  assert.deepEqual(L.fmtWait(0), { unit: 'seconds', n: 1 });
  assert.deepEqual(L.fmtWait(90), { unit: 'seconds', n: 90 });
  assert.deepEqual(L.fmtWait(91), { unit: 'minutes', n: 2 });
  assert.deepEqual(L.fmtWait(1800), { unit: 'minutes', n: 30 });
  assert.deepEqual(L.fmtWait(7200), { unit: 'hours', n: 2 });
  assert.deepEqual(L.fmtWait(43200), { unit: 'hours', n: 12 });
  assert.deepEqual(L.fmtWait('x'), { unit: 'seconds', n: 1 });
});
