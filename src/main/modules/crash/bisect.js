'use strict';
// Nucleo de la busqueda automatica del mod culpable (sin Electron ni archivos: se prueba con un
// runner falso). Recibe los mods con sus dependencias y una funcion test(conjunto) que prueba el juego
// con exactamente esos mods activos.
//
// - Dependencias: activar un mod activa lo que necesita (las librerias se mantienen cuando hacen falta)
//   y quitar un mod quita tambien lo que depende de el.
// - Busqueda binaria: cada prueba divide los candidatos en dos mitades "cerradas" (cada mitad incluye
//   sus dependencias) y los sospechosos del analisis van primero, asi suele alcanzar con ~log2(n) pruebas.
// - Conflictos: si ninguna mitad falla sola pero juntas si, busca el par que choca.
// - Si una prueba falla por una dependencia que no conociamos, la aprende y repite esa prueba.
// - Al final confirma que sin el culpable el juego anda; si no, revisa si el problema viene de los mods
//   y busca otro culpable entre el resto.

const DEFAULT_ENV = new Set([
  'minecraft', 'java', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt-loader', 'quilted_fabric_loader',
  'forge', 'neoforge', 'fml', 'javafml', 'lowcodefml', 'mcp', 'minecraftforge', 'mixinextras', 'mixin', 'jdk',
]);

class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.cancelled = true;
  }
}

class MissingDependency extends Error {
  constructor(missing) {
    super('missing dependency');
    this.missing = missing;
  }
}

const lower = (s) => String(s ?? '').toLowerCase();

/**
 * mods: [{ key, ids: [], provides: [], deps: [ids requeridos], library? }]
 */
function createGraph(mods, envIds = DEFAULT_ENV) {
  const byKey = new Map(mods.map((m) => [m.key, m]));
  const providers = new Map();
  const add = (id, key) => {
    const k = lower(id);
    if (!k) return;
    if (!providers.has(k)) providers.set(k, []);
    const list = providers.get(k);
    if (!list.includes(key)) list.push(key);
  };
  for (const m of mods) {
    for (const id of m.ids || []) add(id, m.key);
    for (const id of m.provides || []) add(id, m.key);
  }
  const learned = new Map();
  const pinned = new Set();
  const depIds = (key) => {
    const base = (byKey.get(key)?.deps || []).map(lower);
    const extra = learned.get(key);
    return extra ? [...base, ...extra] : base;
  };
  const primaryOf = (key) => lower(byKey.get(key)?.ids?.[0]);

  function choose(list, set, id) {
    for (const k of list) if (set && set.has(k)) return k;
    return list.find((k) => primaryOf(k) === id) || list.find((k) => byKey.get(k)?.library) || list[0];
  }

  // Dependencias directas (claves) de un mod, eligiendo proveedores dentro de "set" si se puede
  function requires(key, set) {
    const out = [];
    for (const id of depIds(key)) {
      if (envIds.has(id)) continue;
      const list = providers.get(id);
      if (!list || list.includes(key)) continue;
      out.push(choose(list, set, id));
    }
    return out;
  }

  // Conjunto + todo lo que necesita para cargar (y las dependencias fijadas a mano)
  function closure(keys) {
    const set = new Set([...keys, ...pinned]);
    const stack = [...set];
    while (stack.length) {
      const k = stack.pop();
      for (const id of depIds(k)) {
        if (envIds.has(id)) continue;
        const list = providers.get(id);
        if (!list || list.includes(k) || list.some((p) => set.has(p))) continue;
        const p = choose(list, set, id);
        if (p && !set.has(p)) {
          set.add(p);
          stack.push(p);
        }
      }
    }
    return set;
  }

  // Al quitar estos mods tambien se quitan los que dependen de ellos (directa o indirectamente)
  function withDependents(keys) {
    const removed = new Set(keys);
    let changed = true;
    while (changed) {
      changed = false;
      for (const m of mods) {
        if (removed.has(m.key)) continue;
        for (const id of depIds(m.key)) {
          if (envIds.has(id)) continue;
          const list = providers.get(id);
          if (!list || list.includes(m.key)) continue;
          if (list.every((p) => removed.has(p))) {
            removed.add(m.key);
            changed = true;
            break;
          }
        }
      }
    }
    return removed;
  }

  // "El mod X necesita Y" descubierto al probar: se agrega al grafico
  function learn(requesterId, depId) {
    const dep = lower(depId);
    if (!providers.has(dep) || envIds.has(dep)) return false;
    const reqKeys = providers.get(lower(requesterId)) || [];
    let changed = false;
    for (const k of reqKeys) {
      if (depIds(k).includes(dep) || providers.get(dep).includes(k)) continue;
      if (!learned.has(k)) learned.set(k, []);
      learned.get(k).push(dep);
      changed = true;
    }
    if (!changed && !reqKeys.length) {
      // No sabemos que archivo la pide: la dependencia queda siempre activa
      const p = choose(providers.get(dep), null, dep);
      if (p && !pinned.has(p)) {
        pinned.add(p);
        changed = true;
      }
    }
    return changed;
  }

  return { byKey, providers, closure, withDependents, requires, learn, pinned, hasProvider: (id) => providers.has(lower(id)) };
}

