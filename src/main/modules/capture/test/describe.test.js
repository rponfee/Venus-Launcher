'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('../../../core/paths');
const describe = require('../describe');
const logic = require('../logic');

function withData(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-capture-ai-'));
    paths.setRoot(dir);
    describe._reset();
    try {
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('mensaje con las imagenes numeradas y pedido en el idioma elegido', () => {
  const content = describe.buildContent(['AAA', 'BBB']);
  assert.equal(content.filter((b) => b.type === 'image').length, 2);
  assert.deepEqual(content[1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } });
  assert.match(content.at(-1).text, /2 imágenes/);
  assert.match(describe.systemPrompt('en'), /English/);
  assert.match(describe.systemPrompt('xx'), /español/);
  assert.equal(describe.cleanDescription(' una\ncasa \t de  madera '), 'una casa de madera');
  assert.equal(describe.cleanDescription('x'.repeat(500)).length, 300);
  assert.deepEqual(describe.batches([1, 2, 3, 4, 5, 6, 7], 3), [[1, 2, 3], [4, 5, 6], [7]]);
});

test(
  'describe en tandas con el mismo turnId y guarda las descripciones',
  withData(async () => {
    const calls = [];
    const ai = {
      json: async (opts) => {
        calls.push(opts);
        const n = opts.messages[0].content.filter((b) => b.type === 'image').length;
        return { items: Array.from({ length: n }, (_, i) => ({ index: i + 1, description: `foto ${calls.length}-${i + 1}` })) };
      },
    };
    const list = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, path: `p${i}` }));
    const res = await describe.describe(list, { ai, encode: async () => 'QUJD', language: 'es' });
    assert.equal(res.described, 12);
    assert.equal(calls.length, 3, '5 + 5 + 2');
    assert.ok(calls.every((c) => c.turnId === calls[0].turnId && c.schema === describe.SCHEMA && c.model === 'haiku'));
    const idx = await describe.index();
    assert.equal(idx.k0, 'foto 1-1');
    assert.equal(idx.k11, 'foto 3-2');
    describe._reset();
    assert.equal((await describe.index()).k5, 'foto 2-1', 'quedo guardado en disco');
  }),
);

test(
  'si la IA corta (sin plan, cuota), devuelve lo hecho y el error con su codigo',
  withData(async () => {
    let n = 0;
    const ai = {
      json: async () => {
        n++;
        if (n === 2) throw Object.assign(new Error('Sin preguntas'), { code: 'quota' });
        return { items: [{ index: 1, description: 'algo' }, { index: 9, description: 'no existe' }, { index: 2, description: '' }] };
      },
    };
    const list = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, path: `p${i}` }));
    const res = await describe.describe(list, { ai, encode: async (p) => (p === 'p3' ? null : 'QUJD') });
    assert.equal(res.described, 1);
    assert.equal(res.error.code, 'quota');
    assert.equal(res.skipped, 9);
  }),
);

test('nunca manda mas de 20 capturas por accion', async () => {
  let images = 0;
  const ai = { json: async (o) => ((images += o.messages[0].content.filter((b) => b.type === 'image').length), { items: [] }) };
  await describe.describe(Array.from({ length: 50 }, (_, i) => ({ key: `k${i}`, path: `p${i}` })), { ai, encode: async () => 'QQ' });
  assert.equal(images, describe.MAX_PER_RUN);
});

test('solo acepta capturas dentro de <instancias>/<id>/screenshots/', () => {
  const root = path.resolve(os.tmpdir(), 'venus-root', 'instances');
  const ok = path.join(root, 'abc', 'screenshots', '2026-01-01_10.00.00.png');
  assert.equal(logic.screenshotPath(ok, root), ok);
  assert.equal(logic.screenshotPath(path.join(root, 'abc', 'clips', 'x.png'), root), null);
  assert.equal(logic.screenshotPath(path.join(root, 'abc', 'screenshots', 'x.exe'), root), null);
  assert.equal(logic.screenshotPath(path.join(root, '..', 'otra', 'screenshots', 'x.png'), root), null);
  assert.equal(logic.screenshotPath(path.join(root, 'abc', 'screenshots', 'sub', 'x.png'), root), null);
  assert.equal(logic.screenshotPath('relativa/x.png', root), null);
  assert.equal(logic.screenshotPath(null, root), null);
});
