// Biomas del Nether (1.16+). Port de setNetherSeed() y getNetherBiome() de biomenoise.c de cubiomes (MIT, ver
// LICENSE-cubiomes.txt): dos ruidos dobles y el punto de biomas mas cercano; la altura no influye.
import { JavaRandom } from './rng.js';
import { javaDoublePerlin, sampleDoublePerlin } from './noise.js';
import { NETHER_WASTES, SOUL_SAND_VALLEY, CRIMSON_FOREST, WARPED_FOREST, BASALT_DELTAS } from './biomes.js';

const F = Math.fround;
const IDS = [NETHER_WASTES, SOUL_SAND_VALLEY, CRIMSON_FOREST, WARPED_FOREST, BASALT_DELTAS];
const P0 = Float32Array.of(0, 0, 0.4, 0, -0.5);
const P1 = Float32Array.of(0, -0.5, 0, 0.5, 0);
const P2 = Float32Array.of(0, 0, 0, 0.375 * 0.375, 0.175 * 0.175);
const FLT_MAX = F(3.4028234663852886e38);

export class NetherNoise {
  constructor(seed) {
    const rng = new JavaRandom().setSeed(seed);
    this.temperature = javaDoublePerlin(rng, -7, 2);
    rng.setSeed(seed + 1n);
    this.humidity = javaDoublePerlin(rng, -7, 2);
  }

  // x y z en celdas 1:4
  biome(x, z) {
    const temp = F(sampleDoublePerlin(this.temperature, x, 0, z));
    const humidity = F(sampleDoublePerlin(this.humidity, x, 0, z));
    let id = 0;
    let dmin = FLT_MAX;
    for (let i = 0; i < 5; i++) {
      const dx = F(P0[i] - temp);
      const dy = F(P1[i] - humidity);
      const dsq = F(F(F(dx * dx) + F(dy * dy)) + P2[i]);
      if (dsq < dmin) {
        dmin = dsq;
        id = i;
      }
    }
    return IDS[id];
  }
}