// Orden con las dependencias antes que quien las usa y lo mas sospechoso lo antes posible:
// cualquier prefijo de este orden ya incluye sus propias dependencias.
function prioritizedOrder(cands, graph, weight) {
  const inSet = new Set(cands);
  const out = [];
  const done = new Set();
  const visit = (k, stack) => {
    if (done.has(k) || stack.has(k)) return;
    stack.add(k);
    for (const d of graph.requires(k, inSet)) if (inSet.has(d)) visit(d, stack);
    stack.delete(k);
    done.add(k);
    out.push(k);
  };
  const sorted = cands
    .map((k, i) => [k, i])
    .sort((a, b) => weight(b[0]) - weight(a[0]) || a[1] - b[1])
    .map((x) => x[0]);
  for (const k of sorted) visit(k, new Set());
  return out;
}

function split(cands, graph, weight) {
  const order = prioritizedOrder(cands, graph, weight);
  const total = order.reduce((a, k) => a + weight(k), 0);
  const A = [];
  let acc = 0;
  for (const k of order) {
    if (A.length >= order.length - 1) break;
    A.push(k);
    acc += weight(k);
    if (acc >= total / 2) break;
  }
  const inA = new Set(A);
  return [A, order.filter((k) => !inA.has(k))];
}

function estimateRounds(n) {
  if (n <= 0) return 0;
  return 1 + Math.ceil(1.4 * Math.log2(Math.max(2, n))) + 1;
}

/**
 * Corre la busqueda.
 * opts: {
 *   mods, test: async (Set enabledKeys, info) => ({ pass: bool, kind?, ms?, missing?: [{ requester, dependency }], cancelled? }),
 *   suspects?: { key: puntaje }, signal?, onProgress?(evento), maxCulprits?: 3, envIds?
 * }
 * Devuelve { kind: 'culprit'|'conflict'|'multiple'|'notReproduced'|'notMods'|'noMods'|'missingDependency',
 *            culprits: [[keys]], removedWith: [keys], confirmed, rounds, history, missing? }
 */
