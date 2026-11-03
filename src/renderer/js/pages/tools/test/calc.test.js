// Cuentas de la caja de herramientas (sin DOM). node --test "src/renderer/js/pages/tools/test/"
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toNether,
  toOverworld,
  distanceXZ,
  stacksOf,
  itemsOf,
  chestCapacity,
  anvilPlan,
  enchantsFor,
  enchantConflicts,
  priorWorkPenalty,
  roman,
  ticksToSeconds,
  secondsToTicks,
  ticksToClock,
  clockToTicks,
  dayPhase,
  parseColorCodes,
  stripColorCodes,
  blockToChunk,
  chunkToBlocks,
  regionToBlocks,
  parseRegionFile,
  ENCHANTS,
  ANVIL_MAX_COST,
} from '../calc.js';

test('Nether <-> Overworld: escala 1:8 en X y Z, Y igual, bloque con piso', () => {
  const n = toNether({ x: 1000, y: 64, z: -250 });
  assert.deepEqual(n.exact, { x: 125, y: 64, z: -31.25 });
  assert.deepEqual(n.block, { x: 125, y: 64, z: -32 });
  const o = toOverworld({ x: 125, y: 64, z: -31 });
  assert.deepEqual(o.exact, { x: 1000, y: 64, z: -248 });
  assert.deepEqual(o.block, { x: 1000, y: 64, z: -248 });
  assert.deepEqual(toNether({ x: 'abc', y: null, z: undefined }).block, { x: 0, y: 0, z: 0 });
  assert.equal(distanceXZ({ x: 0, z: 0 }, { x: 3, z: 4 }), 5);
});

test('stacks de 64 y 16, sobrante y cofres', () => {
  const s = stacksOf(1000, 64);
  assert.equal(s.stacks, 15);
  assert.equal(s.rest, 40);
  assert.equal(s.slots, 16);
  assert.deepEqual([s.singleChests, s.doubleChests, s.shulkers], [1, 1, 1]);
  const e = stacksOf(1000, 16);
  assert.deepEqual([e.stacks, e.rest, e.slots, e.singleChests, e.doubleChests], [62, 8, 63, 3, 2]);
  const full = stacksOf(3456, 64);
  assert.deepEqual([full.stacks, full.rest, full.slots, full.singleChests, full.doubleChests], [54, 0, 54, 2, 1]);
  assert.equal(stacksOf(-5).items, 0);
  assert.equal(stacksOf(10, 7).size, 64); // tamano raro -> 64
  assert.equal(itemsOf(15, 40, 64), 1000);
  assert.equal(itemsOf(2, 3, 16), 35);
  assert.equal(chestCapacity(1, 'double', 64), 3456);
  assert.equal(chestCapacity(2, 'shulker', 16), 864);
});

test('yunque: caso conocido (espada + Filo V + Irrompibilidad III cuesta 9 niveles)', () => {
  const r = anvilPlan({ kind: 'sword' }, [
    { id: 'sharpness', level: 5 },
    { id: 'unbreaking', level: 3 },
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.total, 9);
  assert.equal(r.steps.length, 2);
  assert.equal(r.maxStep, 5); // a igual total gana el plan con el paso mas caro mas barato (5 + 4, no 3 + 6)
  assert.equal(r.tooExpensive, false);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.steps[0].left.label, 'item');
  assert.deepEqual(r.steps[0].right.enchants, [{ id: 'sharpness', level: 5 }]);
  assert.equal(r.steps[1].cost, 4); // 3 por el libro + 1 de trabajo previo
  assert.equal(r.total, r.steps.reduce((a, s) => a + s.cost, 0));
});

test('yunque: con un item usado la penalizacion de trabajo previo entra en la cuenta', () => {
  assert.equal(priorWorkPenalty(0), 0);
  assert.equal(priorWorkPenalty(3), 7);
  const r = anvilPlan({ kind: 'sword', work: 2 }, [{ id: 'sharpness', level: 5 }]);
  assert.equal(r.total, 8); // 5 + (2^2 - 1)
  assert.equal(r.steps[0].result.work, 3);
});

test('yunque: la espada completa se arma sin llegar a "Demasiado caro"', () => {
  const books = ['sharpness', 'looting', 'unbreaking', 'mending', 'fire_aspect', 'sweeping_edge'].map((id) => ({ id, level: ENCHANTS[id].max }));
  const r = anvilPlan({ kind: 'sword' }, books);
  assert.equal(r.ok, true);
  assert.equal(r.steps.length, 6);
  assert.equal(r.total, r.steps.reduce((a, s) => a + s.cost, 0));
  assert.ok(r.total <= 44, `total ${r.total}`); // un plan balanceado a mano cuesta 44: el optimo no puede ser peor
  assert.ok(r.maxStep <= ANVIL_MAX_COST, `paso maximo ${r.maxStep}`);
  assert.equal(r.tooExpensive, false);
  // El item siempre queda a la izquierda y el ultimo paso junta todo.
  const last = r.steps[r.steps.length - 1];
  assert.equal(last.left.label, 'item');
  assert.equal(last.result.enchants.length, 6);
});

