'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const uv = require('../uv');
const logic = require('../logic');
const skinai = require('../../skinai');

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

// Una respuesta valida de la IA: base marron, camisa naranja en el torso, la cabeza clara
function fakeAnswer({ holes = false, outer = true } = {}) {
  const map = uv.layerMap('classic');
  const rows = [];
  for (let y = 0; y < 64; y++) {
    let row = '';
    for (let x = 0; x < 64; x++) {
      const layer = map[y * 64 + x];
      if (!layer) row += 'z';
      else if (layer === 2) row += outer && x >= 32 && y < 8 ? '2' : '.';
      else if (holes && x % 2 === 0) row += '.';
      else row += y < 16 ? '1' : '0';
    }
    rows.push(row);
  }
  return { palette: ['#5a4636', '#e0a050', '#222222'], rows, notes: 'Listo' };
}

test('el mapa UV de la IA coincide con el del editor (clasico y slim)', async () => {
  const L = await import(pathToFileURL(path.join(__dirname, '../../../../renderer/js/pages/skins/editor/logic.js')).href);
  for (const variant of ['classic', 'slim']) {
    const key = (layer, [x, y, w, h]) => `${layer}:${x},${y},${w},${h}`;
    const mine = new Set(uv.zones(variant).map((z) => key(z.layer, z.rect)));
    const theirs = new Set(L.zones(variant).map((z) => key(z.layer, z.rect)));
    assert.deepEqual([...mine].sort(), [...theirs].sort(), variant);
  }
});

test('el texto del mapa nombra la capa base y la exterior', () => {
  const text = uv.describeLayout('slim');
  assert.match(text, /BASE LAYER/);
  assert.match(text, /OUTER LAYER/);
  assert.match(text, /rightArm front: x 44\.\.46/);
});

test('el pedido se limpia: imagenes validas, tope, texto y colores', () => {
  const ok = logic.cleanRequest({ images: [PNG, JPG], text: '  guerrero\u0000 de   tierra ', variant: 'slim', hints: ['#FFAA00', 'rojo', '00ff00'] });
  assert.equal(ok.ok, true);
  assert.equal(ok.req.variant, 'slim');
  assert.equal(ok.req.text, 'guerrero de tierra');
  assert.deepEqual(ok.req.hints, ['#ffaa00', '#00ff00']);
  assert.equal(ok.req.images[1].mediaType, 'image/jpeg');
  assert.equal(logic.cleanRequest({ images: ['http://x/a.png'], text: 'hola mundo' }).code, 'badImage');
  assert.equal(logic.cleanRequest({ images: ['data:image/svg+xml;base64,AAAA'], text: 'hola' }).code, 'badImage');
  assert.equal(logic.cleanRequest({ images: [`data:image/png;base64,${'A'.repeat(200 * 1024)}`] }).code, 'bigImage');
  assert.equal(logic.cleanRequest({ images: [] , text: 'ab' }).code, 'needInput');
  assert.equal(logic.cleanRequest({ mode: 'edit', text: 'más rojo', current: new Uint8Array(10) }).code, 'badSkin');
  assert.equal(logic.cleanRequest({ mode: 'edit', text: '', current: new Uint8Array(16384) }).code, 'needText');
  assert.equal(logic.cleanRequest({ images: [PNG, PNG, PNG, PNG], text: 'x'.repeat(900) }).req.images.length, 3);
  assert.equal(logic.cleanRequest({ images: [PNG], text: 'x'.repeat(900) }).req.text.length, logic.MAX_TEXT);
});

test('decodeSkin arma los 16384 bytes, borra lo que el juego no usa y respeta la capa exterior', () => {
  const out = logic.decodeSkin(fakeAnswer(), { variant: 'classic', outer: true });
  assert.equal(out.px.length, 16384);
  assert.equal(out.filled, 0);
  const at = (x, y) => [...out.px.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4)];
  assert.deepEqual(at(10, 10), [0xe0, 0xa0, 0x50, 255]); // cabeza (y < 16)
  assert.deepEqual(at(20, 20), [0x5a, 0x46, 0x36, 255]); // torso
  assert.deepEqual(at(40, 2), [0x22, 0x22, 0x22, 255]); // sombrero (capa exterior)
  assert.equal(at(63, 63)[3], 0); // fuera del mapa
  assert.equal(at(60, 20)[3], 0); // tampoco se usa
  const noOuter = logic.decodeSkin(fakeAnswer(), { variant: 'classic', outer: false });
  assert.equal(noOuter.px[(2 * 64 + 40) * 4 + 3], 0);
});

