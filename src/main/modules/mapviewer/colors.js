'use strict';
// Colores del mapa: color promedio de la cara de arriba de cada bloque, tintes por bioma y reglas
// para los bloques que no estan en la tabla (variantes, losas, escaleras, bloques de mods...).
// resolveBlock(nombre, props) -> { k: tipo, c: 0xRRGGBB, t: tinte, m: multiplicador del tinte, a: opacidad }
// resolveBiome(nombre)        -> { grass, foliage, water } (0xRRGGBB)

// Tipos de bloque para el renderizador
const KIND = { SOLID: 0, CLEAR: 1, WATER: 2, OVERLAY: 3, LAVA: 4 };
// Tintes que dependen del bioma
const TINT = { NONE: 0, GRASS: 1, FOLIAGE: 2, WATER: 3 };

// Las texturas con tinte son grises: el color final es el tinte del bioma por este factor
const GRASS_SHADE = 0.8;
const FOLIAGE_SHADE = 0.66;
const WATER_SHADE = 0.86;

const hex = (s) => parseInt(s, 16);
function pairs(text) {
  const out = new Map();
  const parts = text.trim().split(/\s+/);
  for (let i = 0; i + 1 < parts.length; i += 2) out.set(parts[i], hex(parts[i + 1]));
  return out;
}