async function runBisect(opts) {
  const { mods, test, suspects = {}, signal, onProgress, maxCulprits = 3 } = opts;
  const graph = createGraph(mods, opts.envIds || DEFAULT_ENV);
  const all = mods.map((m) => m.key);
  const n = all.length;
  const history = [];
  const cache = new Map();
  let round = 0;
  let phase = 'verify';
  let poolSize = n;
  let pending = estimateRounds(n);
  if (!n) return { kind: 'noMods', culprits: [], removedWith: [], confirmed: false, rounds: 0, history };

  const weight = (k) => 1 + (Math.max(0, n - 1) * Math.min(10, Number(suspects[k]) || 0)) / 10;
  const emit = (ev) => {
    try {
      onProgress?.(ev);
    } catch {
      /* el progreso nunca corta la busqueda */
    }
  };
  const estimateLeft = () => Math.max(0, Math.ceil(1.4 * Math.log2(Math.max(1, poolSize))) + (phase === 'confirm' ? 0 : 1));

  async function fails(keys, purpose) {
    for (let attempt = 0; attempt < 10; attempt++) {
      if (signal?.aborted) throw new Cancelled();
      const enabled = graph.closure(keys);
      const id = [...enabled].sort().join('\n');
      if (cache.has(id)) return cache.get(id);
      round++;
      pending = round + estimateLeft();
      emit({ type: 'test', round, phase, purpose, enabled: [...enabled], estimate: pending });
      const r = (await test(enabled, { round, phase, purpose })) || {};
      if (r.cancelled || signal?.aborted) throw new Cancelled();
      if (r.missing?.length) {
        let fixed = false;
        for (const miss of r.missing) fixed = graph.learn(miss.requester, miss.dependency) || fixed;
        history.push({ round, phase, purpose, enabled: enabled.size, result: 'dependency', kind: 'dependency', ms: r.ms || 0 });
        emit({ type: 'result', round, phase, result: 'dependency', ms: r.ms || 0 });
        if (fixed) continue;
        throw new MissingDependency(r.missing);
      }
      const failed = !r.pass;
      cache.set(id, failed);
      history.push({ round, phase, purpose, enabled: enabled.size, result: failed ? 'fails' : 'works', kind: r.kind || null, ms: r.ms || 0 });
      emit({ type: 'result', round, phase, result: failed ? 'fails' : 'works', kind: r.kind || null, ms: r.ms || 0 });
      return failed;
    }
    throw new Error('Demasiadas dependencias desconocidas');
  }

  // Invariante: falla(base + cands) y anda(base)
  async function search(cands, base) {
    poolSize = cands.length;
    if (cands.length === 1) return single(cands[0], base);
    const [A, B] = split(cands, graph, weight);
    if (await fails([...base, ...A], 'half')) return search(A, base);
    // A anda: lo mas probable es que B falle sola. Se busca adentro sin gastar una prueba en B entera.
    const quick = await guess(B, base);
    if (quick) return quick;
    poolSize = B.length;
    if (await fails([...base, ...B], 'half')) return search(B, base);
    // Ninguna mitad falla sola: un mod de A choca con uno de B
    const prev = phase;
    phase = 'conflict';
    const b = await search(B, [...base, ...A]);
    const a = await search(A, [...base, ...b]);
    phase = prev;
    return [...new Set([...a, ...b])];
  }

  // Como search, pero sin saber si falla(base + cands): devuelve null si la suposicion resulta falsa
  async function guess(cands, base) {
    poolSize = cands.length;
    if (cands.length === 1) {
      if (!(await fails([...base, cands[0]], 'check'))) return null;
      return single(cands[0], base);
    }
    const [A, B] = split(cands, graph, weight);
    if (await fails([...base, ...A], 'half')) return search(A, base);
    return guess(B, base);
  }

  // Un solo candidato: si arrastra dependencias, ver si el problema esta en ellas
  async function single(k, base) {
    const baseSet = graph.closure(base);
    const extra = [...graph.closure([...base, k])].filter((x) => x !== k && !baseSet.has(x));
    if (!extra.length) return [k];
    poolSize = extra.length;
    if (await fails([...base, ...extra], 'deps')) return search(extra, base);
    return [k];
  }

  try {
    phase = 'verify';
    if (!(await fails(all, 'all'))) return { kind: 'notReproduced', culprits: [], removedWith: [], confirmed: false, rounds: round, history };
    const culprits = [];
    let pool = all;
    for (let i = 0; i < maxCulprits && pool.length; i++) {
      phase = 'search';
      const found = await search(pool, []);
      culprits.push(found);
      phase = 'confirm';
      const flat = culprits.flat();
      const removed = graph.withDependents(flat);
      const rest = all.filter((k) => !removed.has(k));
      const removedWith = [...removed].filter((k) => !flat.includes(k));
      if (!(await fails(rest, 'confirm'))) {
        const kind = culprits.length > 1 ? 'multiple' : found.length > 1 ? 'conflict' : 'culprit';
        return { kind, culprits, removedWith, confirmed: true, rounds: round, history };
      }
      // Sigue fallando sin el culpable: ¿el juego falla incluso sin mods?
      phase = 'vanilla';
      if (await fails([], 'none')) return { kind: 'notMods', culprits, removedWith: [], confirmed: false, rounds: round, history };
      pool = rest;
    }
    return { kind: 'multiple', culprits, removedWith: [], confirmed: false, rounds: round, history };
  } catch (err) {
    if (err instanceof MissingDependency) return { kind: 'missingDependency', culprits: [], removedWith: [], confirmed: false, rounds: round, history, missing: err.missing };
    throw err;
  }
}

module.exports = { runBisect, createGraph, prioritizedOrder, split, estimateRounds, Cancelled, MissingDependency, DEFAULT_ENV };
