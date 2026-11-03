// Cuentas de la caja de herramientas (pages/tools.js). Sin DOM ni imports: las prueban las pruebas de
// pages/tools/test/ con Node puro. Todo es local, sin red.
//   Nether <-> Overworld, stacks y cofres, orden de encantamientos en el yunque, ticks <-> segundos <-> hora del
//   dia, codigos de color § y bloque <-> chunk <-> region.

const num = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

// ---------- Nether <-> Overworld ----------
// El Nether esta a escala 1:8 en X y Z; Y no cambia. `block` es la coordenada de bloque (piso), `exact` la cuenta sin
// redondear (sirve para saber cuanto hay que caminar).
export function toNether({ x, y, z }) {
  const ex = num(x) / 8;
  const ez = num(z) / 8;
  return { exact: { x: ex, y: num(y), z: ez }, block: { x: Math.floor(ex), y: num(y), z: Math.floor(ez) } };
}

export function toOverworld({ x, y, z }) {
  const ex = num(x) * 8;
  const ez = num(z) * 8;
  return { exact: { x: ex, y: num(y), z: ez }, block: { x: Math.floor(ex), y: num(y), z: Math.floor(ez) } };
}

// Distancia en bloques entre dos puntos (solo X y Z, como se camina).
export function distanceXZ(a, b) {
  return Math.hypot(num(b.x) - num(a.x), num(b.z) - num(a.z));
}

// ---------- Stacks y cofres ----------
export const CHEST_SLOTS = Object.freeze({ single: 27, double: 54, shulker: 27, barrel: 27 });

// items -> stacks enteros, sobrante y cofres necesarios para guardarlos.
export function stacksOf(items, size = 64) {
  const n = Math.max(0, Math.floor(num(items)));
  const s = [1, 16, 64].includes(size) ? size : 64;
  const stacks = Math.floor(n / s);
  const rest = n % s;
  const slots = stacks + (rest ? 1 : 0);
  return {
    items: n,
    size: s,
    stacks,
    rest,
    slots,
    singleChests: Math.ceil(slots / CHEST_SLOTS.single),
    doubleChests: Math.ceil(slots / CHEST_SLOTS.double),
    shulkers: Math.ceil(slots / CHEST_SLOTS.shulker),
  };
}

// stacks + sobrante -> items.
export function itemsOf(stacks, rest = 0, size = 64) {
  const s = [1, 16, 64].includes(size) ? size : 64;
  return Math.max(0, Math.floor(num(stacks))) * s + Math.max(0, Math.floor(num(rest)));
}

// Cuantos items entran en N cofres (simples, dobles o shulkers) llenos de stacks de `size`.
export function chestCapacity(count, kind = 'double', size = 64) {
  const slots = CHEST_SLOTS[kind] || CHEST_SLOTS.double;
  return Math.max(0, Math.floor(num(count))) * slots * ([1, 16, 64].includes(size) ? size : 64);
}

