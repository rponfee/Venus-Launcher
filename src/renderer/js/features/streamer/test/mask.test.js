// La copia de la interfaz tiene que tapar exactamente lo mismo que la del proceso principal.
// node --test "src/renderer/js/features/streamer/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { maskText, CODE_MASK } from '../mask.js';

const require = createRequire(import.meta.url);
const main = require('../../../../../main/modules/streamer/mask.js');

const SAMPLES = [
  'Tu código es VENUS-R1NG0X',
  'entrá con pack-ab12cd',
  'Servidor en 190.12.34.56:25565',
  'LAN 192.168.1.20',
  'Forge 1.20.1-47.2.0 listo',
  'fabric-1.21.1.jar',
  'v6 2001:db8::1 ok',
  'Sofi entró a mc.hypixel.net',
  'play.ejemplo.com:25565',
  'abc123.bore.pub:4567',
  'sodium-0.5.8+mc1.20.1.jar',
  'config/sodium.properties',
  'ringo@gmail.com',
  'Tarea terminada. Mundo nuevo.',
  '',
];

test('misma salida que el proceso principal', () => {
  assert.equal(CODE_MASK, main.CODE_MASK);
  for (const s of SAMPLES) assert.equal(maskText(s), main.maskText(s), s);
  assert.equal(maskText(null), null);
});

test('tapa lo que importa', () => {
  assert.equal(maskText('VENUS-ABC123 en 10.0.0.1'), `VENUS-${CODE_MASK} en •••.•••.•••.•••`);
  assert.equal(maskText('Sofi entró a mc.hypixel.net'), 'Sofi entró a ••••••••.net');
});