// ---------- Bloques solidos (color de la cara de arriba) ----------
const SOLID = pairs(`
stone 7e7e7e granite 9a6b58 polished_granite 9b6b59 diorite bebebf polished_diorite c0c0c1 andesite 888889
polished_andesite 858786 deepslate 555557 cobbled_deepslate 4d4d51 polished_deepslate 494949 deepslate_bricks 474747
cracked_deepslate_bricks 434343 deepslate_tiles 363637 cracked_deepslate_tiles 343434 chiseled_deepslate 373737
reinforced_deepslate 525756 calcite dfe0dd tuff 6c6d67 polished_tuff 626866 tuff_bricks 63675f chiseled_tuff 5a5e58
chiseled_tuff_bricks 666a62 dripstone_block 876c5d dirt 876145 coarse_dirt 785739 rooted_dirt 916a4e podzol 5c3f19
mycelium 6f6266 dirt_path 937a40 grass_path 937a40 farmland 6f4a2a mud 3d3a3e packed_mud 8f6c51 mud_bricks 8a6a50
muddy_mangrove_roots 453b2e mangrove_roots 4c3d2a clay a1a7b4 gravel 847f7f suspicious_gravel 847f7f sand dbd0a3
suspicious_sand dbd0a3 red_sand bf6721 sandstone e0d6aa chiseled_sandstone d8ca9c cut_sandstone d9ce9f
smooth_sandstone e0d6aa red_sandstone b5621f cut_red_sandstone bd6521 chiseled_red_sandstone b7601e
smooth_red_sandstone b5621f snow f9fefe snow_block f9fefe powder_snow f8fdfd ice 92b8fe packed_ice 8db4fa
blue_ice 74a8fd frosted_ice 8cb2f5 bedrock 565656 obsidian 100c1c crying_obsidian 210a3c moss_block 596e2d
moss_carpet 596e2d pale_moss_block 6b7266 pale_moss_carpet 6b7266 sculk 0d1e25 sculk_catalyst 0f2023
sculk_shrieker 7e8873 sculk_sensor 0b4b57 calibrated_sculk_sensor 0b4b57 amethyst_block 8662bf
budding_amethyst 8460ba smooth_basalt 48484e basalt 515157 polished_basalt 646466 magma_block 8f3f20
netherrack 622626 nether_bricks 2d161a cracked_nether_bricks 281416 chiseled_nether_bricks 2f171b
red_nether_bricks 460709 nether_wart_block 730303 warped_wart_block 177879 crimson_nylium 831f1f
warped_nylium 2b7265 soul_sand 513e33 soul_soil 4c3a2f blackstone 2a2329 gilded_blackstone 382b26
polished_blackstone 353038 polished_blackstone_bricks 302a31 cracked_polished_blackstone_bricks 2c252b
chiseled_polished_blackstone 35303a glowstone ab8654 shroomlight f09347 nether_gold_ore 73362a
nether_quartz_ore 76413c ancient_debris 5e4239 end_stone dbde9e end_stone_bricks dae0a2 purpur_block aa7eaa
purpur_pillar ab80ab chorus_plant 5e395e chorus_flower 977897 end_portal_frame 5b7961 end_portal 0f0f1a
end_gateway 0f0f1a dragon_egg 0c0910 coal_ore 6a6a6a iron_ore 8c837c copper_ore 7c7d72 gold_ore 8f8b7c
redstone_ore 856869 emerald_ore 6d8873 lapis_ore 6b7594 diamond_ore 7c8e8d deepslate_coal_ore 4a4a4c
deepslate_iron_ore 6a645f deepslate_copper_ore 5c5d58 deepslate_gold_ore 73694f deepslate_redstone_ore 69494a
deepslate_emerald_ore 4e6857 deepslate_lapis_ore 4f5a75 deepslate_diamond_ore 536a6a raw_iron_block a6876b
raw_copper_block 9a6a4f raw_gold_block dda92e iron_block dcdcdc gold_block f6d03e diamond_block 62ede4
emerald_block 2acb58 lapis_block 1f438c redstone_block af1806 coal_block 101010 netherite_block 433d40
copper_block c06c50 exposed_copper a17e68 weathered_copper 6d9270 oxidized_copper 52a385 cut_copper bf6b51
exposed_cut_copper 9a7965 weathered_cut_copper 6d9170 oxidized_cut_copper 4f9a84 chiseled_copper b8644c
exposed_chiseled_copper 9a7663 weathered_chiseled_copper 68916e oxidized_chiseled_copper 54a288
copper_grate c06c50 exposed_copper_grate a17e68 weathered_copper_grate 6d9270 oxidized_copper_grate 52a385
copper_bulb 9c5739 exposed_copper_bulb 876a57 weathered_copper_bulb 5d7c5e oxidized_copper_bulb 478a71
quartz_block ece6df chiseled_quartz_block e7e2da quartz_pillar ece6df quartz_bricks eae5de smooth_quartz ece6df
bricks 976253 stone_bricks 7a7a7a mossy_stone_bricks 737969 cracked_stone_bricks 777676
chiseled_stone_bricks 777777 cobblestone 7f7f7f mossy_cobblestone 6e775f smooth_stone 9f9f9f
prismarine 63a296 prismarine_bricks 63ac9e dark_prismarine 335b4b sea_lantern acc8be sponge c4c04b
wet_sponge aaab3d hay_block a88e14 bone_block d1ceb8 dried_kelp_block 323b26 honey_block fbb92d
honeycomb_block e5941e slime_block 6fc05b target e2aa9e bookshelf a2834f chiseled_bookshelf 9a7a4b
crafting_table 81613a furnace 6e6e6e blast_furnace 6c6b6a smoker 6b5f55 chest a26f2c trapped_chest a26f2c
ender_chest 0f1617 barrel 8d693b composter 774c27 lectern 9f7f4f loom 8d7558 smithing_table 3a3a45
cartography_table 685239 fletching_table c5b786 grindstone 8e8e8e stonecutter 7b7671 anvil 444444
chipped_anvil 444444 damaged_anvil 444444 cauldron 4a4a4a water_cauldron 3f5fa8 lava_cauldron b0501c
powder_snow_cauldron d8dddd hopper 4b4b4b jukebox 5e4031 note_block 5a3c2a tnt b04a35 beacon 75ddd7
conduit a08b6d respawn_anchor 2a1a47 lodestone 939495 spawner 24384b redstone_lamp 5f3720 observer 626262
piston 9a825a piston_head 9a825a sticky_piston 6d9a55 dispenser 6c6c6c dropper 6c6c6c daylight_detector 83755c
crafter 6d6a68 trial_spawner 2e4049 vault 3c4a52 heavy_core 5b5f66 decorated_pot 8f4f38 beehive b49251
bee_nest c8a04a tinted_glass 2c2630 enchanting_table 7a2b33 cake e6cfc1 red_mushroom_block c62e2c
brown_mushroom_block 957055 mushroom_stem cbc4b9 pumpkin c67618 carved_pumpkin c67618 jack_o_lantern c67618
melon 72921e cactus 6b8e3d bamboo_block 7e9b37 stripped_bamboo_block c4b157 bamboo_mosaic beaa4e
command_block b1846a repeating_command_block 7a6aa8 chain_command_block 85a397 structure_block 5a4a5a
jigsaw 4a3b4a tube_coral_block 3157ce brain_coral_block cf5b9f bubble_coral_block a118a0 fire_coral_block a3232e
horn_coral_block d8c842 dead_tube_coral_block 82786f dead_brain_coral_block 7c756f dead_bubble_coral_block 847d75
dead_fire_coral_block 857d76 dead_horn_coral_block 857e77 ochre_froglight f6eac1 verdant_froglight e5f3e0
pearlescent_froglight f2e5ef campfire 6e5235 soul_campfire 4a5a5a azalea 657d2e flowering_azalea 7a7e4e
big_dripleaf 6f9532 resin_block dc6b2c resin_bricks d9682a chiseled_resin_bricks d26428 creaking_heart 5a4f4d
light_weighted_pressure_plate f6d03e heavy_weighted_pressure_plate dcdcdc iron_trapdoor c4c4c4
shulker_box 8b5f8b
`);

