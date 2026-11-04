// Soundboard: limite de uno cada 2 s, ids de los propios y lo que manda a recodificar.
// node --test "src/renderer/js/voice/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundLimiter, SOUND_GAP_MS, CUSTOM_BYTES, CUSTOM_MAX, CUSTOM_SECONDS, customSoundId, isCustomSound, customFileId, cleanSoundName, needsReencode, CustomSounds } from '../soundboard.js';
import { VOICE_EFFECTS, FX_PARAMS, normalizeEffect, fxNeedsPitch } from '../fx.js';

test('uno cada 2 s', () => {
  assert.equal(SOUND_GAP_MS, 2000);
  const l = new SoundLimiter();
  assert.equal(l.tryPlay(10_000), true, 'el primero suena siempre');
  assert.equal(l.tryPlay(10_001), false);
  assert.equal(l.tryPlay(11_999), false);
  assert.equal(l.remaining(11_000), 1000);
  assert.equal(l.tryPlay(12_000), true, 'a los 2 s exactos ya se puede');
  assert.equal(l.remaining(12_000), 2000);
  assert.equal(l.tryPlay(13_000), false);
});

test('un intento rechazado no corre el reloj', () => {
  const l = new SoundLimiter(2000);
  l.tryPlay(0);
  for (let t = 100; t < 2000; t += 100) assert.equal(l.tryPlay(t), false);
  assert.equal(l.tryPlay(2000), true);
});

test('una rafaga de 100 clics en 10 s suena como mucho 5 veces', () => {
  const l = new SoundLimiter();
  let played = 0;
  for (let t = 0; t < 10_000; t += 100) if (l.tryPlay(t)) played++;
  assert.equal(played, 5);
});

test('ids de los sonidos propios', () => {
  assert.equal(customSoundId('abc'), 'custom:abc');
  assert.equal(isCustomSound('custom:abc'), true);
  assert.equal(isCustomSound('ding'), false);
  assert.equal(isCustomSound('custom:'), false);
  assert.equal(isCustomSound(null), false);
  assert.equal(customFileId('custom:abc'), 'abc');
  assert.equal(customFileId('ding'), null);
});

test('nombre de un sonido propio', () => {
  assert.equal(cleanSoundName('  Mi   risa.mp3 '), 'Mi risa');
  assert.equal(cleanSoundName('a\u0000b'), 'a b');
  assert.equal(cleanSoundName('x'.repeat(60)).length, 24);
  assert.equal(cleanSoundName(null), '');
});

test('limites de un sonido propio', () => {
  assert.equal(CUSTOM_MAX, 8);
  assert.equal(CUSTOM_SECONDS, 5);
  assert.equal(CUSTOM_BYTES, 200 * 1024);
  assert.equal(needsReencode({ bytes: 1000, duration: 4 }), false);
  assert.equal(needsReencode({ bytes: CUSTOM_BYTES + 1, duration: 4 }), true);
  assert.equal(needsReencode({ bytes: 1000, duration: 5.5 }), true);
});

test('la biblioteca recuerda la lista y olvida los buffers de lo que ya no existe', async () => {
  const calls = [];
  const lib = new CustomSounds(async (ch, ...args) => {
    calls.push(ch);
    if (ch === 'soundboard:list') return { items: [{ id: 'a', name: 'A' }], shortcuts: { 'custom:a': 'Alt+1' } };
    if (ch === 'soundboard:remove') return { items: [], shortcuts: {} };
    throw new Error(`canal inesperado ${ch} ${args}`);
  });
  assert.deepEqual((await lib.load()).map((x) => x.id), ['a']);
  await lib.load();
  assert.equal(calls.filter((c) => c === 'soundboard:list').length, 1, 'no vuelve a pedir la lista');
  assert.equal(lib.shortcuts['custom:a'], 'Alt+1');
  lib.buffers.set('a', { ctx: {}, buffer: {} });
  await lib.remove('a');
  assert.equal(lib.buffers.size, 0);
  assert.deepEqual(lib.items, []);
});

test('efectos: ninguno no arma nada y un id desconocido cae en ninguno', () => {
  assert.deepEqual(VOICE_EFFECTS, ['none', 'robot', 'echo', 'villager', 'deep', 'high']);
  assert.equal(FX_PARAMS.none, undefined);
  assert.equal(normalizeEffect('robot'), 'robot');
  assert.equal(normalizeEffect('hackeado'), 'none');
  assert.equal(normalizeEffect(undefined), 'none');
  assert.equal(fxNeedsPitch('robot'), false);
  assert.equal(fxNeedsPitch('echo'), false);
  for (const id of ['villager', 'deep', 'high']) assert.equal(fxNeedsPitch(id), true);
});

test('efectos: los parametros son razonables para la voz', () => {
  assert.ok(FX_PARAMS.deep.ratio < 1);
  assert.ok(FX_PARAMS.high.ratio > 1);
  assert.ok(FX_PARAMS.villager.ratio > FX_PARAMS.deep.ratio && FX_PARAMS.villager.ratio < 1);
  assert.ok(FX_PARAMS.echo.feedback < 0.7, 'el eco tiene que apagarse solo');
  assert.ok(FX_PARAMS.echo.delay <= 0.5);
});
