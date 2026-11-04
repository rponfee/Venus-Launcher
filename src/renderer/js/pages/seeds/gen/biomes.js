// Biomas que puede dar el generador en 1.18+ (ids internos de cubiomes). Los colores son los de initBiomeColors() en
// util.c de cubiomes, inspirados en AMIDST (MIT, ver LICENSE-cubiomes.txt). Son datos del mapa: no cambian con el tema.
import { MC_1_19_2, MC_1_20, MC_1_21_WD } from './versions.js';

const RAW = [
  [0, 'ocean', 0x000070],
  [1, 'plains', 0x8db360],
  [2, 'desert', 0xfa9418],
  [3, 'windswept_hills', 0x606060],
  [4, 'forest', 0x056621],
  [5, 'taiga', 0x0b6a5f],
  [6, 'swamp', 0x07f9b2],
  [7, 'river', 0x0000ff],
  [8, 'nether_wastes', 0x572526],
  [9, 'the_end', 0x8080ff],
  [10, 'frozen_ocean', 0x7070d6],
  [11, 'frozen_river', 0xa0a0ff],
  [12, 'snowy_plains', 0xffffff],
  [14, 'mushroom_fields', 0xff00ff],
  [16, 'beach', 0xfade55],
  [21, 'jungle', 0x507b0a],
  [23, 'sparse_jungle', 0x60930f],
  [24, 'deep_ocean', 0x000030],
  [25, 'stony_shore', 0xa2a284],
  [26, 'snowy_beach', 0xfaf0c0],
  [27, 'birch_forest', 0x307444],
  [29, 'dark_forest', 0x40511a],
  [30, 'snowy_taiga', 0x31554a],
  [32, 'old_growth_pine_taiga', 0x596651],
  [34, 'windswept_forest', 0x5b7352],
  [35, 'savanna', 0xbdb25f],
  [36, 'savanna_plateau', 0xa79d64],
  [37, 'badlands', 0xd94515],
  [38, 'wooded_badlands', 0xb09765],
  [40, 'small_end_islands', 0x4b4bab],
  [41, 'end_midlands', 0xc9c959],
  [42, 'end_highlands', 0xb5b536],
  [43, 'end_barrens', 0x7070cc],
  [44, 'warm_ocean', 0x0000ac],
  [45, 'lukewarm_ocean', 0x000090],
  [46, 'cold_ocean', 0x202070],
  [48, 'deep_lukewarm_ocean', 0x000040],
  [49, 'deep_cold_ocean', 0x202038],
  [50, 'deep_frozen_ocean', 0x404090],
  [129, 'sunflower_plains', 0xb5db88],
  [131, 'windswept_gravelly_hills', 0x888888],
  [132, 'flower_forest', 0x2d8e49],
  [140, 'ice_spikes', 0xb4dcdc],
  [155, 'old_growth_birch_forest', 0x589c6c],
  [160, 'old_growth_spruce_taiga', 0x818e79],
  [163, 'windswept_savanna', 0xe5da87],
  [165, 'eroded_badlands', 0xff6d3d],
  [168, 'bamboo_jungle', 0x849500],
  [170, 'soul_sand_valley', 0x4d3a2e],
  [171, 'crimson_forest', 0x981a11],
  [172, 'warped_forest', 0x49907b],
  [173, 'basalt_deltas', 0x645f63],
  [174, 'dripstone_caves', 0x4e3012],
  [175, 'lush_caves', 0x283c00],
  [177, 'meadow', 0x60a445],
  [178, 'grove', 0x47726c],
  [179, 'snowy_slopes', 0xc4c4c4],
  [180, 'jagged_peaks', 0xdcdcc8],
  [181, 'frozen_peaks', 0xb0b3ce],
  [182, 'stony_peaks', 0x7b8f74],
  [183, 'deep_dark', 0x031f29],
  [184, 'mangrove_swamp', 0x2ccc8e],
  [185, 'cherry_grove', 0xff91c8],
  [186, 'pale_garden', 0x696d95],
];