// ---------- Plantas y objetos chicos: se ven mezclados con el bloque de abajo ----------
// nombre: [color, opacidad]
const OVERLAY = new Map(
  Object.entries({
    dead_bush: ['6b4f28', 0.4], short_dry_grass: ['c9a564', 0.4], tall_dry_grass: ['c9a564', 0.45], leaf_litter: ['7a5e3a', 0.55],
    firefly_bush: ['4f6e2e', 0.6], cactus_flower: ['d06e8e', 0.6], dandelion: ['e8d43a', 0.45], poppy: ['c22c22', 0.45],
    blue_orchid: ['2aa8e0', 0.45], allium: ['b57ee0', 0.45], azure_bluet: ['e3e8ef', 0.45], red_tulip: ['c8331d', 0.45],
    orange_tulip: ['e2732b', 0.45], white_tulip: ['e0e7e4', 0.45], pink_tulip: ['e8a2c9', 0.45], oxeye_daisy: ['e6e8da', 0.45],
    cornflower: ['4f6fdb', 0.45], lily_of_the_valley: ['e8e8e8', 0.45], wither_rose: ['2b2b20', 0.45], torchflower: ['e09b2e', 0.45],
    open_eyeblossom: ['e88a2a', 0.45], closed_eyeblossom: ['6b6e6a', 0.45], sunflower: ['f2c531', 0.55], lilac: ['c79acf', 0.5],
    rose_bush: ['b0352a', 0.5], peony: ['e2b9df', 0.5], pitcher_plant: ['6c86c8', 0.5], pink_petals: ['f0a7cc', 0.6],
    wildflowers: ['f2d45a', 0.55], spore_blossom: ['d86fa8', 0.4], cherry_sapling: ['d79db8', 0.4], mangrove_propagule: ['6a8a2e', 0.4],
    red_mushroom: ['d23b33', 0.5], brown_mushroom: ['957055', 0.5], crimson_fungus: ['a12a2a', 0.5], warped_fungus: ['2a8a7f', 0.5],
    crimson_roots: ['7e0812', 0.45], warped_roots: ['14968a', 0.45], nether_sprouts: ['13977f', 0.4], weeping_vines: ['7b0003', 0.5],
    weeping_vines_plant: ['7b0003', 0.5], twisting_vines: ['148f7c', 0.5], twisting_vines_plant: ['148f7c', 0.5],
    wheat: ['a5a23e', 0.75], carrots: ['4f9b2b', 0.7], potatoes: ['4d9a31', 0.7], beetroots: ['5e8c2e', 0.7],
    melon_stem: ['6b8a2f', 0.4], pumpkin_stem: ['6b8a2f', 0.4], attached_melon_stem: ['6b8a2f', 0.4], attached_pumpkin_stem: ['6b8a2f', 0.4],
    torchflower_crop: ['5e8c2e', 0.5], pitcher_crop: ['5f7e9a', 0.5], nether_wart: ['7a0e12', 0.7], cocoa: ['8d5a2a', 0.6],
    sweet_berry_bush: ['3e6c3e', 0.6], bamboo: ['5d8e2f', 0.85], bamboo_sapling: ['5d8e2f', 0.4], glow_lichen: ['7a8a7e', 0.4],
    cave_vines: ['4f6e2e', 0.4], cave_vines_plant: ['4f6e2e', 0.4], hanging_roots: ['9a7058', 0.3], pale_hanging_moss: ['7b8274', 0.4],
    small_dripleaf: ['5e8d2c', 0.6], pointed_dripstone: ['816557', 0.6], amethyst_cluster: ['a27ecf', 0.5],
    large_amethyst_bud: ['a27ecf', 0.45], medium_amethyst_bud: ['a27ecf', 0.4], small_amethyst_bud: ['a27ecf', 0.35],
    sculk_vein: ['0b2e33', 0.5], cobweb: ['dddddd', 0.35], iron_bars: ['8c8d8b', 0.4], brewing_stand: ['7a6a5a', 0.5],
    scaffolding: ['aa8449', 0.7], lantern: ['6b5c3f', 0.5], soul_lantern: ['4d6b6d', 0.5], rail: ['7e6a4e', 0.65],
    powered_rail: ['9a7a3e', 0.65], detector_rail: ['7d6a5a', 0.65], activator_rail: ['7a5e52', 0.65], redstone_wire: ['a01010', 0.45],
    repeater: ['a29d99', 0.85], comparator: ['a29d99', 0.85], flower_pot: ['7c4535', 0.4], fire: ['e0a03a', 0.55],
    soul_fire: ['4bd8dc', 0.55], sea_pickle: ['5a6123', 0.5], turtle_egg: ['e3e0c5', 0.5], sniffer_egg: ['8d4f3f', 0.6],
    frogspawn: ['6b5f5a', 0.3], bell: ['d2a82e', 0.6], lily_pad: ['2b7a2a', 0.85], end_rod: ['e0d8cc', 0.25],
    tube_coral: ['3154ca', 0.6], brain_coral: ['c65597', 0.6], bubble_coral: ['a018a0', 0.6], fire_coral: ['a7262f', 0.6],
    horn_coral: ['d1ba3f', 0.6], dead_tube_coral: ['857e77', 0.5], dead_brain_coral: ['857e77', 0.5], dead_bubble_coral: ['857e77', 0.5],
    dead_fire_coral: ['857e77', 0.5], dead_horn_coral: ['857e77', 0.5], tube_coral_fan: ['3154ca', 0.6], brain_coral_fan: ['c65597', 0.6],
    bubble_coral_fan: ['a018a0', 0.6], fire_coral_fan: ['a7262f', 0.6], horn_coral_fan: ['d1ba3f', 0.6],
    dead_tube_coral_fan: ['857e77', 0.5], dead_brain_coral_fan: ['857e77', 0.5], dead_bubble_coral_fan: ['857e77', 0.5],
    dead_fire_coral_fan: ['857e77', 0.5], dead_horn_coral_fan: ['857e77', 0.5], nether_portal: ['5a0fbe', 0.65],
    oak_sapling: ['4f7a2a', 0.4], spruce_sapling: ['3d5a32', 0.4], birch_sapling: ['6b8a3a', 0.4], jungle_sapling: ['3f7a22', 0.4],
    acacia_sapling: ['6b7a2a', 0.4], dark_oak_sapling: ['3d5a22', 0.4], pale_oak_sapling: ['8a9080', 0.4],
  }).map(([k, [c, a]]) => [k, { c: hex(c), a }]),
);

