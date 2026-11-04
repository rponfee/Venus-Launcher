// Los mismos hashes que harness.c, para comparar areas enteras sin guardar cada bioma.

// hash32() de tests.c de cubiomes
export function hash32(xIn) {
  let x = xIn >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0xd168aaad) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0xaf723597) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  return x;
}

export function mixId(hash, i, id) {
  return hash32((hash ^ hash32((id + (i << 17)) >>> 0)) >>> 0);
}

// Una linea "grid" del harness en el Overworld o el Nether. En las de genBiomes (how: gen) `step` es la escala 1:4 de
// cubiomes, celda por celda; en las otras es el paso entre celdas.
export function gridHash(world, c) {
  const stride = c.how === 'gen' ? 1 : c.step;
  let hash = 0;
  for (let j = 0; j < c.h; j++) {
    for (let i = 0; i < c.w; i++) {
      hash = mixId(hash, j * c.w + i, world.biomeAt(c.x + i * stride, c.y, c.z + j * stride));
    }
  }
  return hash;
}

// Una linea "grid" del End: genBiomes() de cubiomes con escala 4, 16 u otra
export function endGridHash(world, c) {
  const out = new Int32Array(c.w * c.h);
  if (c.step === 4) {
    // mapEnd(): cada celda 1:4 toma el bioma de su chunk
    const cx = c.x >> 2;
    const cz = c.z >> 2;
    const cw = ((c.x + c.w) >> 2) + 1 - cx;
    const ch = ((c.z + c.h) >> 2) + 1 - cz;
    const buf = new Int32Array(cw * ch);
    world.end.area(buf, cx, cz, cw, ch);
    for (let j = 0; j < c.h; j++) {
      const cj = ((c.z + j) >> 2) - cz;
      for (let i = 0; i < c.w; i++) out[j * c.w + i] = buf[cj * cw + (((c.x + i) >> 2) - cx)];
    }
  } else if (c.step === 16) {
    world.end.area(out, c.x, c.z, c.w, c.h);
  } else {
    world.end.areaScaled(out, c.step, c.x, c.z, c.w, c.h);
  }
  let hash = 0;
  for (let i = 0; i < c.w * c.h; i++) hash = mixId(hash, i, out[i]);
  return hash;
}

// getRef() de tests.c: 4^bits semillas chicas, un punto por semilla. `makeWorld(seedBig)` arma el mundo.
export function getRef(makeWorld, bits) {
  const r = 1 << (bits - 1);
  let h = 0;
  for (let x = -r; x < r; x++) {
    for (let z = -r; z < r; z++) {
      const s = (z << bits) ^ x;
      const world = makeWorld(BigInt(s));
      const y = ((hash32(s) & 0x7fffffff) % 384 - 64) >> 2;
      const id = world.biomeAt(x, y, z);
      h ^= hash32(s ^ (id << (2 * bits)));
    }
  }
  return h >>> 0;
}
