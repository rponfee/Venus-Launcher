'use strict';
// Reglas de la musica de perfil: que resultados de Openverse se aceptan y como queda la cancion guardada.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../policy');
const { fixture } = require('./helpers');

const first = (name, i = 0) => fixture(name).results[i];
const mutate = (raw, patch) => ({ ...raw, ...patch });

test('Jamendo real: las ocho pistas guardadas se aceptan con licencia, host y pagina de origen validos', () => {
  const tracks = fixture('jamendo-search.json').results.map(P.trackFromResult);
  assert.equal(tracks.filter(Boolean).length, 8);
  const t = tracks[0];
  assert.equal(t.provider, 'openverse');
  assert.equal(t.source, 'jamendo');
  assert.match(t.url, /^https:\/\/prod-1\.storage\.jamendo\.com\/\?trackid=\d+&format=mp32$/);
  assert.match(t.landing, /^https:\/\/www\.jamendo\.com\/track\/\d+$/);
  assert.equal(t.licenseUrl, `https://creativecommons.org/licenses/${t.license}/${t.licenseVersion}/`);
  assert.ok(t.duration > 0 && Number.isInteger(t.duration));
});

test('Wikimedia real: se aceptan ogg con CC0 y BY-SA; el wav (muy pesado) no', () => {
  const raw = fixture('wikimedia-search.json').results;
  const out = raw.map((r) => [r.url.slice(r.url.lastIndexOf('.') + 1), Boolean(P.trackFromResult(r))]);
  assert.deepEqual(out.filter(([e]) => e === 'wav').map(([, ok]) => ok), [false]);
  assert.ok(out.filter(([e]) => e === 'ogg').length >= 8);
  assert.ok(out.filter(([e]) => e === 'ogg').every(([, ok]) => ok));
  const cc0 = raw.find((r) => r.license === 'cc0');
  const t = P.trackFromResult(cc0);
  assert.equal(t.licenseUrl, 'https://creativecommons.org/publicdomain/zero/1.0/'); // la de la API trae /deed.en/
  assert.equal(t.source, 'wikimedia');
});

test('Freesound queda afuera aunque la licencia sirva', () => {
  const raw = fixture('freesound-search.json').results;
  assert.ok(raw.some((r) => r.license === 'cc0'));
  assert.ok(raw.every((r) => P.trackFromResult(r) === null));
});

test('licencias: solo CC0, dominio publico, BY, BY-SA y BY-ND', () => {
  const base = first('jamendo-search.json');
  for (const license of ['by', 'by-sa', 'by-nd']) assert.ok(P.trackFromResult(mutate(base, { license, license_version: '4.0' })), license);
  assert.ok(P.trackFromResult(mutate(base, { license: 'cc0', license_version: '1.0' })));
  assert.ok(P.trackFromResult(mutate(base, { license: 'pdm', license_version: '1.0' })));
  for (const license of ['by-nc', 'by-nc-sa', 'by-nc-nd', 'sampling+', 'nc-sampling+', 'BY-NC', '', 'gpl', 'all']) {
    assert.equal(P.trackFromResult(mutate(base, { license, license_version: '4.0' })), null, license);
  }
  assert.equal(P.trackFromResult(mutate(base, { license: 'by', license_version: '9.9' })), null);
  assert.equal(P.trackFromResult(mutate(base, { license: 'cc0', license_version: '4.0' })), null);
  assert.equal(P.trackFromResult(mutate(base, { license_url: 'https://evil.example/licenses/by/4.0/' })), null);
  assert.deepEqual(P.LICENSE_IDS, ['by', 'by-sa', 'by-nd', 'cc0', 'pdm']);
});

test('audio: solo los hosts conocidos, https y el formato exacto de cada uno', () => {
  const j = first('jamendo-search.json');
  const w = P.trackFromResult(first('wikimedia-search.json'));
  const bad = [
    'http://prod-1.storage.jamendo.com/?trackid=1&format=mp32',
    'https://prod-2.storage.jamendo.com/?trackid=1&format=mp32',
    'https://prod-1.storage.jamendo.com.evil.example/?trackid=1&format=mp32',
    'https://evil.example/?trackid=1&format=mp32',
    'https://user@prod-1.storage.jamendo.com/?trackid=1&format=mp32',
    'https://prod-1.storage.jamendo.com:8443/?trackid=1&format=mp32',
    'https://prod-1.storage.jamendo.com/?trackid=1&format=mp32&x=1',
    'https://prod-1.storage.jamendo.com/?trackid=abc&format=mp32',
    'https://prod-1.storage.jamendo.com/?trackid=1&format=flac',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Tema.wav',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Tema.ogg?x=1',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/../Tema.ogg',
    'https://upload.wikimedia.org/wikipedia/en/a/ab/Tema.ogg',
    'https://cdn.freesound.org/previews/186/186942_2594536-hq.mp3',
    'javascript:alert(1)',
    'data:audio/mpeg;base64,AAAA',
    'file:///C:/Windows/media/tada.wav',
    '',
    null,
    42,
  ];
  for (const url of bad) assert.equal(P.audioUrlOk(url), false, String(url));
  assert.equal(P.audioUrlOk(j.url), true);
  assert.equal(P.audioUrlOk(w.url), true);
  assert.equal(P.trackFromResult(mutate(j, { url: bad[0] })), null);
  assert.equal(P.trackFromResult(mutate(first('wikimedia-search.json'), { url: j.url })), null, 'la fuente tiene que coincidir con el host');
  assert.deepEqual(P.AUDIO_HOSTS, ['prod-1.storage.jamendo.com', 'upload.wikimedia.org']);
});

