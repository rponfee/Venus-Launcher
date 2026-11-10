// Pruebas del estilo de la interfaz (6.1): normalización de los ajustes nuevos, looks y códigos con y sin esos campos,
// y la página de inicio. node --test "src/renderer/js/features/themes/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAppearance, styleDefaults, startRouteFor, normalizeTitlebar, STYLE_KEYS, UI_FONTS, START_PAGES, APPEARANCE_DEFAULTS } from '../../../a11y/appearance-logic.js';
import { normalizeLook, lookFromSettings, encodeLook, decodeLook, PREFIX, SKIP_KEYS } from '../looks.js';

test('de fábrica: nada cambia para quien no tocó nada', () => {
  const ap = normalizeAppearance({});
  assert.equal(ap.uiFont, 'outfit');
  assert.equal(ap.uiText, 'normal');
  assert.equal(ap.uiCards, 'glass');
  assert.equal(ap.uiSide, 'left');
  assert.equal(ap.uiSidebar, 'full');
  assert.equal(ap.uiRadius, 'normal');
  assert.equal(ap.uiDensity, 'normal');
  assert.equal(ap.startPage, 'home');
  assert.deepEqual(ap.titlebar, { clock: false, instance: false });
});

test('valores válidos se conservan y los desconocidos vuelven al de fábrica', () => {
  const ok = normalizeAppearance({ uiFont: 'pixel', uiText: 'large', uiCards: 'outline', uiSide: 'right', uiSidebar: 'icons', uiRadius: 'round', uiDensity: 'compact', startPage: 'last', titlebar: { clock: true, instance: true } });
  assert.deepEqual([ok.uiFont, ok.uiText, ok.uiCards, ok.uiSide, ok.uiSidebar, ok.uiRadius, ok.uiDensity, ok.startPage], ['pixel', 'large', 'outline', 'right', 'icons', 'round', 'compact', 'last']);
  assert.deepEqual(ok.titlebar, { clock: true, instance: true });
  const bad = normalizeAppearance({ uiFont: 'comic', uiText: 99, uiCards: null, uiSide: 'top', uiSidebar: 'mini', uiRadius: {}, uiDensity: 'xx', startPage: 'admin', titlebar: 'si' });
  assert.deepEqual([bad.uiFont, bad.uiText, bad.uiCards, bad.uiSide, bad.uiSidebar, bad.uiRadius, bad.uiDensity, bad.startPage], ['outfit', 'normal', 'glass', 'left', 'full', 'normal', 'normal', 'home']);
  assert.deepEqual(bad.titlebar, { clock: false, instance: false });
  // solo true cuenta (un "1" o "true" de texto no prende nada)
  assert.deepEqual(normalizeTitlebar({ clock: 'true', instance: 1 }), { clock: false, instance: false });
  assert.ok(UI_FONTS.includes('pixel'));
});

test('restablecer estilo: solo las claves del estilo, con sus valores de fábrica', () => {
  const d = styleDefaults();
  assert.deepEqual(Object.keys(d).sort(), [...STYLE_KEYS].sort());
  for (const k of STYLE_KEYS) assert.equal(d[k], APPEARANCE_DEFAULTS[k], k);
  assert.ok(!('startPage' in d) && !('accent' in d));
});

test('un look guarda el estilo nuevo, pero no la página de inicio ni la barra de título', () => {
  const look = lookFromSettings({ appearance: { uiFont: 'pixel', uiCards: 'solid', uiSide: 'right', uiText: 'small', startPage: 'worlds', titlebar: { clock: true } }, branding: {} }, 'Pixel');
  assert.equal(look.appearance.uiFont, 'pixel');
  assert.equal(look.appearance.uiCards, 'solid');
  assert.equal(look.appearance.uiSide, 'right');
  assert.equal(look.appearance.uiText, 'small');
  for (const k of SKIP_KEYS) assert.ok(!(k in look.appearance), k);
  const back = decodeLook(encodeLook(look));
  assert.ok(back.ok);
  assert.equal(back.look.appearance.uiFont, 'pixel');
  assert.equal(back.look.appearance.uiSide, 'right');
  assert.ok(!('startPage' in back.look.appearance));
});

test('looks y códigos anteriores a la 6.1 (sin los campos nuevos) siguen cargando con el estilo de fábrica', () => {
  const old = normalizeLook({ id: 'look-viejo', name: 'Viejo', appearance: { accent: 'mars', uiRadius: 'sharp', uiFont: 'mono' }, branding: {} });
  assert.equal(old.appearance.accent, 'mars');
  assert.equal(old.appearance.uiRadius, 'sharp');
  assert.equal(old.appearance.uiFont, 'mono');
  assert.equal(old.appearance.uiCards, 'glass');
  assert.equal(old.appearance.uiSide, 'left');
  assert.equal(old.appearance.uiText, 'normal');
  // un código armado a mano como los de la 3.x
  const json = JSON.stringify({ v: 1, name: 'Código viejo', appearance: { accent: 'neptune', uiDensity: 'spacious' }, branding: {} });
  const code = PREFIX + Buffer.from(json, 'utf8').toString('base64');
  const r = decodeLook(code);
  assert.ok(r.ok);
  assert.equal(r.look.appearance.accent, 'neptune');
  assert.equal(r.look.appearance.uiDensity, 'spacious');
  assert.equal(r.look.appearance.uiCards, 'glass');
  // y un código con valores inventados se normaliza
  const weird = PREFIX + Buffer.from(JSON.stringify({ name: 'Raro', appearance: { uiFont: '<script>', uiCards: 'neon', uiSide: 'arriba', startPage: 'last' } }), 'utf8').toString('base64');
  const w = decodeLook(weird);
  assert.ok(w.ok);
  assert.equal(w.look.appearance.uiFont, 'outfit');
  assert.equal(w.look.appearance.uiCards, 'glass');
  assert.equal(w.look.appearance.uiSide, 'left');
  assert.ok(!('startPage' in w.look.appearance));
});

test('página de inicio: elegida, última visitada y rutas que no sirven', () => {
  for (const p of START_PAGES.filter((x) => x !== 'last')) assert.equal(startRouteFor(p, 'worlds'), p);
  assert.equal(startRouteFor('nada', 'worlds'), 'home');
  assert.equal(startRouteFor('last', 'worlds'), 'worlds');
  assert.equal(startRouteFor('last', '#/modrinth/mod/sodium'), 'modrinth');
  assert.equal(startRouteFor('last', 'instance/abc'), 'versions');
  assert.equal(startRouteFor('last', 'server/xyz'), 'servers');
  assert.equal(startRouteFor('last', 'welcome'), 'home');
  assert.equal(startRouteFor('last', 'admin'), 'home');
  assert.equal(startRouteFor('last', ''), 'home');
  assert.equal(startRouteFor('last', null), 'home');
  assert.equal(startRouteFor('last', '../../etc'), 'home');
  assert.equal(startRouteFor('last', 'javascript:alert(1)'), 'home');
});
