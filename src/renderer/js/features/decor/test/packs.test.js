// Pruebas de los packs de sonidos (parámetros de síntesis, sin AudioContext).
// node --test "src/renderer/js/features/decor/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import { PACKS, EXTRA, SOUND_IDS, UI_SOUND_IDS, WAVES, FREQ_RANGE, DUR_RANGE, MAX_LENGTH, soundSpec, uiSoundSpec, soundLength, volumeGain } from '../packs.js';
import { SOUND_PACKS } from '../settings.js';

function checkVoices(voices, label) {
  assert.ok(Array.isArray(voices) && voices.length > 0, `${label}: sin voces`);
  for (const v of voices) {
    assert.ok(WAVES.includes(v.wave), `${label}: onda ${v.wave}`);
    assert.ok(v.freq >= FREQ_RANGE[0] && v.freq <= FREQ_RANGE[1], `${label}: frecuencia ${v.freq}`);
    if (v.to !== undefined) assert.ok(v.to >= FREQ_RANGE[0] && v.to <= FREQ_RANGE[1], `${label}: destino ${v.to}`);
    assert.ok(v.dur >= DUR_RANGE[0] && v.dur <= DUR_RANGE[1], `${label}: duración ${v.dur}`);
    assert.ok(v.gain > 0 && v.gain <= 1, `${label}: ganancia ${v.gain}`);
    assert.ok((v.at || 0) >= 0 && (v.at || 0) < MAX_LENGTH, `${label}: inicio ${v.at}`);
    if (v.lowpass !== undefined) assert.ok(v.lowpass >= FREQ_RANGE[0] && v.lowpass <= 20000, `${label}: filtro ${v.lowpass}`);
    if (v.attack !== undefined) assert.ok(v.attack > 0 && v.attack < v.dur, `${label}: ataque ${v.attack}`);
  }
  const len = soundLength(voices);
  assert.ok(len > 0 && len <= MAX_LENGTH, `${label}: dura ${len} s`);
}

test('cada pack trae los cuatro sonidos con parámetros dentro de los rangos', () => {
  assert.deepEqual(Object.keys(PACKS).sort(), [...SOUND_PACKS].sort());
  for (const pack of SOUND_PACKS) {
    assert.deepEqual(Object.keys(PACKS[pack]).sort(), [...SOUND_IDS].sort(), pack);
    for (const id of SOUND_IDS) checkVoices(soundSpec(pack, id), `${pack}.${id}`);
  }
});

test('los sonidos del botón Jugar también están en rango', () => {
  for (const id of UI_SOUND_IDS) {
    for (const pack of SOUND_PACKS) checkVoices(uiSoundSpec(pack, id), `ui.${id} (${pack})`);
  }
  assert.deepEqual(Object.keys(EXTRA).sort(), ['bell', 'whoosh']);
  assert.deepEqual(uiSoundSpec('pixel', 'click'), PACKS.pixel.click);
  assert.equal(uiSoundSpec('soft', 'explosion'), null);
  assert.equal(soundSpec('soft', 'tada'), null);
});

test('los packs se distinguen y las copias no tocan la definición', () => {
  assert.notDeepEqual(PACKS.soft.click, PACKS.pixel.click);
  assert.notDeepEqual(PACKS.pixel.success, PACKS.space.success);
  const v = soundSpec('soft', 'click');
  v[0].freq = 1;
  assert.notEqual(PACKS.soft.click[0].freq, 1);
  // un pack desconocido cae al suave
  assert.deepEqual(soundSpec('metal', 'open'), PACKS.soft.open);
  // los clics son cortos; los errores, más graves que los aciertos
  for (const pack of SOUND_PACKS) {
    assert.ok(soundLength(PACKS[pack].click) <= 0.1, `${pack}: clic largo`);
    assert.ok(PACKS[pack].error[0].freq < PACKS[pack].success[0].freq, `${pack}: error agudo`);
  }
  assert.equal(soundLength([]), 0);
  assert.equal(soundLength(null), 0);
});

test('la ganancia crece con el volumen y nunca pasa de 0,6', () => {
  assert.equal(volumeGain(0), 0);
  assert.equal(volumeGain(-5), 0);
  assert.equal(volumeGain('x'), 0);
  assert.ok(volumeGain(30) < volumeGain(60) && volumeGain(60) < volumeGain(100));
  assert.ok(Math.abs(volumeGain(100) - 0.6) < 1e-9);
  assert.equal(volumeGain(250), volumeGain(100));
});
