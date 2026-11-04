// Traduccion de mensajes: filtro, caché y tandas. node --test "src/renderer/js/social/test/"
import test from 'node:test';
import assert from 'node:assert/strict';
import { guessLanguage, isTranslatable, hashText, cacheKey, TranslationCache, makeBatches, TranslateQueue, isFatalTranslateError, TR_LIMITS } from '../translate.js';

test('reconoce idiomas con seguridad y, si no hay, no decide', () => {
  assert.equal(guessLanguage('hola, como estas? todo bien por aca'), 'es');
  assert.equal(guessLanguage('¿Vamos al server?'), 'es');
  assert.equal(guessLanguage('hello, how are you doing today?'), 'en');
  assert.equal(guessLanguage('bonjour, comment ça va aujourd’hui ?'), 'fr');
  assert.equal(guessLanguage('Hallo, wie geht es dir?'), 'de');
  assert.equal(guessLanguage('Привет, как дела?'), 'ru');
  assert.equal(guessLanguage('Привіт, як справи? Її'), 'uk');
  assert.equal(guessLanguage('こんにちは、元気ですか'), 'ja');
  assert.equal(guessLanguage('안녕하세요'), 'ko');
  assert.equal(guessLanguage('你好世界'), 'zh');
  assert.equal(guessLanguage('xqz'), null, 'sin palabras conocidas no decide');
  assert.equal(guessLanguage('123 !!! :)'), null);
});

test('el filtro no manda lo que no hace falta traducir', () => {
  assert.equal(isTranslatable('', 'es'), false);
  assert.equal(isTranslatable('   ', 'es'), false);
  assert.equal(isTranslatable('👍🔥', 'es'), false, 'solo emojis');
  assert.equal(isTranslatable('https://example.com/a?b=1', 'es'), false, 'solo una direccion');
  assert.equal(isTranslatable(':hola: :chau:', 'es'), false, 'solo emojis propios');
  assert.equal(isTranslatable('1234 !!', 'es'), false, 'numeros y signos');
  assert.equal(isTranslatable('@tomi', 'es'), false, 'solo una mencion');
  assert.equal(isTranslatable('a', 'es'), false, 'una letra');
});

test('el filtro no manda lo que ya esta en ese idioma', () => {
  assert.equal(isTranslatable('hola, como estas? todo bien', 'es'), false);
  assert.equal(isTranslatable('hola, como estas? todo bien', 'en'), true);
  assert.equal(isTranslatable('hello, how are you doing', 'en'), false);
  assert.equal(isTranslatable('hello, how are you doing', 'es'), true);
  assert.equal(isTranslatable('Привет, как дела?', 'ru'), false);
  assert.equal(isTranslatable('Привет, как дела?', 'es'), true);
  assert.equal(isTranslatable('你', 'es'), true, 'un ideograma ya es una palabra');
  assert.equal(isTranslatable('xqz wvk', 'es'), true, 'sin seguridad decide la IA');
});

test('la clave cambia con el idioma y si el mensaje se edito', () => {
  assert.notEqual(hashText('a'), hashText('b'));
  assert.equal(hashText('hola'), hashText('hola'));
  assert.notEqual(cacheKey('m1', 'es', 'hola'), cacheKey('m1', 'en', 'hola'));
  assert.notEqual(cacheKey('m1', 'es', 'hola'), cacheKey('m1', 'es', 'hola!'));
  assert.ok(!cacheKey('m1', 'es', 'secreto').includes('secreto'), 'el texto no queda en la clave');
});

test('la caché guarda, olvida lo mas viejo y se puede volcar y recuperar', () => {
  let changes = 0;
  const c = new TranslationCache({ max: 3, onChange: () => changes++ });
  c.set('a', 'es', 'x', { text: 'A', same: false });
  c.set('b', 'es', 'x', { text: 'B', same: true });
  c.set('c', 'es', 'x', { text: 'C' });
  assert.equal(changes, 3);
  assert.deepEqual(c.get('b', 'es', 'x'), { text: 'B', same: true });
  assert.equal(c.get('b', 'en', 'x'), null);
  assert.equal(c.get('b', 'es', 'otro'), null);
  assert.ok(c.get('a', 'es', 'x'), 'usar uno lo vuelve reciente');
  c.set('d', 'es', 'x', { text: 'D' });
  assert.equal(c.size, 3);
  assert.equal(c.get('c', 'es', 'x'), null, 'se fue el menos usado');
  const copy = new TranslationCache({ max: 3 });
  copy.load(JSON.parse(JSON.stringify(c.dump())));
  assert.deepEqual(copy.get('d', 'es', 'x'), { text: 'D', same: false });
  copy.load([['malo'], null, 'x', ['k', { text: 5 }]]);
  assert.equal(copy.size, 0, 'lo que no tiene la forma correcta no entra');
  c.clear();
  assert.equal(c.size, 0);
});