// Plantas con el tinte del pasto o del follaje: nombre -> [tinte, multiplicador, opacidad]
const TINTED_OVERLAY = new Map(
  Object.entries({
    grass: [TINT.GRASS, 0.92, 0.38], short_grass: [TINT.GRASS, 0.92, 0.38], fern: [TINT.GRASS, 0.85, 0.38],
    tall_grass: [TINT.GRASS, 0.92, 0.45], large_fern: [TINT.GRASS, 0.85, 0.45], bush: [TINT.GRASS, 0.85, 0.6],
    sugar_cane: [TINT.GRASS, 0.85, 0.75], vine: [TINT.FOLIAGE, 0.7, 0.55],
  }),
);

// No se ven desde arriba: se mira el bloque de abajo
const CLEAR = new Set(
  `air cave_air void_air light barrier structure_void moving_piston glass glass_pane torch wall_torch soul_torch
  soul_wall_torch redstone_torch redstone_wall_torch copper_torch copper_wall_torch lever tripwire tripwire_hook string ladder chain
  iron_chain copper_chain lightning_rod big_dripleaf_stem candle skeleton_skull skeleton_wall_skull
  wither_skeleton_skull wither_skeleton_wall_skull zombie_head zombie_wall_head player_head player_wall_head creeper_head
  creeper_wall_head dragon_head dragon_wall_head piglin_head piglin_wall_head`.split(/\s+/),
);

// Fluidos
const WATER = new Set(['water', 'flowing_water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass']);
const LAVA = new Set(['lava', 'flowing_lava']);
const LAVA_COLOR = hex('d45a12');

// ---------- Maderas ----------
const PLANKS = {
  oak: 'a2834f', spruce: '735532', birch: 'c0af79', jungle: 'a07351', acacia: 'a85a32', dark_oak: '432b14', mangrove: '763631',
  cherry: 'e2b3ac', pale_oak: 'ddd3cc', bamboo: 'c1ad50', crimson: '653147', warped: '2b6963',
};
// [arriba (anillos), costado (corteza)]
const LOGS = {
  oak: ['9a7b4a', '6d5534'], spruce: ['6c5030', '3b2615'], birch: ['c1b37d', 'd8d7d2'], jungle: ['98724a', '56451b'],
  acacia: ['96593a', '686158'], dark_oak: ['4a3920', '3c2f1a'], mangrove: ['6f302a', '55442b'], cherry: ['b98d88', '36202c'],
  pale_oak: ['cdc3be', '57504e'], crimson: ['6b2942', '5c1a1e'], warped: ['3a6b63', '3a3a4d'],
};
const STRIPPED = {
  oak: 'b19056', spruce: '745a35', birch: 'c4b07a', jungle: 'ab8454', acacia: 'af5c3b', dark_oak: '61452a', mangrove: '773633',
  cherry: 'd7919a', pale_oak: 'f2ebe8', crimson: '8a3a5a', warped: '3a9792', bamboo: 'c4b157',
};
// Hojas: 'F' = tinte del follaje del bioma; '#rrggbb' = color propio (sin tinte); 'rrggbb' = tinte fijo
const LEAVES = {
  oak: 'F', jungle: 'F', acacia: 'F', dark_oak: 'F', mangrove: 'F', spruce: '619961', birch: '80a755',
  cherry: '#e5adc2', azalea: '#5a7429', flowering_azalea: '#6c7849', pale_oak: '#8d928a',
};
for (const [w, c] of Object.entries(PLANKS)) SOLID.set(`${w}_planks`, hex(c));

// ---------- Bloques de colores (16 tintes) ----------
const DYES = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const DYE_FAMILIES = {
  wool: 'e9ecec f07613 bd44b3 3aafd9 f8c527 70b919 ed8dac 3e4447 8e8e86 158991 792aac 35399d 724728 546d1b a02722 141519',
  concrete: 'cfd5d6 e06100 a9309f 2389c6 f0af15 5ea818 d5658e 36393d 7d7d73 157788 64209c 2c2e8f 603b1f 495b24 8e2020 080a0f',
  concrete_powder: 'e1e3e3 e3831f c053b8 4ab4d5 e8c736 7dbd29 e499b5 4c5154 9a9a94 24939d 8337b1 4649a6 7d5435 61772c a83632 191a1f',
  terracotta: 'd1b2a1 a15325 95576c 706c8a ba8523 677534 a04d4e 392a23 876b62 575b5b 764656 4a3b5b 4d3323 4c532a 8f3d2e 251610',
  glazed_terracotta: 'bcd4ca 9a935b d064bf 5ea4d0 eac058 a2c537 eb9ab5 535a5d 90a6a7 34777d 6d3098 2f408b 776a55 758e43 b53b35 431e20',
  shulker_box: 'd7dcdd ea6a08 ad36a2 31a3d4 f8bd1c 63ac17 e57a9e 373a3e 7c7c73 147a88 6a2a9e 2c2e8c 6a4224 4f6520 8c1f1e 19191d',
  glass: 'ffffff d87f33 b24cd8 6699d8 e5e533 7fcc19 f27fa5 4c4c4c 999999 4c7f99 7f3fb2 334cb2 664c33 667f33 993333 191919',
};
const DYE_COLORS = {};
for (const [family, list] of Object.entries(DYE_FAMILIES)) {
  const values = list.split(' ').map(hex);
  DYE_COLORS[family] = Object.fromEntries(DYES.map((d, i) => [d, values[i]]));
}
SOLID.set('terracotta', hex('985e43'));
for (const d of DYES) {
  SOLID.set(`${d}_wool`, DYE_COLORS.wool[d]);
  SOLID.set(`${d}_carpet`, DYE_COLORS.wool[d]);
  SOLID.set(`${d}_bed`, DYE_COLORS.wool[d]);
  SOLID.set(`${d}_concrete`, DYE_COLORS.concrete[d]);
  SOLID.set(`${d}_concrete_powder`, DYE_COLORS.concrete_powder[d]);
  SOLID.set(`${d}_terracotta`, DYE_COLORS.terracotta[d]);
  SOLID.set(`${d}_glazed_terracotta`, DYE_COLORS.glazed_terracotta[d]);
  SOLID.set(`${d}_shulker_box`, DYE_COLORS.shulker_box[d]);
  OVERLAY.set(`${d}_stained_glass`, { c: DYE_COLORS.glass[d], a: 0.55 });
  OVERLAY.set(`${d}_stained_glass_pane`, { c: DYE_COLORS.glass[d], a: 0.35 });
}