test('yunque: conflictos, niveles fuera de rango y libros de otro tipo', () => {
  const r = anvilPlan({ kind: 'sword' }, [
    { id: 'sharpness', level: 9 },
    { id: 'smite', level: 5 },
    { id: 'power', level: 5 },
  ]);
  assert.deepEqual(r.conflicts, [['sharpness', 'smite']]);
  assert.deepEqual(r.books.map((b) => [b.id, b.level]), [['sharpness', 5], ['smite', 5]]); // power no es de espada
  assert.equal(anvilPlan({ kind: 'bow' }, [{ id: 'sharpness', level: 5 }]).ok, false);
  assert.ok(enchantsFor('pickaxe').includes('fortune'));
  assert.ok(!enchantsFor('pickaxe').includes('power'));
  assert.deepEqual(enchantConflicts([{ id: 'fortune' }, { id: 'silk_touch' }, { id: 'unbreaking' }]), [['fortune', 'silk_touch']]);
  assert.equal(roman(4), 'IV');
  assert.equal(roman(0), 'I');
});

test('ticks <-> segundos <-> hora del dia', () => {
  assert.equal(ticksToSeconds(20), 1);
  assert.equal(ticksToSeconds(1200), 60);
  assert.equal(secondsToTicks(1.5), 30);
  assert.equal(ticksToClock(0).clock, '06:00');
  assert.equal(ticksToClock(6000).clock, '12:00');
  assert.equal(ticksToClock(12000).clock, '18:00');
  assert.equal(ticksToClock(13000).clock, '19:00');
  assert.equal(ticksToClock(18000).clock, '00:00');
  assert.equal(ticksToClock(23000).clock, '05:00');
  const later = ticksToClock(24000 + 6000);
  assert.equal(later.day, 1);
  assert.equal(later.clock, '12:00');
  assert.equal(clockToTicks('06:00'), 0);
  assert.equal(clockToTicks('12:00'), 6000);
  assert.equal(clockToTicks('00:00'), 18000);
  assert.equal(clockToTicks('18:00'), 12000);
  assert.equal(clockToTicks('5:00'), 23000);
  assert.equal(clockToTicks('abc'), null);
  assert.equal(clockToTicks('25:00'), null);
  for (const t of [0, 1000, 6000, 12000, 13000, 18000, 23000]) assert.equal(clockToTicks(ticksToClock(t).clock), t);
  assert.equal(dayPhase(1000), 'day');
  assert.equal(dayPhase(12500), 'sunset');
  assert.equal(dayPhase(15000), 'night');
  assert.equal(dayPhase(23500), 'sunrise');
});

test('codigos de color §: colores, formatos, reset y &', () => {
  const parts = parseColorCodes('§aHola §lmundo§r!');
  assert.equal(parts.length, 3);
  assert.deepEqual([parts[0].text, parts[0].color, parts[0].bold], ['Hola ', '#55FF55', false]);
  assert.deepEqual([parts[1].text, parts[1].color, parts[1].bold], ['mundo', '#55FF55', true]);
  assert.deepEqual([parts[2].text, parts[2].color, parts[2].bold], ['!', null, false]);
  // Un color borra los formatos anteriores, como en el juego.
  const reset = parseColorCodes('§lNegrita§cRojo');
  assert.equal(reset[1].bold, false);
  assert.equal(reset[1].color, '#FF5555');
  assert.equal(parseColorCodes('§k§nX')[0].obfuscated, true);
  assert.equal(parseColorCodes('§k§nX')[0].underline, true);
  assert.equal(parseColorCodes('&bHola', { alt: true })[0].color, '#55FFFF');
  assert.equal(parseColorCodes('&bHola')[0].text, '&bHola');
  assert.equal(parseColorCodes('§zRaro')[0].text, '§zRaro');
  assert.equal(stripColorCodes('§6§lVenus §rLauncher'), 'Venus Launcher');
  assert.deepEqual(parseColorCodes(''), []);
});

test('bloque <-> chunk <-> region', () => {
  const r = blockToChunk(100, -1);
  assert.deepEqual(r.chunk, { x: 6, z: -1, from: { x: 96, z: -16 }, to: { x: 111, z: -1 } });
  assert.deepEqual(r.local, { x: 4, z: 15 });
  assert.equal(r.region.file, 'r.0.-1.mca');
  assert.deepEqual([r.region.x, r.region.z], [0, -1]);
  const c = chunkToBlocks(-3, 2);
  assert.deepEqual(c.chunk.from, { x: -48, z: 32 });
  assert.deepEqual(c.chunk.to, { x: -33, z: 47 });
  assert.equal(c.region.file, 'r.-1.0.mca');
  const g = regionToBlocks(1, -1);
  assert.deepEqual(g.chunks, { from: { x: 32, z: -32 }, to: { x: 63, z: -1 } });
  assert.deepEqual(g.blocks, { from: { x: 512, z: -512 }, to: { x: 1023, z: -1 } });
  assert.deepEqual(parseRegionFile('r.-1.3.mca'), { x: -1, z: 3 });
  assert.equal(parseRegionFile('foo.mca'), null);
});
