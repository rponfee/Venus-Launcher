'use strict';
// "Como X": pedidos que se apoyan en otro proyecto o juego conocido ("algo como Sodium", "alternativa a OptiFine",
// "parecido a Hypixel", "mods tipo Create"). El pedido se lee asi: una MARCA ("como", "parecido a", "alternativa a",
// "like", "similar to"...) seguida del nombre de un proyecto de PROJECTS. Cada proyecto conocido aporta los temas
// que le corresponden (ids de THEMES) y el nombre con el que se lo busca en Modrinth.
//
//   id      identificador estable del proyecto
//   name    nombre para buscarlo en Modrinth (se agrega a los terminos del plan)
//   p       alternativas de expresion regular del nombre (texto normalizado)
//   themes  ids de temas que representa (deben existir en lexicon.js o en vocab/themes.js)
//   types   tipos que conviene incluir (opcional)
//   loader  cargador al que pertenece (opcional)
//   flags   { lowEnd, highEnd } (opcional)
// Para agregar un proyecto, una entrada nueva. test/vocab.test.js comprueba que los temas existan.

const MARKERS = [
  'como', 'tipo', 'parecid[oa]s? (?:a|al|a la|a los)', 'similar(?:es)? (?:a|al|a la)', 'semejante(?:s)? (?:a|al)', 'alternativas?(?: [a-z]+){0,2} (?:a|al|a la|de|del|para)', 'reemplazos? (?:de|del|para)', 'sustitutos? (?:de|del)',
  'en vez de', 'en lugar de', 'igual que', 'al estilo de', 'estilo', 'inspirad[oa]s? en', 'basad[oa]s? en', 'que (?:se )?(?:parezca|parezcan) a', 'que sea (?:como|parecido a)', 'algo asi como', 'cosas como',
  'like', 'similar to', '(?:lightweight |light |lite |better |free |modern |good |best )?alternatives? (?:to|for)', 'replacement for', 'instead of', 'in the style of', 'inspired by', 'something like', 'stuff like', 'a la', 'kind of like', 'sort of like', 'based on',
  'parecido com', 'semelhante a', 'alternativas?(?: [a-z]+){0,2} (?:a|ao|para)', 'no estilo de', 'igual ao', 'algo como', 'coisas como', 'em vez de',
];

