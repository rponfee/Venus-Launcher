// Armado del aspecto por instancia, su vuelta al global y el link de una instancia.
// node --test "src/renderer/js/features/instancelook/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { normalizeAppearance } from '../../../a11y/appearance-logic.js';
import { WALLPAPERS } from '../../../wallpapers.js';
import { normalizeLook, lookPatch, mergeLook, pickLookInstance, lookFromSaved, instanceLink } from '../logic.js';

const require = createRequire(import.meta.url);
const { parseLink } = require('../../../../../main/modules/deeplink/parse.js');
const meta = require('../../../../../main/modules/instancemeta/meta.js');

const image = WALLPAPERS.find((w) => !w.video);
const LOOK = {
  color: { accent: 'neptune' },
  background: { type: 'image', file: 'C:\\Fotos\\fondo.png', dim: 30, blur: 8 },
  music: { type: 'file', file: 'C:\\Música\\tema.mp3', volume: 70, pauseInGame: false },
};

test('normalizeLook descarta lo que no sirve', () => {
  assert.deepEqual(normalizeLook(LOOK), LOOK);
  assert.equal(normalizeLook(null), null);
  assert.equal(normalizeLook({}), null);
  assert.equal(normalizeLook({ color: { accent: 'pluton' }, background: { type: 'wallpaper', id: 'no-existe' }, music: { type: 'rara' } }), null);
  assert.deepEqual(normalizeLook({ color: { accent: 'custom', customColor: '#ABCDEF' } }), { color: { accent: 'custom', customColor: '#abcdef' } });
  assert.deepEqual(normalizeLook({ background: { type: 'wallpaper', id: image.id, dim: 500 } }), { background: { type: 'wallpaper', id: image.id, dim: 90, blur: 0 } });
});

test('el proceso principal y la interfaz coinciden en la forma del aspecto', () => {
  assert.deepEqual(meta.normalizeLook(LOOK), normalizeLook(LOOK));
  const wall = { color: { accent: 'custom', customColor: '#112233' }, background: { type: 'wallpaper', id: image.id, dim: 10, blur: 2 }, music: { type: 'off' } };
  assert.deepEqual(meta.normalizeLook(wall), normalizeLook(wall));
});

test('el aspecto se arma encima de lo global y la vuelta devuelve lo mismo, sin tocar nada', () => {
  const global = normalizeAppearance({ accent: 'mars', background: 'wallpaper', wallpaperId: image.id, bgDim: 60, music: { enabled: true, file: 'C:\\global.mp3', volume: 20, pauseInGame: true }, palette: { accent: '#010203', bg: '#112233' }, scheme: 'light', uiFont: 'mono' });
  const before = JSON.stringify(global);

  const shown = mergeLook(global, lookPatch(LOOK));
  assert.equal(shown.accent, 'neptune');
  assert.equal(shown.background, 'image');
  assert.equal(shown.bgFile, 'C:\\Fotos\\fondo.png');
  assert.equal(shown.bgDim, 30);
  assert.equal(shown.bgBlur, 8);
  assert.deepEqual(shown.music, { enabled: true, file: 'C:\\Música\\tema.mp3', volume: 70, pauseInGame: false });
  assert.equal(shown.palette.accent, null, 'el color de la instancia manda sobre el del editor');
  assert.equal(shown.palette.bg, '#112233', 'el resto del editor de colores sigue igual');
  assert.equal(shown.scheme, 'light');
  assert.equal(shown.uiFont, 'mono');

  assert.equal(JSON.stringify(global), before, 'los ajustes globales no se tocan');
  assert.equal(mergeLook(global, null), global, 'sin aspecto vuelve el global, el mismo objeto');
  assert.equal(mergeLook(global, lookPatch(null)), global);
});

test('solo cambia lo que la instancia elige', () => {
  const global = normalizeAppearance({ accent: 'mars', background: 'stars', music: { enabled: true, file: 'C:\\global.mp3', volume: 20 }, palette: { accent: '#010203' } });
  const onlyColor = mergeLook(global, lookPatch({ color: { accent: 'custom', customColor: '#00ff00' } }));
  assert.equal(onlyColor.accent, 'custom');
  assert.equal(onlyColor.customColor, '#00ff00');
  assert.equal(onlyColor.background, 'stars');
  assert.equal(onlyColor.music.file, 'C:\\global.mp3');

  const onlyBack = mergeLook(global, lookPatch({ background: { type: 'wallpaper', id: image.id, dim: 15, blur: 0 } }));
  assert.equal(onlyBack.accent, 'mars');
  assert.equal(onlyBack.palette.accent, '#010203', 'sin color propio el editor sigue mandando');
  assert.equal(onlyBack.background, 'wallpaper');
  assert.equal(onlyBack.wallpaperId, image.id);

  const silent = mergeLook(global, lookPatch({ music: { type: 'off' } }));
  assert.equal(silent.music.enabled, false);
  assert.equal(silent.music.file, 'C:\\global.mp3');
  assert.equal(global.music.enabled, true);

  assert.equal(mergeLook(normalizeAppearance({ background: 'image', bgFile: 'C:\\a.png' }), lookPatch({ background: { type: 'stars' } })).background, 'stars');
});

