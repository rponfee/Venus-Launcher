// Salud del camino principal: cuando se da por caido, cuando por recuperado y que no parpadee.
// node --test "src/renderer/js/voice/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { Health, HEALTH } from '../health.js';

test('arranca "up" y no cambia mientras todo anda', () => {
  const h = new Health();
  h.socket(true, 0);
  h.channel('SUBSCRIBED', 0);
  for (let t = 0; t < 60000; t += 1000) {
    h.probe(true);
    assert.equal(h.evaluate(t), null);
  }
  assert.equal(h.state, 'up');
});

test('el socket de Realtime sin conexion: cae despues de la gracia, no antes', () => {
  const h = new Health();
  h.channel('SUBSCRIBED', 0);
  h.socket(false, 1000);
  assert.equal(h.evaluate(1000 + HEALTH.SOCKET_GRACE - 1), null);
  assert.equal(h.evaluate(1000 + HEALTH.SOCKET_GRACE), 'down');
});

test('un corte de menos de la gracia no cuenta', () => {
  const h = new Health();
  h.channel('SUBSCRIBED', 0);
  h.socket(false, 1000);
  h.socket(true, 2500);
  assert.equal(h.evaluate(10000), null);
  assert.equal(h.state, 'up');
});

test('el canal de la sala sin suscripcion cae despues de su gracia', () => {
  const h = new Health();
  h.socket(true, 0);
  h.channel('SUBSCRIBED', 0);
  h.channel('CLOSED', 5000);
  assert.equal(h.evaluate(5000 + HEALTH.CHANNEL_GRACE - 1), null);
  assert.equal(h.evaluate(5000 + HEALTH.CHANNEL_GRACE), 'down');
});

test('pruebas activas: una que falla no alcanza, dos seguidas si; una buena en el medio las reinicia', () => {
  const h = new Health();
  h.socket(true, 0);
  h.channel('SUBSCRIBED', 0);
  h.probe(false);
  assert.equal(h.evaluate(1), null);
  h.probe(true);
  h.probe(false);
  assert.equal(h.evaluate(2), null);
  h.probe(false);
  assert.equal(h.evaluate(3), 'down');
});

test('algo recibido del servidor evita que unas pruebas fallidas lo den por caido', () => {
  const h = new Health();
  h.socket(true, 0);
  h.channel('SUBSCRIBED', 0);
  h.probe(false);
  h.alive();
  h.probe(false);
  assert.equal(h.evaluate(1), null);
});

test('volver pide canal suscripto sin cortes un rato y pruebas buenas seguidas (con histeresis)', () => {
  const h = new Health();
  h.socket(true, 0);
  h.channel('SUBSCRIBED', 0);
  h.socket(false, 100);
  assert.equal(h.evaluate(100 + HEALTH.SOCKET_GRACE), 'down');
  // vuelve el socket y el canal, pero hace falta estabilidad y pruebas
  h.socket(true, 5000);
  h.channel('SUBSCRIBED', 5000);
  h.probe(true);
  assert.equal(h.evaluate(5000 + HEALTH.UP_STABLE), null, 'con una sola prueba buena todavia no');
  h.probe(true);
  assert.equal(h.evaluate(5000 + HEALTH.UP_STABLE - 1), null, 'ni antes de la estabilidad');
  assert.equal(h.evaluate(5000 + HEALTH.UP_STABLE), 'up');
});

test('un servidor que va y viene no cambia de estado a cada rato', () => {
  const h = new Health();
  h.socket(true, 0);
  h.channel('SUBSCRIBED', 0);
  let changes = 0;
  let t = 0;
  for (let i = 0; i < 20; i++) {
    h.socket(false, t);
    t += HEALTH.SOCKET_GRACE;
    if (h.evaluate(t)) changes++;
    h.socket(true, t);
    h.channel('SUBSCRIBED', t);
    h.probe(true);
    t += 1500; // vuelve apenas 1,5 s: no alcanza para dar por recuperado
    if (h.evaluate(t)) changes++;
  }
  assert.equal(changes, 1, 'cayo una vez y no volvio a subir con cortes tan seguidos');
  assert.equal(h.state, 'down');
});

test('force() fija el estado y avisa solo si cambia', () => {
  const h = new Health();
  assert.equal(h.force('down', 10), 'down');
  assert.equal(h.force('down', 20), null);
  assert.equal(h.since, 10);
});
