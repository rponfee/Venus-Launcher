// Pruebas de los ajustes de decoración (sin DOM). node --test "src/renderer/js/features/decor/test/*.test.js"
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DECOR_DEFAULTS,
  PARTICLE_KINDS,
  SEASON_PARTICLES,
  SPLASH_TEXT_MAX,
  PARTICLE_MAX,
  PARTICLE_MIN,
  normalizeDecor,
  cleanSplashText,
  mergeDecor,
  seasonId,
  seasonParticles,
  resolveParticles,
  particleBudget,
} from '../settings.js';

test('sin ajustes queda todo apagado (los sonidos también)', () => {
  const d = normalizeDecor();
  assert.deepEqual(d, DECOR_DEFAULTS);
  assert.equal(d.particles, 'none');
  assert.equal(d.sounds.enabled, false);
  assert.equal(d.splash.enabled, false);
  assert.equal(d.cursor, 'default');
  assert.deepEqual(normalizeDecor(null), DECOR_DEFAULTS);
  assert.deepEqual(normalizeDecor('nieve'), DECOR_DEFAULTS);
  assert.deepEqual(normalizeDecor([]), DECOR_DEFAULTS);
});

test('valores desconocidos vuelven al valor por defecto y los números se recortan', () => {
  const d = normalizeDecor({
    particles: 'lava',
    density: 'extreme',
    seasonalParticles: 'yes',
    sounds: { enabled: 1, pack: 'metal', volume: 250 },
    splash: { enabled: true, style: 'video', text: 42 },
    cursor: 'banana',
  });
  assert.equal(d.particles, 'none');
  assert.equal(d.density, 'normal');
  assert.equal(d.seasonalParticles, false);
  assert.deepEqual(d.sounds, { enabled: false, pack: 'soft', volume: 100 });
  assert.deepEqual(d.splash, { enabled: true, style: 'logo', text: '' });
  assert.equal(d.cursor, 'default');
  assert.equal(normalizeDecor({ sounds: { volume: -20 } }).sounds.volume, 0);
  assert.equal(normalizeDecor({ sounds: { volume: '42.6' } }).sounds.volume, 43);
  assert.equal(normalizeDecor({ sounds: { volume: 'alto' } }).sounds.volume, DECOR_DEFAULTS.sounds.volume);
  assert.equal(normalizeDecor({ sounds: 'si' }).sounds.enabled, false);
});

test('valores válidos se conservan', () => {
  const raw = { particles: 'embers', density: 'low', seasonalParticles: true, sounds: { enabled: true, pack: 'pixel', volume: 35 }, splash: { enabled: true, style: 'text', text: 'Mi server' }, cursor: 'sword' };
  assert.deepEqual(normalizeDecor(raw), raw);
  for (const kind of PARTICLE_KINDS) assert.equal(normalizeDecor({ particles: kind }).particles, kind);
});

test('el texto de la pantalla de inicio es una línea corta y limpia', () => {
  assert.equal(cleanSplashText('  Hola   mundo \n nuevo '), 'Hola mundo nuevo');
  assert.equal(cleanSplashText(`a${String.fromCharCode(7)}b${String.fromCharCode(0)}c`), 'abc');
  assert.equal(cleanSplashText('x'.repeat(100)).length, SPLASH_TEXT_MAX);
  assert.equal(cleanSplashText(null), '');
  assert.equal(cleanSplashText(123), '');
  assert.equal(normalizeDecor({ splash: { text: 'Venus 🌋 Launcher' } }).splash.text, 'Venus 🌋 Launcher');
});

test('mergeDecor mezcla en profundidad sin tocar los originales', () => {
  const base = { sounds: { enabled: true, pack: 'soft', volume: 60 }, cursor: 'pixel' };
  const out = mergeDecor(base, { sounds: { volume: 20 }, splash: { enabled: true } });
  assert.deepEqual(out, { sounds: { enabled: true, pack: 'soft', volume: 20 }, cursor: 'pixel', splash: { enabled: true } });
  assert.equal(base.sounds.volume, 60);
  assert.deepEqual(mergeDecor(null, { cursor: 'sword' }), { cursor: 'sword' });
  assert.deepEqual(mergeDecor({ a: 1 }, null), { a: 1 });
  assert.deepEqual(mergeDecor({ a: 1 }, { a: undefined, b: 2 }), { a: 1, b: 2 });
});

test('partículas por temporada: nieve en Navidad, hojas en Halloween, chispas en Año Nuevo', () => {
  assert.equal(seasonParticles('christmas'), 'snow');
  assert.equal(seasonParticles('halloween'), 'leaves');
  assert.equal(seasonParticles('newyear'), 'embers');
  assert.equal(seasonParticles('easter'), null);
  assert.equal(seasonParticles(null), null);
  assert.equal(seasonId('christmas'), 'christmas');
  assert.equal(seasonId('CHRISTMAS'), null);
  assert.equal(seasonId(undefined), null);
  assert.deepEqual(Object.keys(SEASON_PARTICLES).sort(), ['christmas', 'halloween', 'newyear']);
});

test('la temporada manda solo con las partículas de temporada activas y nunca pisa la elección', () => {
  const user = { particles: 'rain', seasonalParticles: true };
  const r = resolveParticles(user, 'christmas');
  assert.deepEqual(r, { kind: 'snow', seasonal: true, season: 'christmas', choice: 'rain' });
  // la elección del usuario sigue guardada tal cual
  assert.equal(normalizeDecor(user).particles, 'rain');
  // termina la temporada: vuelve la elección
  assert.deepEqual(resolveParticles(user, null), { kind: 'rain', seasonal: false, season: null, choice: 'rain' });
  // temporada desconocida: no cambia nada
  assert.equal(resolveParticles(user, 'carnival').kind, 'rain');
  // sin la opción activada, la temporada no hace nada
  assert.deepEqual(resolveParticles({ particles: 'rain', seasonalParticles: false }, 'halloween'), { kind: 'rain', seasonal: false, season: null, choice: 'rain' });
  // con "ninguna" elegida, la temporada igual muestra las suyas
  assert.equal(resolveParticles({ particles: 'none', seasonalParticles: true }, 'newyear').kind, 'embers');
});

test('tope de partículas por tamaño de ventana', () => {
  assert.equal(particleBudget(1300, 820, 'none'), 0);
  assert.equal(particleBudget(0, 820, 'snow'), 0);
  assert.equal(particleBudget('ancho', 820, 'snow'), 0);
  const normal = particleBudget(1300, 820, 'snow', 'normal');
  const low = particleBudget(1300, 820, 'snow', 'low');
  assert.ok(normal > low && low >= PARTICLE_MIN);
  assert.ok(particleBudget(1040, 680, 'snow') < normal);
  assert.ok(particleBudget(1300, 820, 'rain') > normal);
  assert.ok(particleBudget(1300, 820, 'leaves') < particleBudget(1300, 820, 'embers'));
  assert.equal(particleBudget(8000, 8000, 'rain'), PARTICLE_MAX);
  assert.equal(particleBudget(10, 10, 'leaves'), PARTICLE_MIN);
  for (const kind of PARTICLE_KINDS.filter((k) => k !== 'none')) {
    const n = particleBudget(2560, 1440, kind);
    assert.ok(Number.isInteger(n) && n >= PARTICLE_MIN && n <= PARTICLE_MAX, kind);
  }
});
