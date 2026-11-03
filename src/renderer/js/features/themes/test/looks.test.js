// Pruebas del códec de looks (sin DOM). node --test "src/renderer/js/features/themes/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { PREFIX, MAX_LOOKS, LOGO_MAX, normalizeLook, normalizeLooks, lookFromSettings, shareableLook, encodeLook, decodeLook, cleanLookName } from '../looks.js';

const AP = {
  accent: 'custom',
  customColor: '#3FA2FF',
  background: 'image',
  bgFile: 'C:\\Users\\Yo\\fondo.png',
  wallpaperId: 'wallpaper-03',
  scheme: 'light',
  palette: { bg: '#101010', text: 'rojo' },
  playButton: { color: '#ff0000', label: 'Dale', animation: 'shine', sound: 'bell' },
  rotation: { enabled: true, ids: ['wallpaper-01', 'nope'], everyMin: 15 },
  lite: true,
  liteOverlay: true,
  seasonalBackup: { season: 'halloween', accent: 'venus' },
  music: { enabled: true, file: 'C:\\musica.mp3', volume: 50 },
};
const BR = { name: 'Mi server', subtitle: 'LAUNCHER', logo: `data:image/png;base64,${'A'.repeat(40)}`, logoName: 'logo.png', server: 'play.miserver.com' };
const logoPng = (bytes) => `data:image/png;base64,${'A'.repeat(bytes)}`;

test('nombres', () => {
  assert.equal(cleanLookName('  Noche  '), 'Noche');
  assert.equal(cleanLookName(''), null);
  assert.equal(cleanLookName('<b>x</b>'), 'bx/b');
  assert.equal(cleanLookName('x'.repeat(60)).length, 40);
  assert.equal(normalizeLook({ appearance: {} }), null);
});

test('un look guarda la apariencia normalizada sin lo que no viaja', () => {
  const look = lookFromSettings({ appearance: AP, branding: BR }, 'Azul', { now: 1000 });
  assert.match(look.id, /^look-/);
  assert.equal(look.name, 'Azul');
  assert.equal(look.createdAt, 1000);
  assert.equal(look.appearance.customColor, '#3fa2ff');
  assert.equal(look.appearance.bgFile, 'C:\\Users\\Yo\\fondo.png'); // guardado en la PC: se conserva
  assert.equal(look.appearance.palette.bg, '#101010');
  assert.equal(look.appearance.palette.text, null);
  assert.deepEqual(look.appearance.rotation, { enabled: true, ids: ['wallpaper-01'], everyMin: 15, onLaunch: true });
  assert.equal('lite' in look.appearance, false);
  assert.equal('liteOverlay' in look.appearance, false);
  assert.equal('seasonalBackup' in look.appearance, false);
  assert.equal(look.branding.logo, BR.logo);
  assert.equal(look.branding.server, 'play.miserver.com');
});

test('el logo queda limitado a 200 KB', () => {
  const big = normalizeLook({ name: 'Grande', appearance: {}, branding: { ...BR, logo: logoPng(LOGO_MAX + 100) } });
  assert.equal(big.branding.logo, '');
  assert.equal(big.branding.logoName, '');
  const okSize = normalizeLook({ name: 'Justo', appearance: {}, branding: { ...BR, logo: logoPng(LOGO_MAX - 'data:image/png;base64,'.length) } });
  assert.ok(okSize.branding.logo.length > 0);
});

test('compartir nunca lleva rutas de la PC', () => {
  const look = lookFromSettings({ appearance: AP, branding: BR }, 'Azul');
  const data = shareableLook(look);
  assert.equal(data.v, 1);
  assert.equal(data.appearance.bgFile, '');
  assert.equal(data.appearance.background, 'stars');
  assert.equal(data.appearance.music.file, '');
  assert.equal(data.appearance.music.enabled, false);
  const code = encodeLook(look);
  assert.ok(code.startsWith(PREFIX));
  assert.ok(!/Users|musica|fondo\.png/.test(code));
  assert.ok(!/Users|musica|fondo\.png/.test(Buffer.from(code.slice(PREFIX.length), 'base64').toString('utf8')));
});

test('ida y vuelta por el código, con acentos y espacios', () => {
  const look = lookFromSettings({ appearance: { ...AP, background: 'wallpaper' }, branding: { ...BR, name: 'Niño ñandú' } }, 'Año nuevo ✨');
  const code = encodeLook(look);
  const r = decodeLook(`  ${code.toLowerCase().slice(0, 11)}${code.slice(11).replace(/(.{20})/g, '$1\n')}  `);
  assert.equal(r.ok, true);
  assert.equal(r.look.name, 'Año nuevo ✨');
  assert.equal(r.look.branding.name, 'Niño ñandú');
  assert.equal(r.look.appearance.background, 'wallpaper');
  assert.equal(r.look.appearance.wallpaperId, 'wallpaper-03');
  assert.equal(r.look.appearance.scheme, 'light');
  assert.deepEqual(r.look.appearance.playButton, { color: '#ff0000', label: 'Dale', animation: 'shine', sound: 'bell' });
  assert.equal(r.look.appearance.bgFile, '');
  assert.equal(r.look.appearance.music.enabled, false);
});

test('un código pegado con rutas a mano las pierde igual', () => {
  const forged = PREFIX + Buffer.from(JSON.stringify({ v: 1, name: 'Trampa', appearance: { background: 'image', bgFile: 'C:\\x.png', music: { enabled: true, file: 'C:\\y.mp3' } } }), 'utf8').toString('base64');
  const r = decodeLook(forged);
  assert.equal(r.ok, true);
  assert.equal(r.look.appearance.background, 'stars');
  assert.equal(r.look.appearance.bgFile, '');
  assert.equal(r.look.appearance.music.file, '');
});

test('códigos inválidos', () => {
  assert.deepEqual(decodeLook(''), { ok: false, code: 'empty' });
  assert.deepEqual(decodeLook('VENUS-THEME:abc'), { ok: false, code: 'notLook' });
  assert.deepEqual(decodeLook(`${PREFIX}%%%`), { ok: false, code: 'damaged' });
  assert.deepEqual(decodeLook(`${PREFIX}${Buffer.from('{no es json').toString('base64')}`), { ok: false, code: 'damaged' });
  assert.deepEqual(decodeLook(`${PREFIX}${Buffer.from('[1,2]').toString('base64')}`), { ok: false, code: 'invalid' });
  assert.deepEqual(decodeLook(`${PREFIX}${Buffer.from(JSON.stringify({ name: 'x' })).toString('base64')}`), { ok: false, code: 'invalid' });
  assert.deepEqual(decodeLook(`${PREFIX}${Buffer.from(JSON.stringify({ name: '', appearance: {} })).toString('base64')}`), { ok: false, code: 'invalid' });
  assert.deepEqual(decodeLook(`${PREFIX}${'A'.repeat(500000)}`), { ok: false, code: 'notLook' });
  assert.throws(() => encodeLook({ name: '' }));
});

test('la lista queda limpia: válidos, ids únicos y como mucho 20', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `look-${i}`, name: `Look ${i}`, appearance: {}, branding: {}, createdAt: i + 1 }));
  const list = normalizeLooks([null, { name: '' }, { id: 'look-1', name: 'Repetido', appearance: {} }, ...many]);
  assert.equal(list.length, MAX_LOOKS);
  assert.equal(list[0].name, 'Repetido');
  assert.equal(list.filter((l) => l.id === 'look-1').length, 1);
  assert.deepEqual(normalizeLooks('x'), []);
});
