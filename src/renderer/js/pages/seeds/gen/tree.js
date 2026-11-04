// Tabla de biomas del Overworld (1.18+): de los 6 parametros climaticos al bioma mas cercano. Port de get_np_dist(),
// get_resulting_node() y climateToBiome() de biomenoise.c de cubiomes (MIT, ver LICENSE-cubiomes.txt).
// Cada nodo guarda sus 6 rangos ya resueltos en Int16Array, sin ir a buscarlos a la tabla de parametros en cada paso.

const decode = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// Datos de tables/btree*.js -> arreglos listos para buscar
export function buildTree(data) {
  const nodes = decode(data.nodes);
  const paramBytes = decode(data.param);
  const param = new Int16Array(paramBytes.buffer, paramBytes.byteOffset, paramBytes.length / 2);
  const len = nodes.length / 8;
  const ranges = new Int16Array(len * 12);
  const inner = new Uint16Array(len);
  for (let i = 0; i < len; i++) {
    const o = i * 8;
    for (let k = 0; k < 6; k++) {
      const p = nodes[o + k] * 2;
      ranges[i * 12 + k * 2] = param[p];
      ranges[i * 12 + k * 2 + 1] = param[p + 1];
    }
    inner[i] = nodes[o + 6] | (nodes[o + 7] << 8);
  }
  return { ranges, inner, steps: Int32Array.from(data.steps), order: data.order, len };
}

// Estado de una busqueda: un solo hilo, asi no se crean objetos por muestra
let ranges = null;
let inner = null;
let steps = null;
let order = 0;
let len = 0;
let current = null;
let n0 = 0;
let n1 = 0;
let n2 = 0;
let n3 = 0;
let n4 = 0;
let n5 = 0;

function use(tree) {
  current = tree;
  ranges = tree.ranges;
  inner = tree.inner;
  steps = tree.steps;
  order = tree.order;
  len = tree.len;
}

// Distancia al cuadrado a los rangos de un nodo: max(n - max, min - n, 0) por parametro, sin saltos porque el resultado
// casi no se puede predecir. `limit` corta la cuenta: quien llama solo mira si da menos que eso.
function dist(idx, limit) {
  const o = idx * 12;
  const r = ranges;
  let a = (n0 - r[o + 1]) | 0;
  let b = (r[o] - n0) | 0;
  let m = (a - ((a - b) & ((a - b) >> 31))) | 0;
  m &= ~(m >> 31);
  let ds = m * m;
  a = (n1 - r[o + 3]) | 0;
  b = (r[o + 2] - n1) | 0;
  m = (a - ((a - b) & ((a - b) >> 31))) | 0;
  m &= ~(m >> 31);
  ds += m * m;
  a = (n2 - r[o + 5]) | 0;
  b = (r[o + 4] - n2) | 0;
  m = (a - ((a - b) & ((a - b) >> 31))) | 0;
  m &= ~(m >> 31);
  ds += m * m;
  if (ds >= limit) return ds;
  a = (n3 - r[o + 7]) | 0;
  b = (r[o + 6] - n3) | 0;
  m = (a - ((a - b) & ((a - b) >> 31))) | 0;
  m &= ~(m >> 31);
  ds += m * m;
  a = (n4 - r[o + 9]) | 0;
  b = (r[o + 8] - n4) | 0;
  m = (a - ((a - b) & ((a - b) >> 31))) | 0;
  m &= ~(m >> 31);
  ds += m * m;
  a = (n5 - r[o + 11]) | 0;
  b = (r[o + 10] - n5) | 0;
  m = (a - ((a - b) & ((a - b) >> 31))) | 0;
  m &= ~(m >> 31);
  return ds + m * m;
}

function search(idx, alt, ds, depth) {
  if (steps[depth] === 0) return idx;
  let step;
  do {
    step = steps[depth];
    depth++;
  } while (idx + step >= len);
  let child = inner[idx];
  let leaf = alt;
  for (let i = 0; i < order; i++) {
    const dsChild = dist(child, ds);
    if (dsChild < ds) {
      const leaf2 = search(child, leaf, ds, depth);
      const dsLeaf2 = child === leaf2 ? dsChild : dist(leaf2, ds);
      if (dsLeaf2 < ds) {
        ds = dsLeaf2;
        leaf = leaf2;
      }
    }
    child += step;
    if (child >= len) break;
  }
  return leaf;
}

// Nodo mas cercano a los parametros. `alt` >= 0 arranca desde el resultado anterior, como hace el juego (MC-241546): en
// un empate el resultado depende del orden en que se generan los puntos.
export function nearestNode(tree, t, h, c, e, d, w, alt) {
  if (tree !== current) use(tree);
  n0 = t;
  n1 = h;
  n2 = c;
  n3 = e;
  n4 = d;
  n5 = w;
  if (alt < 0) return search(0, 0, Infinity, 0);
  return search(0, alt, dist(alt, Infinity), 0);
}

export function biomeOfNode(tree, node) {
  return tree.inner[node] & 255;
}