test('pagina de origen: debe ser del mismo sitio que el audio', () => {
  const j = first('jamendo-search.json');
  assert.equal(P.trackFromResult(mutate(j, { foreign_landing_url: 'https://evil.example/track/1' })), null);
  assert.equal(P.trackFromResult(mutate(j, { foreign_landing_url: 'http://www.jamendo.com/track/1' })), null);
  assert.equal(P.trackFromResult(mutate(j, { foreign_landing_url: 'https://commons.wikimedia.org/w/index.php?curid=1' })), null);
  assert.equal(P.trackFromResult(mutate(j, { foreign_landing_url: null })), null);
  assert.equal(P.landingOk('https://commons.wikimedia.org/wiki/File:Tema_Uno.ogg', 'wikimedia'), true);
});

test('campos: ids, titulos, autores, duracion, contenido para adultos', () => {
  const j = first('jamendo-search.json');
  assert.equal(P.trackFromResult(mutate(j, { id: 'no-es-un-uuid' })), null);
  assert.equal(P.trackFromResult(mutate(j, { title: '' })), null);
  assert.equal(P.trackFromResult(mutate(j, { title: '   ' })), null);
  assert.equal(P.trackFromResult(mutate(j, { mature: true })), null);
  assert.equal(P.trackFromResult(mutate(j, { unstable__sensitivity: ['sensitive_text'] })), null);
  assert.equal(P.trackFromResult(mutate(j, { duration: 0 })), null);
  assert.equal(P.trackFromResult(mutate(j, { duration: 3_600_000 })), null);
  assert.equal(P.trackFromResult(mutate(j, { duration: 'mucho' })), null);
  assert.equal(P.trackFromResult(mutate(j, { source: 'otra' })), null);
  assert.equal(P.trackFromResult(null), null);
  assert.equal(P.trackFromResult([]), null);
  const t = P.trackFromResult(mutate(j, { title: `<img src=x onerror=alert(1)>Tema${String.fromCharCode(0x2028)}\n\tfinal`.padEnd(200, 'x'), creator: 'A'.repeat(500) }));
  assert.ok(t.title.length <= 80 && !/[<>\n\t]/.test(t.title) && !t.title.includes(String.fromCharCode(0x2028)));
  assert.equal(t.creator.length, 60);
  assert.equal(P.trackFromResult(mutate(j, { creator: null })).creator, '');
});

test('cancion guardada: exactamente las claves del formato y valores acotados', () => {
  const track = P.trackFromResult(first('jamendo-search.json'));
  const song = P.songFromTrack(track, { start: 12, len: 30 });
  assert.deepEqual(Object.keys(song).sort(), [...P.SONG_KEYS].sort());
  assert.equal(song.provider, 'openverse');
  assert.equal(song.start, 12);
  assert.equal(song.len, 30);
  assert.deepEqual(P.normalizeSong(song), song);
  // un tramo que no entra en la pista se corre hacia atras y el largo no pasa de la pista ni de 30 s
  const short = P.songFromTrack({ ...track, duration: 20 }, { start: 15, len: 30 });
  assert.equal(short.len, 20);
  assert.equal(short.start, 0);
  const near = P.songFromTrack({ ...track, duration: 100 }, { start: 90, len: 30 });
  assert.equal(near.start, 70);
  assert.equal(P.songFromTrack(track, { start: -5 }).start, 0);
  assert.equal(P.songFromTrack(null), null);
});

test('normalizeSong rechaza claves de mas, tipos raros y mezclas', () => {
  const song = P.songFromTrack(P.trackFromResult(first('jamendo-search.json')), { start: 3, len: 25 });
  const ng = (patch) => assert.equal(P.normalizeSong({ ...song, ...patch }), null, JSON.stringify(patch).slice(0, 80));
  ng({ extra: 1 });
  ng({ provider: 'jamendo' });
  ng({ id: 'x' });
  ng({ title: '' });
  ng({ title: 7 });
  ng({ creator: 'A'.repeat(61) });
  ng({ creator: null });
  ng({ license: 'by-nc' });
  ng({ licenseVersion: '3.0', license: 'cc0' });
  ng({ licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/' });
  ng({ licenseUrl: song.licenseUrl + 'x' });
  ng({ url: 'https://evil.example/a.mp3' });
  ng({ landing: 'https://evil.example/' });
  ng({ start: -1 });
  ng({ start: 1.5 });
  ng({ start: '3' });
  ng({ start: 90_000 });
  ng({ len: 0 });
  ng({ len: 31 });
  ng({ len: '30' });
  const { len, ...sinLen } = song;
  assert.equal(P.normalizeSong(sinLen), null);
  assert.equal(P.normalizeSong(null), null);
  assert.equal(P.normalizeSong('hola'), null);
  assert.equal(P.normalizeSong([song]), null);
  assert.ok(JSON.stringify(song).length < P.LIMITS.songBytes);
});

test('normalizeTrack vuelve a validar lo que sale del disco', () => {
  const track = P.trackFromResult(first('wikimedia-search.json'));
  assert.deepEqual(P.normalizeTrack(track), track);
  assert.equal(P.normalizeTrack({ ...track, url: 'https://evil.example/a.ogg' }), null);
  assert.equal(P.normalizeTrack({ ...track, license: 'by-nc' }), null);
  assert.equal(P.normalizeTrack({ ...track, source: 'jamendo' }), null);
  assert.equal(P.normalizeTrack({ ...track, duration: 'x' }), null);
  assert.equal(P.normalizeTrack(null), null);
});
