// Lo que hace un hilo de calculo del visor: recibe un trabajo, lo resuelve y contesta. Lo usan worker.js y, si el navegador
// no deja crear el Worker, pool.js en el hilo de la interfaz.
import { SeedWorld, loadTree, TILE } from './gen/world.js';
import { versionByKey } from './gen/versions.js';

export function createService(post) {
  let world = null;
  let gen = 0;
  let strongIt = null;
  let strongDone = false;

  async function init(msg) {
    gen = msg.gen;
    world = null;
    strongIt = null;
    strongDone = false;
    const version = versionByKey(msg.version);
    const tree = msg.dim === 0 ? await loadTree(version.table) : null;
    if (gen !== msg.gen) return;
    world = new SeedWorld({ seed: BigInt(msg.seed), version: msg.version, dim: msg.dim, tree });
  }

  function tile(msg) {
    const ids = new Uint8Array(TILE * TILE);
    world.fillTile(ids, msg.level, msg.tx, msg.tz, msg.y);
    post({ t: 'tile', gen, job: msg.job, key: msg.key, level: msg.level, tx: msg.tx, tz: msg.tz, ids }, [ids.buffer]);
  }

  function structs(msg) {
    const results = [];
    const { regions, type } = msg;
    for (let i = 0; i < regions.length; i += 2) {
      results.push(world.finder.evaluate(type, regions[i], regions[i + 1]));
    }
    post({ t: 'structs', gen, job: msg.job, type, regions, results });
  }

  function strong(msg) {
    if (!strongIt) strongIt = world.finder.strongholds();
    const list = [];
    for (let i = 0; i < msg.count && !strongDone; i++) {
      const r = strongIt.next();
      if (r.done) strongDone = true;
      else list.push(r.value);
    }
    if (list.length === 0) strongDone = true;
    post({ t: 'strong', gen, job: msg.job, list, done: strongDone });
  }

  async function handle(msg) {
    if (msg.t === 'init') {
      await init(msg);
      return;
    }
    if (msg.gen !== gen || !world) {
      // Trabajo de un mundo anterior: se contesta para liberar el hilo, sin calcular nada
      post({ t: 'skip', gen: msg.gen, job: msg.job });
      return;
    }
    try {
      if (msg.t === 'tile') tile(msg);
      else if (msg.t === 'structs') structs(msg);
      else if (msg.t === 'strong') strong(msg);
      else if (msg.t === 'spawn') post({ t: 'spawn', gen, job: msg.job, pos: world.finder.spawn() });
      else if (msg.t === 'biome') post({ t: 'biome', gen, job: msg.job, x: msg.x, z: msg.z, id: world.biomeAt(msg.x >> 2, msg.y, msg.z >> 2) });
    } catch (err) {
      console.error('[seeds]', err);
      post({ t: 'failed', gen, job: msg.job, kind: msg.t, key: msg.key });
    }
  }

  return { handle };
}
