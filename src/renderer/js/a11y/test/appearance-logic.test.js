// Pruebas de la lógica pura de Apariencia (sin DOM). node --test "src/renderer/js/a11y/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPEARANCE_DEFAULTS,
  SEASONS,
  normalizeAppearance,
  normalizeBranding,
  normalizePalette,
  normalizeRotation,
  normalizePlayButton,
  normalizeSeasonalBackup,
  appearanceDefaults,
  parseTime,
  lightNow,
  effectiveScheme,
  seasonFor,
  nextRotation,
  legibleText,
  legiblePalette,
  cleanLabel,
} from '../appearance-logic.js';
import { parseColor, contrast } from '../color.js';

const at = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);

test('valores por defecto de los ajustes nuevos', () => {
  const ap = normalizeAppearance();
  assert.deepEqual(ap.palette, { bg: null, surface: null, text: null, border: null, accent: null });
  assert.equal(ap.scheme, 'dark');
  assert.equal(ap.autoLightFrom, '07:00');
  assert.equal(ap.autoLightTo, '19:00');
  assert.equal(ap.seasonal, false);
  assert.equal(ap.seasonalBackup, null);
  assert.deepEqual(ap.rotation, { enabled: false, ids: [], everyMin: 30, onLaunch: true });
  assert.deepEqual(ap.playButton, { color: 'accent', label: '', animation: 'none', sound: 'none' });
  // los objetos anidados no se comparten con los defaults
  const d = appearanceDefaults();
  d.rotation.ids.push('x');
  assert.deepEqual(APPEARANCE_DEFAULTS.rotation.ids, []);
  assert.deepEqual(appearanceDefaults().rotation.ids, []);
});

test('la normalización vieja sigue igual', () => {
  const ap = normalizeAppearance({ accent: 'pluto', customColor: 'rojo', bgDim: 500, uiFont: 'comic', music: { volume: -3 } });
  assert.equal(ap.accent, 'venus');
  assert.equal(ap.customColor, '#f29a2e');
  assert.equal(ap.bgDim, 90);
  assert.equal(ap.uiFont, 'outfit');
  assert.equal(ap.music.volume, 0);
  const br = normalizeBranding({ name: 'x'.repeat(50), logo: 'javascript:alert(1)', server: '  play.x.com ' });
  assert.equal(br.name.length, 24);
  assert.equal(br.logo, '');
  assert.equal(br.server, 'play.x.com');
});

test('paleta: hex válidos en minúsculas, el resto a null', () => {
  assert.deepEqual(normalizePalette({ bg: '#ABCDEF', text: 'red', border: '#fff', accent: 123, extra: '#000000' }), { bg: '#abcdef', surface: null, text: null, border: null, accent: null });
  assert.deepEqual(normalizePalette(null), { bg: null, surface: null, text: null, border: null, accent: null });
  assert.deepEqual(normalizeAppearance({ palette: 'x' }).palette, { bg: null, surface: null, text: null, border: null, accent: null });
});

test('esquema y horario: valores inválidos caen al defecto', () => {
  assert.equal(normalizeAppearance({ scheme: 'sepia' }).scheme, 'dark');
  assert.equal(normalizeAppearance({ scheme: 'auto' }).scheme, 'auto');
  const ap = normalizeAppearance({ autoLightFrom: '25:00', autoLightTo: '8:5' });
  assert.equal(ap.autoLightFrom, '07:00');
  assert.equal(ap.autoLightTo, '08:05');
  assert.equal(parseTime('07:30'), 450);
  assert.equal(parseTime('24:00'), null);
  assert.equal(parseTime('x'), null);
});

test('¿es de día? (incluido un rango que cruza la medianoche)', () => {
  assert.equal(lightNow('08:30', '07:00', '19:00'), true);
  assert.equal(lightNow('06:59', '07:00', '19:00'), false);
  assert.equal(lightNow('19:00', '07:00', '19:00'), false);
  assert.equal(lightNow('18:59', '07:00', '19:00'), true);
  assert.equal(lightNow('23:00', '21:00', '07:00'), true);
  assert.equal(lightNow('03:00', '21:00', '07:00'), true);
  assert.equal(lightNow('12:00', '21:00', '07:00'), false);
  assert.equal(lightNow('12:00', '09:00', '09:00'), false);
  assert.equal(lightNow(new Date(2026, 0, 1, 10, 0), '07:00', '19:00'), true);
  const ap = normalizeAppearance({ scheme: 'auto' });
  assert.equal(effectiveScheme(ap, new Date(2026, 0, 1, 10, 0)), 'light');
  assert.equal(effectiveScheme(ap, new Date(2026, 0, 1, 22, 0)), 'dark');
  assert.equal(effectiveScheme(normalizeAppearance({ scheme: 'light' }), new Date(2026, 0, 1, 22, 0)), 'light');
  assert.equal(effectiveScheme(normalizeAppearance({ scheme: 'dark' }), new Date(2026, 0, 1, 10, 0)), 'dark');
});

