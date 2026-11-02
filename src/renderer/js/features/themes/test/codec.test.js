// Pruebas de la lógica de temas (sin DOM). node --test "src/renderer/js/features/themes/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREFIX,
  themeProblem,
  validTheme,
  cleanThemeName,
  themeFromAppearance,
  appearanceFromTheme,
  encodeTheme,
  decodeTheme,
  sameTheme,
  serverErrorKey,
  isMissingSchema,
} from '../codec.js';

const AP = { accent: 'neptune', customColor: '#3FA2FF', tint: true, background: 'wallpaper', wallpaperId: 'img-03', bgFile: 'C:\\Users\\Yo\\fondo.png', bgDim: 40, bgBlur: 6, music: { enabled: true, file: 'C:\\musica.mp3' } };

test('valida igual que theme_valid del servidor', () => {
  assert.equal(themeProblem({}), null);
  assert.equal(themeProblem({ accent: 'venus', customColor: '#aBcDeF', tint: 0, background: 'stars', wallpaper: 'live-01', bgDim: 100, bgBlur: 0 }), null);
  assert.equal(themeProblem(null), 'notObject');
  assert.equal(themeProblem([]), 'notObject');
  assert.equal(themeProblem({ bgFile: 'C:\\x.png' }), 'unknownKey');
  assert.equal(themeProblem({ accent: 'pluto' }), 'accent');
  assert.equal(themeProblem({ customColor: '#fff' }), 'customColor');
  assert.equal(themeProblem({ customColor: 123456 }), 'customColor');
  assert.equal(themeProblem({ tint: 101 }), 'tint');
  assert.equal(themeProblem({ tint: '50' }), 'tint');
  assert.equal(themeProblem({ background: 'image' }), 'background');
  assert.equal(themeProblem({ wallpaper: '../../etc/passwd' }), 'wallpaper');
  assert.equal(themeProblem({ wallpaper: 'a'.repeat(81) }), 'wallpaper');
  assert.equal(themeProblem({ bgDim: -1 }), 'bgDim');
  assert.equal(themeProblem({ bgBlur: Infinity }), 'bgBlur');
  assert.ok(validTheme({ tint: 55.5 }));
});

test('nombres para publicar', () => {
  assert.equal(cleanThemeName('  Atardecer  '), 'Atardecer');
  assert.equal(cleanThemeName('A'), null);
  assert.equal(cleanThemeName('x'.repeat(41)), null);
  assert.equal(cleanThemeName('<b>hola</b>'), null);
  assert.equal(cleanThemeName(`a${String.fromCharCode(7)}b`), null);
  assert.equal(cleanThemeName('Tema rojo 2'), 'Tema rojo 2');
});

test('exportar nunca lleva rutas de la PC', () => {
  const { theme, usedStars } = themeFromAppearance(AP);
  assert.equal(usedStars, false);
  assert.deepEqual(theme, { accent: 'neptune', customColor: '#3fa2ff', tint: 100, background: 'wallpaper', bgDim: 40, bgBlur: 6, wallpaper: 'img-03' });
  const code = encodeTheme(theme);
  assert.ok(code.startsWith(PREFIX));
  assert.ok(!/Users|musica|fondo/.test(atob(code.slice(PREFIX.length))));
});

test('fondo propio (imagen de la PC) se exporta como estrellas y avisa', () => {
  const { theme, usedStars } = themeFromAppearance({ ...AP, background: 'image' });
  assert.equal(usedStars, true);
  assert.equal(theme.background, 'stars');
  assert.equal('wallpaper' in theme, false);
  const r = themeFromAppearance({ ...AP, wallpaperId: 'no-existe' }, { isWallpaper: (id) => id === 'img-03' });
  assert.equal(r.usedStars, true);
  assert.equal(r.theme.background, 'stars');
});

test('ida y vuelta por el código', () => {
  const { theme } = themeFromAppearance(AP);
  const back = decodeTheme(encodeTheme(theme));
  assert.equal(back.ok, true);
  assert.ok(sameTheme(back.theme, theme));
  // con espacios, saltos de línea, prefijo en minúsculas y base64 para URL sin relleno
  const code = encodeTheme({ accent: 'custom', customColor: '#ff00aa', bgBlur: 3 });
  const messy = `  venus-theme:${code.slice(PREFIX.length).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}\n`;
  const r = decodeTheme(messy.replace(/(.{10})/g, '$1 '));
  assert.equal(r.ok, true);
  assert.deepEqual(r.theme, { accent: 'custom', customColor: '#ff00aa', bgBlur: 3 });
});

test('códigos inválidos', () => {
  assert.deepEqual(decodeTheme(''), { ok: false, code: 'empty' });
  assert.deepEqual(decodeTheme('VENUS-PACK:abc'), { ok: false, code: 'notTheme' });
  assert.deepEqual(decodeTheme(`${PREFIX}%%%`), { ok: false, code: 'damaged' });
  assert.deepEqual(decodeTheme(`${PREFIX}${btoa('{no es json')}`), { ok: false, code: 'damaged' });
  assert.deepEqual(decodeTheme(`${PREFIX}${btoa(JSON.stringify({ bgFile: 'C:\\x.png' }))}`), { ok: false, code: 'invalid' });
  assert.deepEqual(decodeTheme(`${PREFIX}${btoa(JSON.stringify({ accent: 'venus', tint: 500 }))}`), { ok: false, code: 'invalid' });
  assert.deepEqual(decodeTheme(`${PREFIX}${'A'.repeat(5000)}`), { ok: false, code: 'notTheme' });
  assert.throws(() => encodeTheme({ accent: 'pluto' }));
});

test('aplicar un tema recorta a los rangos del launcher', () => {
  const { patch, missingWallpaper } = appearanceFromTheme({ accent: 'custom', customColor: '#ABCDEF', tint: 0, background: 'wallpaper', wallpaper: 'img-03', bgDim: 100, bgBlur: 80 });
  assert.equal(missingWallpaper, false);
  assert.deepEqual(patch, { accent: 'custom', customColor: '#abcdef', tint: false, background: 'wallpaper', wallpaperId: 'img-03', bgDim: 90, bgBlur: 24 });
  const r = appearanceFromTheme({ background: 'wallpaper', wallpaper: 'img-99' }, { isWallpaper: () => false });
  assert.equal(r.missingWallpaper, true);
  assert.equal(r.patch.background, 'stars');
  assert.equal(appearanceFromTheme({ accent: 'custom' }).patch.accent, 'venus');
  assert.equal(appearanceFromTheme({}).patch.tint, true);
});

test('errores del servidor', () => {
  assert.equal(serverErrorKey({ message: 'too_many_themes' }), 'too_many_themes');
  assert.equal(serverErrorKey(new Error('user_muted')), 'user_muted');
  assert.equal(serverErrorKey({ message: 'algo raro' }), null);
  assert.equal(isMissingSchema({ code: 'PGRST202', message: 'Could not find the function public.theme_list' }), true);
  assert.equal(isMissingSchema({ code: '22023', message: 'bad_name' }), false);
});