// ---------- Biomas ----------
// nombre -> [pasto, follaje, agua]
const BIOMES = {};
function biome(names, grass, foliage, water = '3f76e4') {
  for (const n of names.split(' ')) BIOMES[n] = { grass: hex(grass), foliage: hex(foliage), water: hex(water) };
}
biome('plains sunflower_plains beach dripstone_caves deep_dark', '91bd59', '77ab2f');
biome('snowy_plains ice_spikes grove snowy_slopes frozen_peaks jagged_peaks', '80b497', '60a17b');
biome('desert savanna savanna_plateau windswept_savanna', 'bfb755', 'aea42a');
biome('nether_wastes soul_sand_valley crimson_forest warped_forest basalt_deltas', 'bfb755', 'aea42a');
biome('swamp', '6a7039', '6a7039', '617b64');
biome('mangrove_swamp', '6a7039', '8db127', '3a7a6a');
biome('forest flower_forest', '79c05a', '59ae30');
biome('dark_forest', '507a32', '59ae30');
biome('birch_forest old_growth_birch_forest', '88bb67', '6ba941');
biome('old_growth_pine_taiga', '86b87f', '68a55f');
biome('taiga old_growth_spruce_taiga', '86b783', '68a464');
biome('snowy_taiga', '80b497', '60a17b', '3d57d6');
biome('windswept_hills windswept_gravelly_hills windswept_forest stony_shore', '8ab689', '6da36b');
biome('jungle bamboo_jungle', '59c93c', '30bb0b');
biome('sparse_jungle', '64c73f', '3eb80f');
biome('badlands eroded_badlands wooded_badlands', '90814d', '9e814d');
biome('meadow', '83bb6d', '63a948', '0e4ecf');
biome('cherry_grove', 'b6db61', 'b6db61', '5db7ef');
biome('stony_peaks', '9abe4b', '82ac1e');
biome('river ocean deep_ocean lush_caves the_end small_end_islands end_midlands end_highlands end_barrens the_void', '8eb971', '71a74d');
biome('frozen_river frozen_ocean', '80b497', '60a17b', '3938c9');
biome('deep_frozen_ocean', '8eb971', '71a74d', '3938c9');
biome('snowy_beach', '83b593', '64a278', '3d57d6');
biome('warm_ocean', '8eb971', '71a74d', '43d5ee');
biome('lukewarm_ocean deep_lukewarm_ocean', '8eb971', '71a74d', '45adf2');
biome('cold_ocean deep_cold_ocean', '8eb971', '71a74d', '3d57d6');
biome('mushroom_fields', '55c93f', '2bbb0f');
biome('pale_garden', '778272', '878d76', '76889d');

// Nombres de antes de la 1.18 -> nombre actual
const BIOME_ALIASES = {
  mountains: 'windswept_hills', snowy_mountains: 'snowy_plains', mushroom_field_shore: 'mushroom_fields', desert_hills: 'desert',
  wooded_hills: 'forest', taiga_hills: 'taiga', mountain_edge: 'windswept_hills', jungle_hills: 'jungle', jungle_edge: 'sparse_jungle',
  stone_shore: 'stony_shore', birch_forest_hills: 'birch_forest', snowy_taiga_hills: 'snowy_taiga', giant_tree_taiga: 'old_growth_pine_taiga',
  giant_tree_taiga_hills: 'old_growth_pine_taiga', wooded_mountains: 'windswept_forest', wooded_badlands_plateau: 'wooded_badlands',
  badlands_plateau: 'badlands', deep_warm_ocean: 'warm_ocean', desert_lakes: 'desert', gravelly_mountains: 'windswept_gravelly_hills',
  taiga_mountains: 'taiga', swamp_hills: 'swamp', modified_jungle: 'jungle', modified_jungle_edge: 'sparse_jungle',
  tall_birch_forest: 'old_growth_birch_forest', tall_birch_hills: 'old_growth_birch_forest', dark_forest_hills: 'dark_forest',
  snowy_taiga_mountains: 'snowy_taiga', giant_spruce_taiga: 'old_growth_spruce_taiga', giant_spruce_taiga_hills: 'old_growth_spruce_taiga',
  modified_gravelly_mountains: 'windswept_gravelly_hills', shattered_savanna: 'windswept_savanna', shattered_savanna_plateau: 'windswept_savanna',
  modified_wooded_badlands_plateau: 'wooded_badlands', modified_badlands_plateau: 'badlands', bamboo_jungle_hills: 'bamboo_jungle',
  snowy_tundra: 'snowy_plains', nether: 'nether_wastes', sky: 'the_end', ice_mountains: 'snowy_plains', ice_flats: 'snowy_plains',
  extreme_hills: 'windswept_hills', smaller_extreme_hills: 'windswept_hills', roofed_forest: 'dark_forest', mesa: 'badlands',
  mushroom_island: 'mushroom_fields', mushroom_island_shore: 'mushroom_fields', stone_beach: 'stony_shore', cold_beach: 'snowy_beach',
  taiga_cold: 'snowy_taiga', redwood_taiga: 'old_growth_pine_taiga', swampland: 'swamp', hell: 'nether_wastes', void: 'the_void',
};

