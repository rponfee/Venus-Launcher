'use strict';
// Aspecto por instancia y ajustes compartidos en venus-instance.json. node --test "src/main/modules/instancemeta/test/"
const test = require('node:test');
const assert = require('node:assert/strict');
const meta = require('../meta');

test('normalizeLook: guarda solo lo que sirve', () => {
  assert.deepEqual(
    meta.normalizeLook({
      color: { accent: 'neptune', customColor: '#000000' },
      background: { type: 'wallpaper', id: 'wallpaper-05', dim: 120, blur: -3 },
      music: { type: 'file', file: 'C:\\Música\\tema.mp3', volume: 70, pauseInGame: false },
      extra: 'nada',
    }),
    { color: { accent: 'neptune' }, background: { type: 'wallpaper', id: 'wallpaper-05', dim: 90, blur: 0 }, music: { type: 'file', file: 'C:\\Música\\tema.mp3', volume: 70, pauseInGame: false } },
  );
  assert.deepEqual(meta.normalizeLook({ color: { accent: 'custom', customColor: '#AABBCC' } }), { color: { accent: 'custom', customColor: '#aabbcc' } });
  assert.deepEqual(meta.normalizeLook({ background: { type: 'stars', dim: 3 } }), { background: { type: 'stars' } });
  assert.deepEqual(meta.normalizeLook({ music: { type: 'off', file: 'x' } }), { music: { type: 'off' } });
  assert.deepEqual(meta.normalizeLook({ background: { type: 'image', file: '/home/yo/fondo.webm' } }), { background: { type: 'image', file: '/home/yo/fondo.webm', dim: 45, blur: 0 } });
});

test('normalizeLook: lo inválido se descarta y sin nada queda null', () => {
  for (const raw of [null, undefined, 'x', [], {}, { color: { accent: 'pluton' } }, { color: { accent: 'custom', customColor: 'red' } }, { music: { type: 'file' } }, { background: { type: 'otro' } }]) {
    assert.equal(meta.normalizeLook(raw), null, JSON.stringify(raw));
  }
  // rutas raras: de red, relativas, con otra extensión o direcciones
  for (const file of ['\\\\pc\\carpeta\\fondo.png', '//pc/carpeta/fondo.png', 'fondo.png', '..\\fondo.png', 'C:\\fondo.exe', 'https://x.com/fondo.png', 'file:///C:/fondo.png', 'C:\\fon\ndo.png', `C:\\${'a'.repeat(1100)}.png`, 42]) {
    assert.equal(meta.normalizeLook({ background: { type: 'image', file } }), null, String(file));
  }
  assert.equal(meta.normalizeLook({ music: { type: 'file', file: 'C:\\fondo.png' } }), null, 'una imagen no es música');
  assert.equal(meta.normalizeLook({ background: { type: 'wallpaper', id: '../x' } }), null);
});

test('applyMetaPatch normaliza look y sharedOptions', () => {
  const patch = meta.applyMetaPatch({ look: { color: { accent: 'mars' }, background: { type: 'nada' } }, sharedOptions: 'si' });
  assert.deepEqual(patch.look, { color: { accent: 'mars' } });
  assert.equal(patch.sharedOptions, false);
  assert.equal(meta.applyMetaPatch({ sharedOptions: true }).sharedOptions, true);
  assert.equal(meta.applyMetaPatch({ look: null }).look, null);
  assert.equal('look' in meta.applyMetaPatch({ name: 'x' }), false);
});