// ---------- Yunque: orden de encantamientos ----------
// Encantamientos comunes de espada, pico, armadura y arco con su nivel maximo y el multiplicador de costo cuando
// el sacrificio es un libro (book) o un item (item), segun la mecanica del yunque de Minecraft Java.
// conflicts: encantamientos que no pueden ir juntos en el mismo item.
export const ENCHANTS = Object.freeze({
  sharpness: { max: 5, item: 1, book: 1, kinds: ['sword'], conflicts: ['smite', 'bane_of_arthropods'] },
  smite: { max: 5, item: 2, book: 1, kinds: ['sword'], conflicts: ['sharpness', 'bane_of_arthropods'] },
  bane_of_arthropods: { max: 5, item: 2, book: 1, kinds: ['sword'], conflicts: ['sharpness', 'smite'] },
  knockback: { max: 2, item: 2, book: 1, kinds: ['sword'] },
  fire_aspect: { max: 2, item: 4, book: 2, kinds: ['sword'] },
  looting: { max: 3, item: 4, book: 2, kinds: ['sword'] },
  sweeping_edge: { max: 3, item: 4, book: 2, kinds: ['sword'] },
  efficiency: { max: 5, item: 1, book: 1, kinds: ['pickaxe'] },
  fortune: { max: 3, item: 4, book: 2, kinds: ['pickaxe'], conflicts: ['silk_touch'] },
  silk_touch: { max: 1, item: 8, book: 4, kinds: ['pickaxe'], conflicts: ['fortune'] },
  protection: { max: 4, item: 1, book: 1, kinds: ['armor'], conflicts: ['fire_protection', 'blast_protection', 'projectile_protection'] },
  fire_protection: { max: 4, item: 2, book: 1, kinds: ['armor'], conflicts: ['protection', 'blast_protection', 'projectile_protection'] },
  blast_protection: { max: 4, item: 4, book: 2, kinds: ['armor'], conflicts: ['protection', 'fire_protection', 'projectile_protection'] },
  projectile_protection: { max: 4, item: 2, book: 1, kinds: ['armor'], conflicts: ['protection', 'fire_protection', 'blast_protection'] },
  thorns: { max: 3, item: 8, book: 4, kinds: ['armor'] },
  respiration: { max: 3, item: 4, book: 2, kinds: ['armor'] },
  aqua_affinity: { max: 1, item: 4, book: 2, kinds: ['armor'] },
  depth_strider: { max: 3, item: 4, book: 2, kinds: ['armor'], conflicts: ['frost_walker'] },
  frost_walker: { max: 2, item: 4, book: 2, kinds: ['armor'], conflicts: ['depth_strider'] },
  feather_falling: { max: 4, item: 2, book: 1, kinds: ['armor'] },
  soul_speed: { max: 3, item: 8, book: 4, kinds: ['armor'] },
  swift_sneak: { max: 3, item: 8, book: 4, kinds: ['armor'] },
  power: { max: 5, item: 1, book: 1, kinds: ['bow'] },
  punch: { max: 2, item: 4, book: 2, kinds: ['bow'] },
  flame: { max: 1, item: 4, book: 2, kinds: ['bow'] },
  infinity: { max: 1, item: 8, book: 4, kinds: ['bow'], conflicts: ['mending'] },
  unbreaking: { max: 3, item: 2, book: 1, kinds: ['sword', 'pickaxe', 'armor', 'bow'] },
  mending: { max: 1, item: 4, book: 2, kinds: ['sword', 'pickaxe', 'armor', 'bow'], conflicts: ['infinity'] },
  curse_of_vanishing: { max: 1, item: 8, book: 4, kinds: ['sword', 'pickaxe', 'armor', 'bow'] },
});
export const ITEM_KINDS = Object.freeze(['sword', 'pickaxe', 'armor', 'bow']);
export const ANVIL_MAX_COST = 39; // de 40 para arriba el yunque dice "Demasiado caro"
export const ANVIL_MAX_BOOKS = 8;

// Encantamientos disponibles para un tipo de item.
export function enchantsFor(kind) {
  return Object.keys(ENCHANTS).filter((id) => ENCHANTS[id].kinds.includes(kind));
}

// Penalizacion por trabajo previo: 2^n - 1 niveles, donde n es la cantidad de veces que ese item paso por el yunque.
export const priorWorkPenalty = (uses) => 2 ** Math.max(0, Math.floor(num(uses))) - 1;

// Costo de poner `sacrifice` (libro o item con sus encantamientos) sobre `target`, sin contar el renombrado.
function combineCost(target, sacrifice) {
  let cost = 0;
  for (const e of sacrifice.enchants) cost += e.level * (sacrifice.isBook ? ENCHANTS[e.id].book : ENCHANTS[e.id].item);
  return cost + priorWorkPenalty(target.work) + priorWorkPenalty(sacrifice.work);
}

// Pares de encantamientos de la lista que no pueden convivir: [[a, b], ...]
export function enchantConflicts(list) {
  const ids = list.map((e) => e.id);
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      if ((ENCHANTS[ids[i]]?.conflicts || []).includes(ids[j])) out.push([ids[i], ids[j]]);
    }
  }
  return out;
}

/**
 * Orden de combinacion en el yunque con menor costo total (y, a igual costo, el paso mas caro mas barato).
 * item: { kind, work? } (trabajo previo del item), books: [{ id, level }] (un encantamiento por libro, hasta 8).
 * Busca sobre todos los arboles de combinacion: el item siempre va a la izquierda, dos libros se pueden
 * combinar entre si en cualquier orden. Devuelve { ok, steps: [{ left, right, cost, result }], total, maxStep,
 * tooExpensive, conflicts } donde cada lado es { label: 'item' | 'book', enchants, work }.
 */