// Biomas numericos de antes de la 1.18 (Level.Biomes)
const LEGACY_BIOMES = {
  0: 'ocean', 1: 'plains', 2: 'desert', 3: 'mountains', 4: 'forest', 5: 'taiga', 6: 'swamp', 7: 'river', 8: 'nether_wastes', 9: 'the_end',
  10: 'frozen_ocean', 11: 'frozen_river', 12: 'snowy_tundra', 13: 'snowy_mountains', 14: 'mushroom_fields', 15: 'mushroom_field_shore',
  16: 'beach', 17: 'desert_hills', 18: 'wooded_hills', 19: 'taiga_hills', 20: 'mountain_edge', 21: 'jungle', 22: 'jungle_hills',
  23: 'jungle_edge', 24: 'deep_ocean', 25: 'stone_shore', 26: 'snowy_beach', 27: 'birch_forest', 28: 'birch_forest_hills',
  29: 'dark_forest', 30: 'snowy_taiga', 31: 'snowy_taiga_hills', 32: 'giant_tree_taiga', 33: 'giant_tree_taiga_hills',
  34: 'wooded_mountains', 35: 'savanna', 36: 'savanna_plateau', 37: 'badlands', 38: 'wooded_badlands_plateau', 39: 'badlands_plateau',
  40: 'small_end_islands', 41: 'end_midlands', 42: 'end_highlands', 43: 'end_barrens', 44: 'warm_ocean', 45: 'lukewarm_ocean',
  46: 'cold_ocean', 47: 'deep_warm_ocean', 48: 'deep_lukewarm_ocean', 49: 'deep_cold_ocean', 50: 'deep_frozen_ocean', 127: 'the_void',
  129: 'sunflower_plains', 130: 'desert_lakes', 131: 'gravelly_mountains', 132: 'flower_forest', 133: 'taiga_mountains',
  134: 'swamp_hills', 140: 'ice_spikes', 149: 'modified_jungle', 151: 'modified_jungle_edge', 155: 'tall_birch_forest',
  156: 'tall_birch_hills', 157: 'dark_forest_hills', 158: 'snowy_taiga_mountains', 160: 'giant_spruce_taiga',
  161: 'giant_spruce_taiga_hills', 162: 'modified_gravelly_mountains', 163: 'shattered_savanna', 164: 'shattered_savanna_plateau',
  165: 'eroded_badlands', 166: 'modified_wooded_badlands_plateau', 167: 'modified_badlands_plateau', 168: 'bamboo_jungle',
  169: 'bamboo_jungle_hills', 170: 'soul_sand_valley', 171: 'crimson_forest', 172: 'warped_forest', 173: 'basalt_deltas',
  174: 'dripstone_caves', 175: 'lush_caves',
};

// Biomas de mods: se adivina por palabras del nombre
const BIOME_GUESS = [
  [/mangrove/, 'mangrove_swamp'], [/swamp|marsh|bog|bayou|fen|wetland/, 'swamp'], [/cherry|sakura|blossom/, 'cherry_grove'],
  [/jungle|tropic|rainforest/, 'jungle'], [/badland|mesa|canyon/, 'badlands'], [/desert|dune|sand|arid/, 'desert'],
  [/savanna|steppe|shrubland/, 'savanna'], [/frozen|snow|ice|tundra|glacier|arctic|frost|cold/, 'snowy_plains'],
  [/taiga|spruce|pine|conifer|boreal|redwood/, 'taiga'], [/birch|aspen/, 'birch_forest'], [/dark|roofed|shadow/, 'dark_forest'],
  [/deep_ocean|abyss/, 'deep_ocean'], [/ocean|sea|reef/, 'ocean'], [/river|lake|creek/, 'river'], [/beach|shore|coast/, 'beach'],
  [/mushroom|fungal/, 'mushroom_fields'], [/peak|mountain|alp|hill|highland|cliff/, 'windswept_hills'], [/meadow|prairie/, 'meadow'],
  [/forest|wood|grove|orchard/, 'forest'], [/nether|crimson|warped|inferno|hell/, 'nether_wastes'], [/end|void/, 'the_end'],
];