test('temporadas: rangos de fechas y cambio de año', () => {
  assert.equal(seasonFor(at(2026, 10, 23)), null);
  assert.equal(seasonFor(at(2026, 10, 24)), 'halloween');
  assert.equal(seasonFor(at(2026, 10, 31)), 'halloween');
  assert.equal(seasonFor(at(2026, 11, 1)), 'halloween');
  assert.equal(seasonFor(at(2026, 11, 2)), null);
  assert.equal(seasonFor(at(2026, 12, 14)), null);
  assert.equal(seasonFor(at(2026, 12, 15)), 'christmas');
  assert.equal(seasonFor(at(2026, 12, 25)), 'christmas');
  assert.equal(seasonFor(at(2026, 12, 30)), 'christmas');
  assert.equal(seasonFor(at(2026, 12, 31)), 'newyear'); // gana sobre Navidad
  assert.equal(seasonFor(at(2027, 1, 1)), 'newyear');
  assert.equal(seasonFor(at(2027, 1, 2)), 'newyear');
  assert.equal(seasonFor(at(2027, 1, 3)), 'christmas');
  assert.equal(seasonFor(at(2027, 1, 6)), 'christmas');
  assert.equal(seasonFor(at(2027, 1, 7)), null);
  assert.equal(seasonFor(at(2026, 6, 15)), null);
  for (const s of SEASONS) assert.match(s.accent, /^#[0-9a-f]{6}$/);
});

test('copia de la temporada', () => {
  assert.equal(normalizeSeasonalBackup(null), null);
  assert.equal(normalizeSeasonalBackup({ season: 'easter' }), null);
  assert.deepEqual(normalizeSeasonalBackup({ season: 'halloween', accent: 'pluto', customColor: 'x', background: 'video', wallpaperId: 'nope' }), {
    season: 'halloween',
    accent: 'venus',
    customColor: '#f29a2e',
    background: 'stars',
    wallpaperId: APPEARANCE_DEFAULTS.wallpaperId,
  });
  assert.equal(normalizeAppearance({ seasonalBackup: 'x' }).seasonalBackup, null);
});

test('rotación: ids válidos y únicos, minutos acotados y el siguiente fondo', () => {
  const r = normalizeRotation({ enabled: 'yes', ids: ['wallpaper-01', 'nope', 'wallpaper-01', 'live-01', 7], everyMin: 0, onLaunch: 0 });
  assert.deepEqual(r, { enabled: true, ids: ['wallpaper-01', 'live-01'], everyMin: 1, onLaunch: false });
  assert.equal(normalizeRotation({ everyMin: 99999 }).everyMin, 720);
  assert.equal(normalizeRotation({ everyMin: 'x' }).everyMin, 30);
  assert.deepEqual(normalizeRotation({ ids: 'wallpaper-01' }).ids, []);
  assert.equal(nextRotation(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(nextRotation(['a', 'b', 'c'], 'c'), 'a');
  assert.equal(nextRotation(['a', 'b', 'c'], 'zz'), 'a');
  assert.equal(nextRotation(['a'], 'a'), 'a');
  assert.equal(nextRotation([], 'a'), null);
  assert.equal(nextRotation(null, 'a'), null);
});

test('botón Jugar: color, texto, animación y sonido', () => {
  assert.deepEqual(normalizePlayButton({ color: '#FF0000', label: '  Dale\u0000 gas  ', animation: 'spin', sound: 'bell' }), { color: '#ff0000', label: 'Dale gas', animation: 'none', sound: 'bell' });
  assert.deepEqual(normalizePlayButton({ color: 'red', animation: 'pulse', sound: 'meow' }), { color: 'accent', label: '', animation: 'pulse', sound: 'none' });
  assert.equal(normalizePlayButton({ label: 'x'.repeat(40) }).label.length, 16);
  assert.equal(cleanLabel('\tJUGAR YA\n'), 'JUGAR YA');
  assert.deepEqual(normalizeAppearance({ playButton: null }).playButton, { color: 'accent', label: '', animation: 'none', sound: 'none' });
});

test('texto legible: se corrige solo cuando el contraste baja de 4.5', () => {
  assert.equal(legibleText('#fff3e3', '#0c0705'), '#fff3e3');
  const fixedOnDark = legibleText('#333333', '#0c0705');
  assert.ok(contrast(parseColor(fixedOnDark), parseColor('#0c0705')) >= 4.5, fixedOnDark);
  const fixedOnLight = legibleText('#dddddd', '#f4ece2');
  assert.ok(contrast(parseColor(fixedOnLight), parseColor('#f4ece2')) >= 4.5, fixedOnLight);
  // un color con tono conserva el tono al corregirse
  const fixedBlue = legibleText('#1a2a5a', '#0c0705');
  assert.ok(contrast(parseColor(fixedBlue), parseColor('#0c0705')) >= 4.5, fixedBlue);
  const c = parseColor(fixedBlue);
  assert.ok(c.b > c.r, 'sigue siendo azul');
  assert.equal(legibleText('nope', '#000000'), null);
  const r = legiblePalette({ bg: '#101010', text: '#202020' }, '#0c0705');
  assert.ok(r.adjustedText && r.palette.text === r.adjustedText);
  assert.ok(contrast(parseColor(r.palette.text), parseColor('#101010')) >= 4.5);
  assert.deepEqual(legiblePalette({ text: '#ffffff' }, '#0c0705'), { palette: { bg: null, surface: null, text: '#ffffff', border: null, accent: null }, adjustedText: null });
  assert.equal(legiblePalette({ text: '#ffffff' }, null).adjustedText, null);
});