test('modo liviano: sin video propio ni desenfoque', () => {
  const video = { color: { accent: 'earth' }, background: { type: 'image', file: 'C:\\clip.mp4', dim: 30, blur: 10 } };
  assert.deepEqual(lookPatch(video, { lite: true }), { accent: 'earth' });
  assert.equal(lookPatch({ background: video.background }, { lite: true }), null);
  assert.equal(lookPatch(video).bgFile, 'C:\\clip.mp4');
  assert.equal(lookPatch(LOOK, { lite: true }).bgBlur, 0);
  assert.equal(lookPatch({ background: { type: 'wallpaper', id: image.id, dim: 10, blur: 9 } }, { lite: true }).bgBlur, 0);
  assert.equal(lookPatch(LOOK).bgBlur, 8);
});

test('pickLookInstance: la que corre con aspecto primero, después la elegida', () => {
  const A = { id: 'a', look: { color: { accent: 'mars' } } };
  const B = { id: 'b', look: { color: { accent: 'earth' } } };
  const C = { id: 'c' };
  const instances = [C, A, B];
  assert.equal(pickLookInstance({ instances, selectedId: 'a' }), A);
  assert.equal(pickLookInstance({ instances, selectedId: 'c' }), null, 'la elegida no tiene aspecto: se ve el global');
  assert.equal(pickLookInstance({ instances: [A, B], selectedId: null }), A, 'sin elegida, la primera, como selectedInstance()');
  assert.equal(pickLookInstance({ instances: [C, A], selectedId: 'borrada' }), null);
  assert.equal(pickLookInstance({ instances, selectedId: 'a', running: { b: { state: 'running', startedAt: 5 } } }), B, 'la que corre gana a la elegida');
  assert.equal(pickLookInstance({ instances, selectedId: 'a', running: { b: { state: 'running', startedAt: 5 }, a: { state: 'running', startedAt: 9 } } }), A, 'la última que arrancó');
  assert.equal(pickLookInstance({ instances, selectedId: 'a', running: { c: { state: 'running', startedAt: 5 } } }), A, 'la que corre no tiene aspecto: se mira la elegida');
  assert.equal(pickLookInstance({ instances, selectedId: 'c', running: { b: { state: 'running', quiet: true } } }), null, 'una partida silenciosa no cuenta');
  assert.equal(pickLookInstance({ instances, selectedId: 'c', running: { b: { state: 'stopped' } } }), null);
  assert.equal(pickLookInstance({}), null);
});

test('lookFromSaved reusa color, fondo y música de un look guardado', () => {
  const look = lookFromSaved({ name: 'Mío', appearance: { accent: 'custom', customColor: '#123456', background: 'image', bgFile: 'C:\\a.png', bgDim: 10, bgBlur: 5, wallpaperId: image.id, music: { enabled: true, file: 'C:\\b.mp3', volume: 40, pauseInGame: true } } });
  assert.deepEqual(look, { color: { accent: 'custom', customColor: '#123456' }, background: { type: 'image', file: 'C:\\a.png', dim: 10, blur: 5 }, music: { type: 'file', file: 'C:\\b.mp3', volume: 40, pauseInGame: true } });
  assert.deepEqual(lookFromSaved({ appearance: { accent: 'venus', background: 'stars', music: { enabled: false, file: '' } } }), { color: { accent: 'venus' }, background: { type: 'stars' }, music: { type: 'off' } });
  assert.deepEqual(lookFromSaved({ appearance: { accent: 'venus', background: 'wallpaper', wallpaperId: image.id, bgDim: 1, bgBlur: 2 } }).background, { type: 'wallpaper', id: image.id, dim: 1, blur: 2 });
  assert.equal(lookFromSaved(null), null);
});

test('instanceLink: el modpack de origen o la instancia, y el parser lo acepta', () => {
  const mr = instanceLink({ id: 'x', modrinth: { pack: { projectId: '1KVo5zza', versionId: 'AbCd1234' } } });
  assert.equal(mr.link, 'venus://modpack/modrinth/1KVo5zza?version=AbCd1234');
  assert.equal(mr.kind, 'modpack');
  assert.equal(parseLink(mr.link).version, 'AbCd1234');
  const cf = instanceLink({ id: 'x', modrinth: { projects: {}, pack: null }, curseforge: { pack: { projectId: 285109, fileId: 1 } } });
  assert.equal(cf.link, 'venus://modpack/curseforge/285109');
  assert.equal(parseLink(cf.link).modId, 285109);
  const own = instanceLink({ id: 'fabric-1.21-a1b2', modrinth: { pack: { name: 'sin proyecto' } } });
  assert.equal(own.kind, 'instance');
  assert.equal(parseLink(own.link).id, 'fabric-1.21-a1b2');
  assert.equal(instanceLink({ modrinth: { pack: { projectId: 'tiene espacios' } } }), null);
  assert.equal(instanceLink(null), null);
});
