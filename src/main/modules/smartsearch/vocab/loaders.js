'use strict';
// Vocabulario de CARGADORES, motores de shaders, software de servidor y "sin mods" (es / en / pt).
// Se suma al de lexicon.js al cargarlo (ver vocab/index.js).

// loader -> alternativas nuevas
const LOADERS = {
  neoforge: ['neo ?forged?', 'neoforge ?mc'],
  forge: ['forja', 'forge ?mc', 'lex ?forge', 'minecraftforge', 'forge ?api', 'forgemod', 'forge ?loader', 'forged'],
  fabric: ['fabrik', 'fabric ?loader', 'fabric ?mods?', 'fabricmc', 'fabrico', 'legacy ?fabric'],
  quilt: ['quilt ?loader', 'quiltmc', 'quilted'],
};

// Motor que hace funcionar los shaders
const SHADER_LOADERS = {
  optifine: ['opti ?fine', 'optifi?ne'],
  iris: ['iris ?mod', 'iris ?loader', 'iris ?shaders ?mod', 'sodium ?extra', 'indium'],
};

// Software de servidor
const SERVER_SOFTWARE = {
  paper: ['paper ?mc', 'papermc', 'paper ?spigot', 'servidor paper'],
  purpur: ['purpurmc', 'servidor purpur'],
  spigot: ['spigotmc', 'servidor spigot'],
  bukkit: ['craft ?bukkit', 'servidor bukkit'],
  folia: ['foliamc'],
};

// "sin mods": jugar al juego puro
const VANILLA = [
  'sin (?:ningun )?(?:mods?|modificaciones|modloader|cargador)', 'minecraft (?:normal|puro|original|base|a secas|limpio)',
  'juego (?:base|puro|original|normal)', 'nada de mods', 'solo (?:el )?vanilla', 'vanilla puro', 'plain minecraft', 'stock minecraft',
  'unmodded', 'non ?modded', 'without (?:any )?(?:mods?|modloader)', 'no mod ?loader', 'pure minecraft', 'just vanilla', 'vanilla only',
  'minecraft limpo', 'sem (?:nenhum )?(?:mods?|modificacoes)', 'sem modloader',
];

module.exports = { LOADERS, SHADER_LOADERS, SERVER_SOFTWARE, VANILLA };
