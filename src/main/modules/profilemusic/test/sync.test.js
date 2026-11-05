'use strict';
// El proceso principal (policy.js), la interfaz (features/profile-editor/music-logic.js) y el servidor (0042) tienen que
// decir lo mismo sobre que cancion vale. Esta prueba compara las dos primeras con los mismos casos; la tercera se prueba
// con la migracion (supabase/migrations/0042_musica_perfil.sql, ver docs/perfiles.md).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const P = require('../policy');
const Q = require('../query');
const { fixture } = require('./helpers');

const UI = require('url').pathToFileURL(path.join(__dirname, '..', '..', '..', '..', 'renderer', 'js', 'features', 'profile-editor', 'music-logic.js')).href;
let L;
test.before(async () => {
  L = await import(UI);
});

test('mismas licencias, hosts y limites', () => {
  assert.deepEqual(Object.keys(L.LICENSES), Object.keys(P.LICENSES));
  for (const id of P.LICENSE_IDS) {
    assert.deepEqual(L.LICENSES[id].versions, P.LICENSES[id].versions, id);
    assert.equal(L.LICENSES[id].path, P.LICENSES[id].path, id);
  }
  assert.deepEqual([...L.AUDIO_HOSTS], [...P.AUDIO_HOSTS]);
  assert.deepEqual([...L.LANDING_HOSTS], [...P.LANDING_HOSTS]);
  assert.deepEqual([...L.SONG_KEYS], [...P.SONG_KEYS]);
  for (const k of ['title', 'creator', 'url', 'landing', 'licenseUrl', 'seconds', 'start', 'maxTrack', 'songBytes']) assert.equal(L.LIMITS[k], P.LIMITS[k], k);
  assert.deepEqual([...L.GENRES], Q.GENRE_IDS);
  assert.deepEqual([...L.LENGTHS], Q.LENGTH_IDS);
  assert.deepEqual([...L.SOURCE_CHOICES], Q.SOURCE_CHOICE_IDS);
});

test('mismo veredicto sobre una bateria de direcciones y canciones', () => {
  const urls = [
    ...fixture('jamendo-search.json').results.map((r) => r.url),
    ...fixture('wikimedia-search.json').results.map((r) => r.url),
    ...fixture('freesound-search.json').results.map((r) => r.url),
    'https://prod-1.storage.jamendo.com/?trackid=1&format=mp31',
    'https://prod-1.storage.jamendo.com/?trackid=12345678901&format=mp32',
    'https://prod-1.storage.jamendo.com/?trackid=1&format=mp33',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Tema_%28vivo%29.ogg',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Tema (vivo).ogg',
    'https://upload.wikimedia.org/wikipedia/commons/A/ab/Tema.ogg',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Tema.OGG',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Tema.opus',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/' + 'x'.repeat(201) + '.ogg',
    'https://upload.wikimedia.org/wikipedia/commons/a/ab/Tema.ogg#x',
    'https://UPLOAD.wikimedia.org/wikipedia/commons/a/ab/Tema.ogg',
    'https://evil.example/', '', null, 5, {},
  ];
  for (const u of urls) assert.equal(L.isSongAudioUrl(u), P.audioUrlOk(u), String(u).slice(0, 90));
  const landings = [
    ['https://www.jamendo.com/track/1', 'jamendo'], ['https://www.jamendo.com/track/x', 'jamendo'], ['https://jamendo.com/track/1', 'jamendo'],
    ['https://commons.wikimedia.org/w/index.php?curid=5', 'wikimedia'], ['https://commons.wikimedia.org/wiki/File:Tema_1.ogg', 'wikimedia'],
    ['https://commons.wikimedia.org/wiki/File:Tema/../x', 'wikimedia'], ['https://www.jamendo.com/track/1', 'wikimedia'], ['https://es.wikipedia.org/wiki/X', 'wikimedia'],
  ];
  for (const [u, s] of landings) assert.equal(L.isLandingUrl(u, s), P.landingOk(u, s), u);
  // canciones: lo que acepta una lo acepta la otra, igual de limpio
  const base = P.songFromTrack(P.trackFromResult(fixture('jamendo-search.json').results[0]), { start: 7, len: 20 });
  const wiki = P.songFromTrack(P.trackFromResult(fixture('wikimedia-search.json').results[9]), { start: 3, len: 30 });
  const cases = [base, wiki, { ...base, extra: 1 }, { ...base, license: 'by-nc' }, { ...base, url: wiki.url }, { ...base, title: '  <b>x</b>  y ' }, { ...base, len: 31 }, { ...base, start: -1 }, { ...base, creator: 'z'.repeat(61) }, { ...base, licenseUrl: 'https://creativecommons.org/licenses/by-sa/9.9/' }];
  for (const c of cases) assert.deepEqual(L.normalizeSong(c), P.normalizeSong(c), JSON.stringify(c).slice(0, 80));
  // pistas -> canciones
  for (const r of [...fixture('jamendo-search.json').results, ...fixture('wikimedia-search.json').results]) {
    const t = P.trackFromResult(r);
    if (!t) continue;
    for (const o of [{}, { start: 50 }, { start: 5000, len: 12 }]) assert.deepEqual(L.songFromTrack(t, o), P.songFromTrack(t, o), r.id);
  }
});