const PROJECTS = [
  // rendimiento y motores
  { id: 'sodium', name: 'Sodium', p: ['sodium', 'sodio'], themes: ['fps'], types: ['mod'], loader: 'fabric', flags: { lowEnd: true } },
  { id: 'lithium', name: 'Lithium', p: ['lithium', 'litio'], themes: ['fps'], types: ['mod'], loader: 'fabric' },
  { id: 'optifine', name: 'OptiFine', p: ['optifine', 'opti fine'], themes: ['fps', 'realistic'], types: ['mod', 'shader'], flags: { lowEnd: true } },
  { id: 'iris', name: 'Iris Shaders', p: ['iris', 'iris shaders'], themes: ['realistic'], types: ['shader'], loader: 'fabric' },
  { id: 'embeddium', name: 'Embeddium', p: ['embeddium', 'rubidium'], themes: ['fps'], types: ['mod'], loader: 'forge' },
  { id: 'ferrite', name: 'FerriteCore', p: ['ferrite ?core'], themes: ['fps'], types: ['mod'] },
  { id: 'entityculling', name: 'Entity Culling', p: ['entity culling'], themes: ['fps'], types: ['mod'] },
  { id: 'fabulously', name: 'Fabulously Optimized', p: ['fabulously optimi[sz]ed', 'fabulous optimized'], themes: ['fps'], types: ['modpack'], loader: 'fabric' },
  // utilidad
  { id: 'jei', name: 'Just Enough Items', p: ['jei', 'just enough items', 'rei', 'emi', 'roughly enough items'], themes: ['recipes'], types: ['mod'] },
  { id: 'xaero', name: "Xaero's Minimap", p: ['xaero(?:s)?(?: minimap)?', 'journey ?map', 'voxel ?map'], themes: ['minimap'], types: ['mod'] },
  { id: 'worldedit', name: 'WorldEdit', p: ['world ?edit', 'fawe', 'fast async world ?edit'], themes: ['building'], types: ['mod', 'plugin'] },
  { id: 'litematica', name: 'Litematica', p: ['litematica', 'schematica'], themes: ['technical', 'building'], types: ['mod'] },
  { id: 'replay', name: 'Replay Mod', p: ['replay ?mod', 'flashback'], themes: ['recording'], types: ['mod'] },
  { id: 'jade', name: 'Jade', p: ['jade', 'waila', 'hwyla', 'the one probe'], themes: ['hud'], types: ['mod'] },
  { id: 'voicechat', name: 'Simple Voice Chat', p: ['simple voice chat', 'plasmo voice', 'voice ?chat'], themes: ['voicechat'], types: ['mod'] },
  { id: 'essentialsx', name: 'EssentialsX', p: ['essentials ?x?', 'cmi'], themes: ['servermgmt'], types: ['plugin'] },
  { id: 'luckperms', name: 'LuckPerms', p: ['luck ?perms'], themes: ['servermgmt'], types: ['plugin'] },
  // tecnologia y magia
  { id: 'create', name: 'Create', p: ['create', 'create mod'], themes: ['technology', 'technical'], types: ['mod', 'modpack'] },
  { id: 'mekanism', name: 'Mekanism', p: ['mekanism', 'thermal(?: expansion)?', 'immersive engineering', 'industrial ?craft', 'build ?craft'], themes: ['technology'], types: ['mod'] },
  { id: 'ae2', name: 'Applied Energistics 2', p: ['ae2', 'applied energistics(?: 2)?', 'refined storage', 'sophisticated storage'], themes: ['technology', 'storage'], types: ['mod'] },
  { id: 'botania', name: 'Botania', p: ['botania', 'thaumcraft', 'blood magic', 'ars nouveau', 'ars nouveau', 'thaumic'], themes: ['magic'], types: ['mod'] },
  { id: 'tinkers', name: "Tinkers' Construct", p: ['tinkers?(?: construct)?', 'tconstruct'], themes: ['weapons', 'ores'], types: ['mod'] },
  { id: 'iceandfire', name: 'Ice and Fire', p: ['ice (?:and|y|e|&) fire', 'dragon mounts', 'how to train your dragon'], themes: ['dragons', 'fantasy'], types: ['mod'] },
  { id: 'twilight', name: 'The Twilight Forest', p: ['twilight forest', 'the twilight forest'], themes: ['exploration', 'nether'], types: ['mod'] },
  { id: 'alexmobs', name: "Alex's Mobs", p: ['alex(?:s)? mobs', 'mowzie(?:s)? mobs', 'mobs? nuevos'], themes: ['animals', 'monsters'], types: ['mod'] },
  { id: 'terralith', name: 'Terralith', p: ['terralith', 'biomes? o plenty', 'biomes? you ?ll go', 'william wythers', 'regions unexplored', 'bop'], themes: ['worldgen'], types: ['mod', 'datapack'] },
  { id: 'farmersdelight', name: "Farmer's Delight", p: ['farmer(?:s)? delight', 'pam(?:s)? harvestcraft', 'harvestcraft', 'cooking for blockheads'], themes: ['farming'], types: ['mod'] },
  { id: 'cobblemon', name: 'Cobblemon', p: ['cobblemon', 'pixelmon', 'pokemones'], themes: ['pokemon'], types: ['mod', 'modpack'] },
  { id: 'quark', name: 'Quark', p: ['quark', 'supplementaries', 'vanilla tweaks', 'vanilla tweaks'], themes: ['vanillaplus'], types: ['mod', 'datapack'] },
  { id: 'luckyblock', name: 'Lucky Block', p: ['lucky ?blocks?'], themes: ['luckyblock'], types: ['mod', 'datapack'] },
  { id: 'waystones', name: 'Waystones', p: ['waystones?', 'ftb teleporters'], themes: ['exploration'], types: ['mod'] },
  { id: 'backpacks', name: 'Sophisticated Backpacks', p: ['sophisticated backpacks?', 'traveler(?:s)? backpacks?'], themes: ['storage'], types: ['mod'] },
  // shaders y packs de recursos
  { id: 'bsl', name: 'BSL Shaders', p: ['bsl', 'bsl shaders?'], themes: ['realistic', 'cartoon'], types: ['shader'] },
  { id: 'complementary', name: 'Complementary Shaders', p: ['complementary(?: shaders?)?', 'complementary reimagined', 'complementary unbound'], themes: ['realistic'], types: ['shader'] },
  { id: 'seus', name: 'SEUS', p: ['seus(?: renewed| ptgi)?', 'sildurs?(?: vibrant)?', 'kappa', 'continuum', 'photon(?: shaders?)?', 'solas', 'euphoria patches', 'rethinking voxels', 'miniature shaders?'], themes: ['realistic'], types: ['shader'] },
  { id: 'faithful', name: 'Faithful', p: ['faithful', 'faithful 32x', 'faithful 64x'], themes: ['vanillaplus', 'realistic'], types: ['resourcepack'] },
  { id: 'barebones', name: 'Bare Bones', p: ['bare bones', 'barebones'], themes: ['minimalist'], types: ['resourcepack'] },
  { id: 'dokucraft', name: 'Dokucraft', p: ['dokucraft', 'sphax', 'john smith legacy', 'jolicraft', 'conquest', 'soartex', 'stay true'], themes: ['medieval', 'fantasy'], types: ['resourcepack'] },
  { id: 'freshanimations', name: 'Fresh Animations', p: ['fresh animations?', 'better leaves', 'default 3d', '3d default'], themes: ['models3d', 'immersion'], types: ['resourcepack'] },
  { id: 'programmerart', name: 'Programmer Art', p: ['programmer art', 'texturas? por defecto', 'default textures?', 'old default'], themes: ['retro'], types: ['resourcepack'] },
  // modpacks conocidos
  { id: 'atm', name: 'All the Mods', p: ['all the mods(?: [0-9]+)?', 'atm ?[0-9]*', 'all the mods 9', 'better minecraft', 'prominence(?: ii)?', 'enigmatica(?: [0-9]+)?', 'ftb (?:infinity|evolution|revelation|skies|academy)', 'sky ?factory(?: [0-9]+)?', 'vault hunters', 'create above and beyond', 'regrowth', 'tekkit', 'technic', 'feed the beast', 'ftb'], themes: ['kitchensink'], types: ['modpack'] },
  { id: 'rlcraft', name: 'RLCraft', p: ['rlcraft', 'rl craft', 'dregora', 'hardcore questing', 'tough as nails', 'the hunger games'], themes: ['hardcore', 'survival', 'dragons'], types: ['modpack'] },
  // servidores y juegos
  { id: 'hypixel', name: 'Hypixel', p: ['hypixel', 'mineplex', 'cubecraft', 'the hive', 'mccentral', 'mineville'], themes: ['minigames', 'pvp'], types: ['plugin', 'datapack'], mode: 'server' },
  { id: '2b2t', name: '2b2t', p: ['2b2t', 'anarquia', 'anarchy server'], themes: ['pvp', 'hardcore'], types: ['plugin', 'mod'], mode: 'server' },
  { id: 'terraria', name: 'Terraria', p: ['terraria', 'starbound', 'stardew(?: valley)?'], themes: ['exploration', 'bosses', 'farming'], types: ['mod', 'modpack'] },
  { id: 'skyrim', name: 'Skyrim', p: ['skyrim', 'the elder scrolls', 'elder scrolls', 'oblivion', 'dragon age', 'witcher', 'the witcher', 'lord of the rings', 'lotr', 'el senor de los anillos', 'harry potter', 'hogwarts'], themes: ['fantasy', 'medieval', 'magic'], types: ['mod', 'modpack'] },
  { id: 'zelda', name: 'Zelda', p: ['zelda', 'breath of the wild', 'botw', 'tears of the kingdom', 'totk', 'hyrule'], themes: ['exploration', 'fantasy'], types: ['mod', 'shader'] },
  { id: 'ark', name: 'Ark', p: ['ark', 'ark survival', 'rust', 'dayz', 'the forest', 'valheim', 'conan exiles', '7 days to die', 'project zomboid'], themes: ['survival', 'hardcore'], types: ['mod', 'modpack'] },
  { id: 'fortnite', name: 'Fortnite', p: ['fortnite', 'pubg', 'warzone', 'battle royale', 'apex'], themes: ['minigames', 'pvp', 'guns'], types: ['plugin', 'datapack'], mode: 'server' },
  { id: 'gta', name: 'GTA', p: ['gta', 'grand theft auto', 'gta ?5', 'gta ?v', 'saints row', 'cyberpunk 2077'], themes: ['modern', 'vehicles', 'guns'], types: ['mod', 'modpack'] },
  { id: 'cod', name: 'Call of Duty', p: ['call of duty', 'cod', 'counter strike', 'cs ?go', 'cs ?2', 'battlefield', 'valorant', 'rainbow six', 'siege'], themes: ['guns', 'pvp'], types: ['mod', 'resourcepack'] },
  { id: 'pokemonlike', name: 'Pixelmon', p: ['pokemon go', 'pokemon legends'], themes: ['pokemon'], types: ['mod'] },
  { id: 'rpgs', name: 'RPG', p: ['diablo', 'path of exile', 'world of warcraft', 'wow', 'final fantasy', 'dark souls', 'elden ring', 'monster hunter', 'dungeons (?:and|y|e|&) dragons', 'dnd'], themes: ['fantasy', 'progression', 'bosses'], types: ['mod', 'modpack'] },
  { id: 'animalcrossing', name: 'Animal Crossing', p: ['animal crossing', 'the sims', 'cozy grove', 'stardew'], themes: ['cozy', 'farming'], types: ['mod', 'resourcepack'] },
  { id: 'factorio', name: 'Factorio', p: ['factorio', 'satisfactory', 'dyson sphere', 'oxygen not included', 'techtonica'], themes: ['technology'], types: ['mod', 'modpack'] },
  { id: 'subnautica', name: 'Subnautica', p: ['subnautica', 'abzu', 'endless ocean'], themes: ['water', 'exploration'], types: ['mod', 'shader'] },
  { id: 'nomanssky', name: "No Man's Sky", p: ['no man(?:s)? sky', 'kerbal(?: space program)?', 'ksp', 'star ?citizen', 'starfield', 'mass effect'], themes: ['space'], types: ['mod', 'modpack'] },
  { id: 'resident', name: 'Resident Evil', p: ['resident evil', 'silent hill', 'amnesia', 'outlast', 'phasmophobia', 'dead space', 'alien isolation', 'the last of us', 'left 4 dead', 'dying light', 'state of decay'], themes: ['horror', 'zombies'], types: ['mod', 'shader'] },
];

module.exports = { MARKERS, PROJECTS };