test('decodeSkin rellena los huecos de la capa base y rechaza lo que viene vacio', () => {
  const out = logic.decodeSkin(fakeAnswer({ holes: true }), { variant: 'classic' });
  assert.ok(out.filled > 0);
  for (const z of uv.zones('classic').filter((q) => q.layer === 'base')) {
    const [x0, y0, w, h] = z.rect;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) assert.equal(out.px[(y * 64 + x) * 4 + 3], 255, `${z.id} ${x},${y}`);
  }
  assert.throws(() => logic.decodeSkin({ palette: ['#ffffff'], rows: [] }), { code: 'skinai:bad' });
  assert.throws(() => logic.decodeSkin({ palette: ['#ffffff', '#000000'], rows: Array(64).fill('.'.repeat(64)) }), { code: 'skinai:bad' });
  assert.throws(() => logic.decodeSkin(null), { code: 'skinai:bad' });
  // filas cortas, de mas o con caracteres raros no rompen nada
  const messy = fakeAnswer();
  messy.rows = messy.rows.map((r, i) => (i % 3 === 0 ? r.slice(0, 30) : i % 3 === 1 ? `${r}ZZZ` : r.replace(/0/g, '?')));
  assert.doesNotThrow(() => logic.decodeSkin(messy, { variant: 'classic' }));
});

test('encodeSkin y decodeSkin son inversos para una skin con pocos colores', () => {
  const first = logic.decodeSkin(fakeAnswer(), { variant: 'classic' });
  const enc = logic.encodeSkin(first.px, 'classic');
  assert.equal(enc.rows.length, 64);
  assert.ok(enc.rows.every((r) => r.length === 64));
  assert.ok(enc.palette.length <= logic.MAX_COLORS);
  const back = logic.decodeSkin(enc, { variant: 'classic' });
  assert.deepEqual([...back.px], [...first.px]);
});

test('el mensaje lleva las imagenes numeradas y, al editar, la skin actual', () => {
  const create = logic.buildContent(logic.cleanRequest({ images: [PNG], text: 'tierra naranja', hints: ['#ff8800'] }).req);
  assert.equal(create.filter((b) => b.type === 'image').length, 1);
  assert.match(create.at(-1).text, /tierra naranja/);
  assert.match(create.at(-1).text, /#ff8800/);
  const first = logic.decodeSkin(fakeAnswer(), { variant: 'classic' });
  const edit = logic.buildContent(logic.cleanRequest({ mode: 'edit', text: 'botas rojas', current: first.px, currentImage: PNG }).req);
  assert.equal(edit.filter((b) => b.type === 'image').length, 1);
  assert.match(edit.at(-1).text, /botas rojas/);
  assert.match(edit.at(-1).text, /"palette"/);
  assert.match(logic.systemPrompt({ language: 'en', variant: 'slim', outer: false, edit: true }), /Do NOT use the outer layer/);
  assert.match(logic.systemPrompt({ language: 'xx' }), /español/);
});

test('generate: valida antes de llamar, usa una sola consulta y devuelve los pixeles', async () => {
  let calls = 0;
  let seen = null;
  const ai = {
    available: async () => true,
    json: async (opts) => {
      calls++;
      seen = opts;
      return fakeAnswer();
    },
  };
  await assert.rejects(() => skinai.generate({ images: ['x'], text: 'hola' }, { ai, language: 'es' }), { code: 'skinai:badImage' });
  assert.equal(calls, 0);
  const res = await skinai.generate({ images: [PNG], text: 'guerrero', variant: 'classic' }, { ai, language: 'es' });
  assert.equal(calls, 1);
  assert.equal(res.rgba.length, 16384);
  assert.equal(seen.maxTokens, 12000);
  assert.ok(seen.turnId && seen.schema && seen.signal);
  assert.equal(await skinai.status({ ai }).then((s) => s.available), true);
  assert.equal((await skinai.status({ ai: { available: async () => false } })).available, false);
  await assert.rejects(() => skinai.generate({ text: 'guerrero' }, { ai: { available: async () => false, json: async () => ({}) }, language: 'es' }), { code: 'unavailable' });
});

test('generate: cancelar corta la espera y no se pueden correr dos a la vez', async () => {
  let release;
  const ai = {
    available: async () => true,
    json: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })));
      release = () => resolve(fakeAnswer());
    }),
  };
  const first = skinai.generate({ text: 'guerrero de tierra' }, { ai, language: 'es' });
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(() => skinai.generate({ text: 'otro' }, { ai, language: 'es' }), { code: 'skinai:busy' });
  assert.equal(skinai.cancel(), true);
  await assert.rejects(() => first, { code: 'skinai:cancelled' });
  assert.equal(skinai.cancel(), false);
  assert.equal(typeof release, 'function');
});