function stripNs(name) {
  const s = String(name || '');
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

// Tintes de un bioma por su nombre (los de mods se adivinan por el nombre)
function resolveBiome(fullName) {
  let name = stripNs(fullName).toLowerCase();
  name = BIOME_ALIASES[name] || name;
  if (BIOMES[name]) return BIOMES[name];
  for (const [re, target] of BIOME_GUESS) if (re.test(name)) return BIOMES[target];
  return BIOMES.plains;
}

function legacyBiomeName(id) {
  return LEGACY_BIOMES[id & 0xff] || 'plains';
}

// ---------- Resolucion de bloques ----------
const SUFFIX_SOLID = ['_slab', '_stairs', '_wall', '_trapdoor', '_pressure_plate'];
const SUFFIX_OVERLAY = { _door: 0.6, _fence: 0.55, _fence_gate: 0.55, _sign: 0.5, _hanging_sign: 0.45 };
const SUFFIX_CLEAR = ['_button', '_wall_sign', '_wall_hanging_sign', '_banner', '_wall_banner', '_candle', '_wall_fan', '_wall_torch', '_torch', '_head', '_skull', '_wall_head', '_wall_skull'];
const MATERIAL_ALIASES = { petrified_oak: 'oak_planks', iron: 'iron_block', copper: 'copper_block', smooth_quartz: 'smooth_quartz', quartz: 'quartz_block', purpur: 'purpur_block', gold: 'gold_block' };

// Busca el material base de una losa/escalera/pared...: "stone_brick" -> "stone_bricks", "oak" -> "oak_planks"
function material(base) {
  if (MATERIAL_ALIASES[base]) return SOLID.get(MATERIAL_ALIASES[base]);
  for (const c of [base, `${base}s`, `${base}_planks`, `${base}_block`, base.replace(/_brick$/, '_bricks'), base.replace(/_tile$/, '_tiles')]) {
    if (SOLID.has(c)) return SOLID.get(c);
  }
  return undefined;
}

const COLOR_WORDS = [
  ['light_blue', DYE_COLORS.wool.light_blue], ['light_gray', DYE_COLORS.wool.light_gray], ['white', DYE_COLORS.wool.white],
  ['orange', DYE_COLORS.wool.orange], ['magenta', DYE_COLORS.wool.magenta], ['yellow', DYE_COLORS.wool.yellow],
  ['lime', DYE_COLORS.wool.lime], ['pink', DYE_COLORS.wool.pink], ['gray', DYE_COLORS.wool.gray], ['cyan', DYE_COLORS.wool.cyan],
  ['purple', DYE_COLORS.wool.purple], ['blue', DYE_COLORS.wool.blue], ['brown', DYE_COLORS.wool.brown], ['green', DYE_COLORS.wool.green],
  ['red', DYE_COLORS.wool.red], ['black', DYE_COLORS.wool.black],
];

// Bloques de mods (o nuevos): se adivina por el nombre
const GUESS = [
  [/glass|window/, null], [/water/, 'W'], [/lava|magma/, 'magma_block'], [/leaves|leaf|foliage|hedge/, 'L'],
  [/grass_block|turf|lawn/, 'G'], [/flower|rose|tulip|orchid|daisy|lily|petal/, 'poppy'], [/sapling|sprout|bush|shrub|grass|fern|plant|weed|crop/, 'P'],
  [/snow/, 'snow_block'], [/ice/, 'ice'], [/sandstone/, 'sandstone'], [/red_sand/, 'red_sand'], [/sand/, 'sand'], [/gravel/, 'gravel'],
  [/clay/, 'clay'], [/mud/, 'mud'], [/dirt|soil|loam|humus/, 'dirt'], [/podzol|mulch/, 'podzol'], [/moss/, 'moss_block'],
  [/planks|plank|board/, 'oak_planks'], [/stripped/, 'stripped_oak_log'], [/log|wood|stem|trunk|bark/, 'oak_log'], [/obsidian/, 'obsidian'],
  [/netherrack|nether/, 'netherrack'], [/end_stone|endstone/, 'end_stone'], [/basalt/, 'basalt'], [/blackstone|black_stone/, 'blackstone'],
  [/deepslate|slate/, 'deepslate'], [/marble|calcite|chalk|limestone/, 'calcite'], [/granite/, 'granite'], [/diorite/, 'diorite'],
  [/andesite/, 'andesite'], [/brick/, 'bricks'], [/cobble/, 'cobblestone'], [/ore/, 'stone'], [/stone|rock|boulder|pebble/, 'stone'],
  [/copper/, 'copper_block'], [/iron|steel|metal|machine|casing/, 'iron_block'], [/gold/, 'gold_block'], [/torch|lamp|lantern|light/, null],
  [/rail|track|pipe|cable|wire|conduit/, 'O'],
];

function hashColor(name) {
  // Color neutro y apagado para bloques desconocidos: se distinguen pero no desentonan
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  const base = 0x7a7066;
  const dr = ((h >>> 0) & 31) - 16;
  const dg = ((h >>> 5) & 31) - 16;
  const db = ((h >>> 10) & 31) - 16;
  const r = Math.max(0, Math.min(255, (base >> 16) + dr));
  const g = Math.max(0, Math.min(255, ((base >> 8) & 255) + dg));
  const b = Math.max(0, Math.min(255, (base & 255) + db));
  return (r << 16) | (g << 8) | b;
}

const solid = (c) => ({ k: KIND.SOLID, c, t: TINT.NONE, m: 1, a: 1 });
const overlay = (c, a) => ({ k: KIND.OVERLAY, c, t: TINT.NONE, m: 1, a });
const clear = () => ({ k: KIND.CLEAR, c: 0, t: TINT.NONE, m: 1, a: 0 });
const tinted = (k, t, m, a = 1) => ({ k, c: 0, t, m, a });

function leaves(kind) {
  const v = LEAVES[kind];
  if (!v || v === 'F') return tinted(KIND.SOLID, TINT.FOLIAGE, FOLIAGE_SHADE);
  if (v.startsWith('#')) return solid(hex(v.slice(1)));
  return solid(scale(hex(v), FOLIAGE_SHADE));
}

function scale(c, f) {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * f));
  const b = Math.min(255, Math.round((c & 255) * f));
  return (r << 16) | (g << 8) | b;
}