test('arma tandas por cantidad y por caracteres', () => {
  const it = (n, len = 10) => Array.from({ length: n }, (_, i) => ({ id: String(i), text: 'x'.repeat(len) }));
  assert.deepEqual(makeBatches([]), []);
  assert.deepEqual(makeBatches(it(25)).map((b) => b.length), [10, 10, 5]);
  assert.deepEqual(makeBatches(it(5, 1500)).map((b) => b.length), [2, 2, 1]);
  assert.deepEqual(makeBatches(it(2, TR_LIMITS.batchChars + 1)).map((b) => b.length), [1, 1], 'uno solo muy largo igual sale');
});

function queue(send, extra = {}) {
  const results = new Map();
  const errors = [];
  const cache = new TranslationCache();
  const q = new TranslateQueue({
    send,
    cache,
    lang: () => 'es',
    delayMs: 0,
    onResult: (id, v) => results.set(id, v),
    onError: (err, items) => errors.push({ err, items }),
    ...extra,
  });
  return { q, cache, results, errors };
}

test('la cola junta en tandas, no repite y lo ya traducido no se vuelve a pedir', async () => {
  const calls = [];
  const send = async (items, lang) => {
    calls.push({ n: items.length, lang });
    return items.map((it) => ({ id: it.id, text: `es:${it.text}`, same: false }));
  };
  const { q, results, cache } = queue(send);
  const msgs = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, text: `hello ${i}` }));
  assert.equal(q.request(msgs), 12);
  assert.equal(q.request(msgs), 0, 'pedir lo mismo no lo duplica');
  await q.flush();
  assert.deepEqual(calls, [{ n: 10, lang: 'es' }, { n: 2, lang: 'es' }]);
  assert.equal(results.get('m11').text, 'es:hello 11');
  assert.equal(cache.size, 12);
  results.clear();
  assert.equal(q.request(msgs), 0, 'todo sale de la caché');
  assert.equal(calls.length, 2, 'sin otra llamada a la IA');
  assert.equal(results.size, 12);
});

test('lo que vuelve fallado se avisa y no entra en la caché', async () => {
  const { q, results, cache } = queue(async (items) => [{ id: items[0].id, failed: true }]);
  q.request([{ id: 'a', text: 'hello' }, { id: 'b', text: 'bye' }]);
  await q.flush();
  assert.deepEqual(results.get('a'), { failed: true });
  assert.deepEqual(results.get('b'), { failed: true }, 'tampoco lo que no volvio');
  assert.equal(cache.size, 0);
});

test('sin plan o sin saldo corta la cola y avisa una sola vez', async () => {
  let calls = 0;
  const { q, errors, results } = queue(async () => {
    calls++;
    throw Object.assign(new Error('x'), { code: 'noplan' });
  });
  q.request(Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, text: 'hello' })));
  await q.flush();
  assert.equal(calls, 1, 'no insiste');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].items.length, 25, 'avisa de todo lo que no se tradujo');
  assert.equal(results.size, 0);
  assert.equal(isFatalTranslateError({ code: 'quota' }), true);
  assert.equal(isFatalTranslateError({ code: 'network' }), false);
});

test('un error pasajero descarta esa tanda y sigue con la otra', async () => {
  let calls = 0;
  const { q, errors, results } = queue(async (items) => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('x'), { code: 'network' });
    return items.map((it) => ({ id: it.id, text: 'ok', same: false }));
  });
  q.request(Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, text: 'hello' })));
  await q.flush();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].items.length, 10);
  assert.equal(results.size, 2);
  assert.equal(q.request([{ id: 'm0', text: 'hello' }]), 1, 'lo que fallo se puede volver a pedir');
  q.close();
});

test('cerrada la cola, no pide ni avisa nada mas', async () => {
  let release;
  const { q, results } = queue(() => new Promise((r) => (release = r)));
  q.request([{ id: 'a', text: 'hello' }]);
  const run = q.flush();
  q.close();
  release([{ id: 'a', text: 'hola', same: false }]);
  await run;
  assert.equal(results.size, 0);
});