export function anvilPlan(item, books) {
  const kind = ITEM_KINDS.includes(item?.kind) ? item.kind : 'sword';
  const list = (Array.isArray(books) ? books : [])
    .filter((b) => b && ENCHANTS[b.id] && ENCHANTS[b.id].kinds.includes(kind))
    .slice(0, ANVIL_MAX_BOOKS)
    .map((b) => ({ id: b.id, level: Math.min(ENCHANTS[b.id].max, Math.max(1, Math.floor(num(b.level, 1)))) }));
  const conflicts = enchantConflicts(list);
  const n = list.length;
  if (!n) return { ok: false, steps: [], total: 0, maxStep: 0, tooExpensive: false, conflicts, books: list };
  const itemWork = Math.max(0, Math.floor(num(item?.work)));
  // Nodos: bit 0 = el item, bits 1..n = los libros. Un subconjunto se combina de todas las formas posibles y por
  // cada trabajo previo resultante se guarda el plan mas barato (el trabajo previo cambia el costo de los pasos
  // que siguen, por eso no alcanza con guardar un solo plan por subconjunto).
  const full = (1 << (n + 1)) - 1;
  const memo = new Map(); // mask -> Map(work -> { total, maxStep, steps, enchants })
  const leaf = (bit) => {
    const m = new Map();
    if (bit === 0) m.set(itemWork, { total: 0, maxStep: 0, steps: [], enchants: [], isBook: false, work: itemWork });
    else m.set(0, { total: 0, maxStep: 0, steps: [], enchants: [list[bit - 1]], isBook: true, work: 0 });
    return m;
  };
  const solve = (mask) => {
    if (memo.has(mask)) return memo.get(mask);
    let out;
    if ((mask & (mask - 1)) === 0) out = leaf(Math.log2(mask));
    else {
      out = new Map();
      const hasItem = (mask & 1) === 1;
      const lowest = mask & -mask;
      // Recorre todas las particiones {A, B} (A y B no vacios) una sola vez.
      for (let a = (mask - 1) & mask; a > 0; a = (a - 1) & mask) {
        const b = mask ^ a;
        if (!(a & lowest)) continue; // cada particion se visita con el bit mas bajo en A
        const orders = hasItem ? [[a, b]] : [[a, b], [b, a]]; // con el item, el item va a la izquierda
        for (const [l, r] of orders) {
          if (hasItem && !(l & 1)) continue;
          for (const L of solve(l).values()) {
            for (const R of solve(r).values()) {
              const stepCost = combineCost(L, R);
              const work = Math.max(L.work, R.work) + 1;
              const total = L.total + R.total + stepCost;
              const maxStep = Math.max(L.maxStep, R.maxStep, stepCost);
              const prev = out.get(work);
              if (prev && (prev.total < total || (prev.total === total && prev.maxStep <= maxStep))) continue;
              out.set(work, {
                total,
                maxStep,
                work,
                isBook: L.isBook,
                enchants: [...L.enchants, ...R.enchants],
                steps: [...L.steps, ...R.steps, { left: side(L), right: side(R), cost: stepCost, result: { enchants: [...L.enchants, ...R.enchants], work, isBook: L.isBook } }],
              });
            }
          }
        }
      }
    }
    memo.set(mask, out);
    return out;
  };
  const side = (node) => ({ label: node.isBook ? 'book' : 'item', enchants: node.enchants.map((e) => ({ ...e })), work: node.work });
  let best = null;
  for (const cand of solve(full).values()) {
    if (!best || cand.total < best.total || (cand.total === best.total && cand.maxStep < best.maxStep)) best = cand;
  }
  return { ok: true, steps: best.steps, total: best.total, maxStep: best.maxStep, tooExpensive: best.maxStep > ANVIL_MAX_COST, conflicts, books: list };
}

// Nivel en numeros romanos (I a X), como lo muestra el juego.
export function roman(n) {
  const v = Math.max(1, Math.min(10, Math.floor(num(n, 1))));
  return ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][v - 1];
}

// ---------- Ticks, segundos y hora del dia ----------
export const TICKS_PER_SECOND = 20;
export const TICKS_PER_DAY = 24000;
// Valores de /time set que todo el mundo usa.
export const TIME_PRESETS = Object.freeze([
  ['day', 1000],
  ['noon', 6000],
  ['sunset', 12000],
  ['night', 13000],
  ['midnight', 18000],
  ['sunrise', 23000],
]);

export const ticksToSeconds = (ticks) => num(ticks) / TICKS_PER_SECOND;
export const secondsToTicks = (seconds) => Math.round(num(seconds) * TICKS_PER_SECOND);