// props: { axis, lit, moisture, ... } (valores como texto). Devuelve siempre un objeto valido.
function resolveBlock(fullName, props) {
  const raw = String(fullName || 'minecraft:air');
  const vanilla = !raw.includes(':') || raw.startsWith('minecraft:');
  let name = stripNs(raw).toLowerCase();
  if (name.startsWith('waxed_')) name = name.slice(6);
  if (name.startsWith('infested_')) name = name.slice(9);

  if (CLEAR.has(name)) return clear();
  if (WATER.has(name)) return tinted(KIND.WATER, TINT.WATER, WATER_SHADE);
  if (LAVA.has(name)) return { k: KIND.LAVA, c: LAVA_COLOR, t: TINT.NONE, m: 1, a: 1 };
  if (name === 'grass_block') return tinted(KIND.SOLID, TINT.GRASS, GRASS_SHADE);
  if (TINTED_OVERLAY.has(name)) {
    const [tt, m, a] = TINTED_OVERLAY.get(name);
    return tinted(KIND.OVERLAY, tt, m, a);
  }
  if (name === 'farmland' && props && Number(props.moisture) >= 7) return solid(hex('54301a'));
  if (name === 'redstone_lamp' && props && props.lit === 'true') return solid(hex('a7633a'));
  if (OVERLAY.has(name)) {
    const o = OVERLAY.get(name);
    return overlay(o.c, o.a);
  }

  // Troncos y madera: con el eje horizontal se ve la corteza
  let m = /^(stripped_)?([a-z_]+?)_(log|wood|stem|hyphae)$/.exec(name);
  if (m && LOGS[m[2]]) {
    const w = m[2];
    if (m[1]) return solid(hex(STRIPPED[w] || STRIPPED.oak));
    const side = m[3] === 'wood' || m[3] === 'hyphae' || (props && props.axis && props.axis !== 'y');
    return solid(hex(LOGS[w][side ? 1 : 0]));
  }
  if (name === 'stripped_bamboo_block') return solid(SOLID.get(name));
  m = /^([a-z_]+)_leaves$/.exec(name);
  if (m && (LEAVES[m[1]] || vanilla)) return leaves(m[1]);

  if (SOLID.has(name)) return solid(SOLID.get(name));

  if (name.startsWith('potted_')) return overlay(hex('7c4535'), 0.5);
  if (name.endsWith('_candle_cake')) return solid(SOLID.get('cake'));
  for (const suf of SUFFIX_CLEAR) if (name.endsWith(suf)) return clear();
  if (name.endsWith('_stained_glass_pane') || name.endsWith('_pane')) return clear();
  for (const [suf, a] of Object.entries(SUFFIX_OVERLAY)) {
    if (name.endsWith(suf)) {
      const c = material(name.slice(0, -suf.length));
      if (c !== undefined) return overlay(c, a);
    }
  }
  for (const suf of SUFFIX_SOLID) {
    if (name.endsWith(suf)) {
      const c = material(name.slice(0, -suf.length));
      if (c !== undefined) return solid(c);
    }
  }
  if (name.endsWith('_coral_fan') || name.endsWith('_coral')) return overlay(hex('857e77'), 0.5);
  if (name.endsWith('_ore')) return solid(name.includes('deepslate') ? SOLID.get('deepslate') : name.includes('nether') ? SOLID.get('netherrack') : SOLID.get('stone'));

  return guessBlock(name);
}

function guessBlock(name) {
  for (const [word, color] of COLOR_WORDS) {
    if (name.includes(word) && /wool|concrete|terracotta|carpet|bed|block|tile|brick|plank|glass|clay|stained|dye|colored|painted/.test(name)) {
      return /glass/.test(name) ? overlay(color, 0.5) : solid(color);
    }
  }
  for (const [re, target] of GUESS) {
    if (!re.test(name)) continue;
    if (target === null) return clear();
    if (target === 'W') return tinted(KIND.WATER, TINT.WATER, WATER_SHADE);
    if (target === 'L') return tinted(KIND.SOLID, TINT.FOLIAGE, FOLIAGE_SHADE);
    if (target === 'G') return tinted(KIND.SOLID, TINT.GRASS, GRASS_SHADE);
    if (target === 'P') return tinted(KIND.OVERLAY, TINT.GRASS, 0.85, 0.45);
    if (target === 'O') return overlay(hex('7a7a7a'), 0.6);
    if (target === 'poppy') return overlay(OVERLAY.get('poppy').c, 0.45);
    if (target === 'oak_log') return solid(hex(LOGS.oak[0]));
    if (target === 'stripped_oak_log') return solid(hex(STRIPPED.oak));
    const c = SOLID.get(target);
    if (c !== undefined) return solid(c);
  }
  return solid(hashColor(name));
}

module.exports = { KIND, TINT, resolveBlock, resolveBiome, legacyBiomeName, stripNs, scale, LAVA_COLOR, GRASS_SHADE, FOLIAGE_SHADE, WATER_SHADE };