// Nombre del bioma por id (la clave de i18n es seeds.b_<nombre>)
export const BIOME_KEYS = new Map(RAW.map(([id, key]) => [id, key]));
// Id de bioma -> color 0xAABBGGRR, en el orden de bytes que espera un ImageData sobre Uint32Array
export const BIOME_RGBA = new Uint32Array(256).fill(0xff000000);
for (const [id, , rgb] of RAW) BIOME_RGBA[id] = 0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
export const BIOME_CSS = new Map(RAW.map(([id, , rgb]) => [id, `#${rgb.toString(16).padStart(6, '0')}`]));

export const OCEAN = 0;
export const PLAINS = 1;
export const DESERT = 2;
export const FOREST = 4;
export const TAIGA = 5;
export const SWAMP = 6;
export const RIVER = 7;
export const NETHER_WASTES = 8;
export const THE_END = 9;
export const FROZEN_OCEAN = 10;
export const FROZEN_RIVER = 11;
export const SNOWY_PLAINS = 12;
export const MUSHROOM_FIELDS = 14;
export const BEACH = 16;
export const JUNGLE = 21;
export const DEEP_OCEAN = 24;
export const SNOWY_BEACH = 26;
export const DARK_FOREST = 29;
export const SNOWY_TAIGA = 30;
export const OLD_GROWTH_PINE_TAIGA = 32;
export const SAVANNA = 35;
export const SMALL_END_ISLANDS = 40;
export const END_MIDLANDS = 41;
export const END_HIGHLANDS = 42;
export const END_BARRENS = 43;
export const WARM_OCEAN = 44;
export const LUKEWARM_OCEAN = 45;
export const COLD_OCEAN = 46;
export const DEEP_WARM_OCEAN = 47;
export const DEEP_LUKEWARM_OCEAN = 48;
export const DEEP_COLD_OCEAN = 49;
export const DEEP_FROZEN_OCEAN = 50;
export const OLD_GROWTH_BIRCH_FOREST = 155;
export const OLD_GROWTH_SPRUCE_TAIGA = 160;
export const BAMBOO_JUNGLE = 168;
export const SOUL_SAND_VALLEY = 170;
export const CRIMSON_FOREST = 171;
export const WARPED_FOREST = 172;
export const BASALT_DELTAS = 173;
export const MEADOW = 177;
export const GROVE = 178;
export const SNOWY_SLOPES = 179;
export const JAGGED_PEAKS = 180;
export const FROZEN_PEAKS = 181;
export const STONY_PEAKS = 182;
export const DEEP_DARK = 183;
export const MANGROVE_SWAMP = 184;
export const CHERRY_GROVE = 185;
export const PALE_GARDEN = 186;

const NETHER_IDS = new Set([NETHER_WASTES, SOUL_SAND_VALLEY, CRIMSON_FOREST, WARPED_FOREST, BASALT_DELTAS]);
const END_IDS = new Set([THE_END, SMALL_END_ISLANDS, END_MIDLANDS, END_HIGHLANDS, END_BARRENS]);
const DEEP_OCEANS = new Set([DEEP_OCEAN, DEEP_WARM_OCEAN, DEEP_LUKEWARM_OCEAN, DEEP_COLD_OCEAN, DEEP_FROZEN_OCEAN]);
const OCEANS = new Set([OCEAN, FROZEN_OCEAN, WARM_OCEAN, LUKEWARM_OCEAN, COLD_OCEAN, ...DEEP_OCEANS]);

export const isDeepOcean = (id) => DEEP_OCEANS.has(id);
export const isOceanic = (id) => OCEANS.has(id);

// isOverworld() de biomes.c para 1.18+: `mc` es el orden de versiones de versions.js
export function isOverworld(mc, id) {
  if (!BIOME_KEYS.has(id) || NETHER_IDS.has(id) || END_IDS.has(id)) return false;
  if (id === PALE_GARDEN) return mc >= MC_1_21_WD;
  if (id === CHERRY_GROVE) return mc >= MC_1_20;
  if (id === DEEP_DARK || id === MANGROVE_SWAMP) return mc >= MC_1_19_2;
  return true;
}