// Ticks del dia (0 = 06:00) -> { hours, minutes, clock: 'HH:MM', day: dia del mundo (desde 0) }.
export function ticksToClock(ticks) {
  const t = Math.floor(num(ticks));
  const day = Math.floor(t / TICKS_PER_DAY);
  const inDay = ((t % TICKS_PER_DAY) + TICKS_PER_DAY) % TICKS_PER_DAY;
  const totalMinutes = Math.floor((inDay / TICKS_PER_DAY) * 1440 + 6 * 60) % 1440;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return { hours, minutes, clock: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`, day, inDay };
}

// 'HH:MM' -> ticks del dia (0 a 23999).
export function clockToTicks(clock) {
  const m = /^\s*(\d{1,2})(?::(\d{1,2}))?\s*$/.exec(String(clock ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2] || 0);
  if (h > 23 || mi > 59) return null;
  const minutes = (((h - 6) * 60 + mi) % 1440 + 1440) % 1440;
  return Math.round((minutes / 1440) * TICKS_PER_DAY) % TICKS_PER_DAY;
}

// Periodo del dia para una cantidad de ticks del dia: 'day', 'sunset', 'night' o 'sunrise'.
export function dayPhase(ticks) {
  const t = ticksToClock(ticks).inDay;
  if (t < 12000) return 'day';
  if (t < 13000) return 'sunset';
  if (t < 23000) return 'night';
  return 'sunrise';
}

// ---------- Codigos de color § ----------
export const COLOR_CODES = Object.freeze({
  0: '#000000',
  1: '#0000AA',
  2: '#00AA00',
  3: '#00AAAA',
  4: '#AA0000',
  5: '#AA00AA',
  6: '#FFAA00',
  7: '#AAAAAA',
  8: '#555555',
  9: '#5555FF',
  a: '#55FF55',
  b: '#55FFFF',
  c: '#FF5555',
  d: '#FF55FF',
  e: '#FFFF55',
  f: '#FFFFFF',
});
export const FORMAT_CODES = Object.freeze({ k: 'obfuscated', l: 'bold', m: 'strike', n: 'underline', o: 'italic' });

const plainStyle = () => ({ color: null, bold: false, italic: false, underline: false, strike: false, obfuscated: false });

/**
 * Texto con codigos § (o & si alt = true) -> [{ text, color, bold, italic, underline, strike, obfuscated }].
 * Como en el juego, un codigo de color borra los formatos anteriores y §r vuelve a lo normal.
 */
export function parseColorCodes(input, { alt = false } = {}) {
  const s = String(input ?? '');
  const prefixes = alt ? ['§', '&'] : ['§'];
  const out = [];
  let style = plainStyle();
  let buf = '';
  const flush = () => {
    if (buf) out.push({ text: buf, ...style });
    buf = '';
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = i + 1 < s.length ? s[i + 1].toLowerCase() : '';
    if (prefixes.includes(ch) && (COLOR_CODES[code] || FORMAT_CODES[code] || code === 'r')) {
      flush();
      if (code === 'r') style = plainStyle();
      else if (COLOR_CODES[code]) style = { ...plainStyle(), color: COLOR_CODES[code] };
      else style = { ...style, [FORMAT_CODES[code]]: true };
      i++;
      continue;
    }
    buf += ch;
  }
  flush();
  return out;
}

// Texto sin codigos de color ni formato.
export function stripColorCodes(input, opts) {
  return parseColorCodes(input, opts).map((p) => p.text).join('');
}

// ---------- Bloque <-> chunk <-> region ----------
export function blockToChunk(x, z) {
  const bx = Math.floor(num(x));
  const bz = Math.floor(num(z));
  const cx = Math.floor(bx / 16);
  const cz = Math.floor(bz / 16);
  const rx = Math.floor(cx / 32);
  const rz = Math.floor(cz / 32);
  return {
    block: { x: bx, z: bz },
    chunk: { x: cx, z: cz, from: { x: cx * 16, z: cz * 16 }, to: { x: cx * 16 + 15, z: cz * 16 + 15 } },
    local: { x: bx - cx * 16, z: bz - cz * 16 },
    region: { x: rx, z: rz, file: `r.${rx}.${rz}.mca`, from: { x: rx * 512, z: rz * 512 }, to: { x: rx * 512 + 511, z: rz * 512 + 511 } },
  };
}

// Chunk -> bloques que abarca y region a la que pertenece.
export function chunkToBlocks(cx, cz) {
  return blockToChunk(Math.floor(num(cx)) * 16, Math.floor(num(cz)) * 16);
}

// Region -> chunks y bloques que abarca.
export function regionToBlocks(rx, rz) {
  const x = Math.floor(num(rx));
  const z = Math.floor(num(rz));
  return {
    region: { x, z, file: `r.${x}.${z}.mca` },
    chunks: { from: { x: x * 32, z: z * 32 }, to: { x: x * 32 + 31, z: z * 32 + 31 } },
    blocks: { from: { x: x * 512, z: z * 512 }, to: { x: x * 512 + 511, z: z * 512 + 511 } },
  };
}

// 'r.-1.3.mca' -> { x: -1, z: 3 } o null.
export function parseRegionFile(name) {
  const m = /^r\.(-?\d+)\.(-?\d+)\.mc[ar]$/i.exec(String(name ?? '').trim());
  return m ? { x: Number(m[1]), z: Number(m[2]) } : null;
}
