'use strict';
// Diccionarios del interprete local del Buscador inteligente (funciona sin IA).
// Todos los patrones se aplican sobre texto normalizado: minusculas, sin tildes ni signos
// (ver interpreter.normalize). Cada patron es una alternativa de expresion regular que tiene
// que coincidir con palabras completas.

const TYPES = ['mod', 'modpack', 'resourcepack', 'shader', 'datapack', 'plugin'];

// Categorias validas de Modrinth por tipo (para validar lo que propone la IA y los temas).
const MOD_CATS = ['adventure', 'cursed', 'decoration', 'economy', 'equipment', 'food', 'game-mechanics', 'library', 'magic', 'management', 'minigame', 'mobs', 'optimization', 'social', 'storage', 'technology', 'transportation', 'utility', 'worldgen'];
const CATEGORIES = {
  mod: MOD_CATS,
  plugin: MOD_CATS,
  datapack: MOD_CATS,
  modpack: ['adventure', 'challenging', 'combat', 'kitchen-sink', 'lightweight', 'magic', 'multiplayer', 'optimization', 'quests', 'technology'],
  resourcepack: [
    'combat', 'cursed', 'decoration', 'modded', 'realistic', 'simplistic', 'themed', 'tweaks', 'utility', 'vanilla-like',
    'audio', 'blocks', 'core-shaders', 'entities', 'environment', 'equipment', 'fonts', 'gui', 'items', 'locale', 'models',
    '8x-', '16x', '32x', '48x', '64x', '128x', '256x', '512x+',
  ],
  shader: [
    'cartoon', 'cursed', 'fantasy', 'realistic', 'semi-realistic', 'vanilla-like',
    'atmosphere', 'bloom', 'colored-lighting', 'foliage', 'path-tracing', 'pbr', 'reflections', 'shadows',
    'potato', 'low', 'medium', 'high', 'screenshot',
  ],
};

const MOD_LOADERS = ['fabric', 'forge', 'neoforge', 'quilt'];
const PLUGIN_LOADERS = ['paper', 'spigot', 'bukkit', 'purpur', 'folia'];

// Palabras que indican tipos de contenido. El orden importa: los primeros se "tapan" antes
// de buscar los siguientes (asi "mod pack" no cuenta tambien como "mod").
const TYPE_PATTERNS = [
  ['modpack', ['mod ?packs?', 'paquetes? de mods', 'packs? de mods', 'pacotes? de mods', 'colecciones? de mods', 'modpacks?']],
  ['resourcepack', ['resource ?packs?', 'texture ?packs?', 'texturas?', 'paquetes? de (?:recursos|texturas)', 'packs? de (?:recursos|texturas)', 'pacotes? de (?:recursos|texturas)', 'textures?']],
  ['datapack', ['data ?packs?', 'paquetes? de datos', 'packs? de datos', 'pacotes? de dados']],
  ['shader', ['shaders?', 'shader ?packs?', 'sombreadores?']],
  ['plugin', ['plugins?', 'complementos? (?:de|para) (?:servidor|server)']],
  ['mod', ['mods?', 'modificaciones', 'modificacoes', 'modding', 'modded']],
];

// "y demas", "and more"... -> sumar los tipos relacionados con el tema.
const MORE_PATTERNS = [
  'y (?:demas|mas cosas|todo lo demas|todo|otras cosas|lo que sea|cosas asi|eso)',
  'etc(?:etera)?',
  'and (?:more|stuff|everything|the rest|so on|other stuff|whatever)',
  'e (?:mais|tudo|outras coisas)',
  'kit completo',
  'todo lo (?:necesario|que haga falta)',
  'complete kit',
  'full kit',
  'everything',
];

// Negaciones antes de un tipo: "sin shaders", "no quiero plugins", "without modpacks".
const NEGATION = /(?:^|\s)(?:sin|nada de|no quiero|no|without|no need for|except|sem|menos|excepto)(?:\s+[a-z]+){0,2}\s*$/;

const LOADER_PATTERNS = [
  ['neoforge', ['neo ?forge']],
  ['forge', ['forge', 'minecraft ?forge']],
  ['fabric', ['fabric(?: ?mc)?', 'fabric api']],
  ['quilt', ['quilt(?: ?mc)?']],
];
const SHADER_LOADER_PATTERNS = [
  ['optifine', ['optifine', 'opti fine']],
  ['iris', ['iris', 'iris shaders?', 'sodium']],
];
const SERVER_SOFTWARE_PATTERNS = [
  ['paper', ['paper ?(?:mc)?', 'paper ?server']],
  ['purpur', ['purpur']],
  ['spigot', ['spigot']],
  ['bukkit', ['bukkit', 'craftbukkit']],
  ['folia', ['folia']],
];
const VANILLA_PATTERNS = ['vanilla(?! ?(?:plus|\\+|like|mejorad[oa]))', 'sin mods', 'without mods', 'no mods', 'sem mods', 'sin modificaciones', 'puro', 'pure vanilla'];

// Modo de juego. Se evaluan en este orden y cada coincidencia se "tapa": primero la intencion
// explicita de armar un servidor, despues jugar con otros y por ultimo jugar solo.
const MODE_PATTERNS = [
  ['server', [
    '(?:crear|armar|montar|hacer|hostear|abrir|tener|administrar|configurar|levantar|host|create|make|run|setup|set up|criar|hospedar) (?:un |mi |el |una |a |my |o |um |meu )?(?:propio |own |proprio )?(?:servidor|server)',
    '(?:quiero|necesito|busco|want|need|quero|preciso) (?:un |a |um |mi |my |meu )?(?:propio |own |proprio )?(?:servidor|server)',
    'mi (?:propio )?(?:servidor|server)',
    'my (?:own )?server',
    'meu (?:proprio )?servidor',
    '(?:servidor|server)(?:es|s)? (?:de|con|with|com|para) (?:economia|economy|plugins?|minijuegos|minigames|survival|skyblock|facciones|factions|pvp|rol|roleplay|creativo|creative|towny|prison|bedwars|anarquia|anarchy)',
    '(?:economy|survival|skyblock|factions|pvp|minigames?|towny|prison|anarchy|smp) servers?',
    '(?:para|for|pra) (?:un |mi |el |my |a |o |meu |um )?(?:servidor|server)',
    'server ?side',
    'lado del servidor',
    'red de servidores',
    'server network',
  ]],
  ['multiplayer', [
    'multi ?player',
    'multi ?jugador',
    'multijogador',
    'con (?:mis |unos |los |las )?(?:amig[oa]s|panas|pibes|chicos|primos|hermanos)',
    'con (?:mi )?(?:novia|novio|hermano|hermana|primo|prima|pareja|amig[oa])',
    'with (?:my )?(?:friends|buddies|mates|family|girlfriend|boyfriend|brother|sister)',
    'com (?:meus |os |as )?(?:amigos|amigas|parceiros)',
    'co ?op',
    'cooperativ[oa]s?',
    'smp',
    'lan',
    'online',
    'en linea',
    'juntos',
    'together',
    '(?:servidor|server)(?:es|s)?',
  ]],
  ['singleplayer', [
    'single ?player',
    'un ?jugador',
    'um jogador',
    '(?:jugar|juego|partida|mundo|jogar|play|playing) (?:solo|sola|sozinho|alone|by myself)',
    'en solitario',
    'solitario',
    'sozinho',
    'by myself',
    'alone',
    'modo historia',
  ]],
];

// Patrones de rendimiento sin tema propio ("shaders livianos" no implica mods de optimizacion).
const LOWEND_PATTERNS = ['livian[oa]s?', 'liger[oa]s?', 'lite', 'light ?weight', 'leves?', 'pc (?:lenta|vieja|mala|papa|potato|humilde|basica)', 'low ?end', 'pocos recursos', 'bajos recursos', 'potato', 'notebook', 'laptop', 'integrad[ao]s?', 'integrated'];
const HIGHEND_PATTERNS = ['pc (?:gamer|potente|buena|zarpada|tremenda)', 'high ?end', 'rtx', '4k', '8k', 'ultra', 'placa (?:de video )?potente', 'gpu potente', 'powerful (?:pc|gpu)'];

// Version con parche "estandar" de la comunidad de mods cuando se nombra solo la version menor.
const MODDED_PATCH = {
  '1.7': '1.7.10',
  '1.8': '1.8.9',
  '1.10': '1.10.2',
  '1.11': '1.11.2',
  '1.12': '1.12.2',
  '1.14': '1.14.4',
  '1.15': '1.15.2',
  '1.16': '1.16.5',
  '1.17': '1.17.1',
  '1.18': '1.18.2',
  '1.19': '1.19.2',
  '1.20': '1.20.1',
  '1.21': '1.21.1',
};
const LATEST_PATTERNS = ['ultima version', 'version (?:mas nueva|mas reciente|actual)', 'latest(?: version)?', 'newest(?: version)?', 'ultima versao', 'versao mais recente', 'ultima'];

// Temas: patrones (es/en/pt) -> busquedas de Modrinth por tipo.
//   q:     consultas de texto por tipo (las primeras pesan mas)
//   cat:   busquedas por categoria (cada lista es un OR de categorias)
//   boost: categorias que suben el puntaje de un resultado
//   rel:   temas relacionados (pesan menos)
//   types: tipos que conviene incluir en un "kit" de este tema
//   suppress: temas que este tema vuelve irrelevantes (p. ej. "tecnico" vuelve generico a "survival")
//   modeHint: modo de juego que sugiere el tema si el pedido no dice otro
//   avoid: frases en el titulo que delatan un resultado fuera de tema ("ender dragon" no son dragones)
//   avoidText: lo mismo, buscando tambien en la descripcion
const THEMES = [
  {
    id: 'zombies',
    p: ['zombi(?:e|s|es)?', 'apocalip[a-z]*', 'apocalyp[a-z]*', 'post ?apocalip[a-z]*', 'post ?apocalyp[a-z]*', 'undead', 'no ?muertos?', 'muertos? vivientes?', 'mortos? vivos?', 'infectad[oa]s?', 'infected', 'infeccion', 'walking dead', 'last of us', 'z ?day'],
    q: { mod: ['zombie', 'zombie apocalypse', 'undead'], modpack: ['zombie apocalypse', 'zombie'], resourcepack: ['zombie'], datapack: ['zombie'], plugin: ['zombies'] },
    boost: { mod: ['mobs', 'adventure', 'game-mechanics'], modpack: ['adventure', 'challenging', 'combat'], datapack: ['mobs', 'game-mechanics'], plugin: ['mobs', 'minigame'], resourcepack: ['themed'], shader: ['realistic', 'semi-realistic'] },
    rel: ['survival', 'horror'],
    types: ['mod', 'resourcepack', 'shader', 'datapack'],
  },
  {
    id: 'horror',
    p: ['horror', 'terror(?:ifico)?', 'miedo', 'scary', 'creepy', 'spooky', 'sustos?', 'tenebros[oa]s?', 'escalofriante', 'aterrador[a]?', 'paranormal', 'herobrine', 'cave dweller', 'man from the fog', 'fantasmas?', 'ghosts?', 'medo', 'assustador'],
    q: { mod: ['horror', 'scary'], modpack: ['horror'], resourcepack: ['horror', 'scary'], shader: ['horror', 'dark'], datapack: ['horror'], plugin: ['horror'] },
    boost: { mod: ['mobs', 'adventure'], resourcepack: ['themed'], shader: ['realistic', 'atmosphere'], modpack: ['adventure', 'challenging'] },
    avoid: ['dark mode', 'dark ui', 'dark theme', 'dark gui'],
    rel: ['survival'],
    types: ['mod', 'resourcepack', 'shader'],
  },
  {
    id: 'survival',
    weight: 0.6,
    p: ['supervivencia', 'survival', 'sobrevivir', 'sobrevivencia', 'survive', 'sobreviver'],
    q: { mod: ['survival'], modpack: ['survival'], datapack: ['survival'], plugin: ['survival'] },
    boost: { mod: ['game-mechanics', 'food', 'adventure'], modpack: ['adventure', 'challenging'], datapack: ['game-mechanics'] },
    types: ['mod', 'resourcepack', 'shader', 'datapack'],
  },
  {
    id: 'hardcore',
    p: ['hardcore', 'dificil(?:es)?', 'dificultad', 'desafi(?:o|os|ante|antes)', 'challeng(?:e|es|ing)', 'brutal', 'dificeis?', 'dificuldade'],
    q: { mod: ['difficulty', 'hardcore'], modpack: ['hardcore'], datapack: ['difficulty', 'hardcore'], plugin: ['hardcore'] },
    cat: { modpack: [['challenging']] },
    boost: { mod: ['game-mechanics', 'mobs'], modpack: ['challenging'], datapack: ['game-mechanics'] },
    types: ['mod', 'datapack'],
  },
  {
    id: 'dragons',
    p: ['dragon(?:es|s)?', 'dragoes', 'dragao', 'wyverns?', 'how to train your dragon'],
    q: { mod: ['dragons', 'dragon mounts', 'wyvern'], modpack: ['dragons'], datapack: ['dragons'], resourcepack: ['dragons'], plugin: ['dragons'] },
    boost: { mod: ['mobs', 'adventure'], modpack: ['adventure', 'magic'], datapack: ['mobs'] },
    avoid: ['ender dragon', 'dragon egg', 'dragon breath', 'elytra'],
    rel: ['fantasy'],
    types: ['mod', 'resourcepack', 'shader'],
  },
  {
    id: 'medieval',
    p: ['medieval(?:es)?', 'castillos?', 'castles?', 'castelos?', 'caballeros?', 'knights?', 'cavaleiros?', 'reinos?', 'kingdoms?', 'feudal', 'edad media', 'middle ages', 'idade media'],
    q: { mod: ['medieval', 'castle'], modpack: ['medieval'], resourcepack: ['medieval'], shader: ['medieval'], datapack: ['medieval', 'castle'], plugin: ['medieval'] },
    boost: { mod: ['worldgen', 'decoration', 'equipment', 'adventure'], resourcepack: ['themed', 'realistic'], shader: ['fantasy'], datapack: ['worldgen'], modpack: ['adventure'] },
    rel: ['building', 'exploration'],
    types: ['mod', 'resourcepack', 'shader', 'datapack'],
  },
  {
    id: 'fantasy',
    p: ['fantasia', 'fantasy', 'fantastic[oa]s?', 'rpg', 'elf(?:o|os|s)?', 'elves', 'enanos', 'dwarves', 'orcos?', 'orcs?', 'mitolog[a-z]*', 'mytholog[a-z]*', 'mythical', 'criaturas magicas'],
    q: { mod: ['fantasy', 'rpg'], modpack: ['rpg', 'fantasy'], resourcepack: ['fantasy'], shader: ['fantasy'], datapack: ['rpg'], plugin: ['rpg'] },
    cat: { shader: [['fantasy']] },
    boost: { mod: ['adventure', 'magic', 'mobs'], modpack: ['adventure', 'quests', 'magic'], resourcepack: ['themed'], shader: ['fantasy'] },
    rel: ['magic'],
    types: ['mod', 'resourcepack', 'shader'],
  },
  {
    id: 'magic',
    p: ['magia', 'magic[oa]?s?', 'magic', 'hechiz(?:o|os|eria)', 'spells?', 'sorcery', 'brujeria', 'bruj[oa]s?', 'witch(?:es|craft)?', 'magos?', 'wizards?', 'mages?', 'alquimia', 'alchemy', 'encantamientos?', 'bruxaria', 'feiticos?', 'feiticeir[oa]s?'],
    q: { mod: ['magic', 'spells'], modpack: ['magic'], datapack: ['magic', 'spells'], plugin: ['magic', 'spells'], resourcepack: ['magic'] },
    cat: { mod: [['magic']], modpack: [['magic']] },
    boost: { mod: ['magic', 'adventure'], modpack: ['magic'], datapack: ['magic'], plugin: ['magic'] },
    types: ['mod', 'resourcepack', 'shader'],
  },
  {
    id: 'technology',
    p: ['tecnologi[a-z]*', 'tech', 'technology', 'automatiza[a-z]*', 'automation', 'automat(?:ic|ed|e)', 'maquinas?', 'machines?', 'maquinaria', 'machinery', 'industria[a-z]*', 'fabricas?', 'factor(?:y|ies)', 'energia', 'energy', 'electricidad', 'electricity', 'ingenieria', 'engineering', 'create mod', 'mod create', 'create addons?', 'mekanism', 'thermal'],
    q: { mod: ['technology', 'automation'], modpack: ['tech', 'automation'], datapack: ['automation'] },
    cat: { mod: [['technology']], modpack: [['technology']] },
    boost: { mod: ['technology', 'storage', 'transportation'], modpack: ['technology'] },
    types: ['mod', 'modpack'],
  },
  {
    id: 'technical',
    p: ['tecnic[oa]s?', 'technical', 'redstone', 'granjas?', 'farms?', 'carpet', 'litematica', 'tmc', 'contraptions?', 'mecanismos?', 'schematics?', 'esquemas?'],
    q: { mod: ['carpet', 'litematica', 'redstone'], modpack: ['technical'], resourcepack: ['redstone'], datapack: ['technical', 'redstone'], plugin: ['redstone'] },
    boost: { mod: ['utility', 'technology'], resourcepack: ['utility', 'tweaks'], datapack: ['utility'] },
    suppress: ['survival', 'hardcore'],
    types: ['mod', 'resourcepack', 'datapack'],
  },
  {
    id: 'exploration',
    p: ['aventuras?', 'adventures?', 'explor(?:ar|acion|ation|e|ing|er|acao)', 'mazmorras?', 'dungeons?', 'calabozos?', 'estructuras?', 'structures?', 'ruinas?', 'ruins?', 'aldeas?', 'villages?', 'templos?', 'temples?', 'tesoros?', 'treasures?', 'masmorras?', 'estruturas?'],
    q: { mod: ['adventure', 'dungeons', 'structures'], modpack: ['adventure', 'exploration'], datapack: ['structures', 'dungeons'], plugin: ['dungeons'] },
    cat: { datapack: [['worldgen']] },
    boost: { mod: ['adventure', 'worldgen'], modpack: ['adventure', 'quests'], datapack: ['worldgen', 'adventure'] },
    types: ['mod', 'datapack', 'shader'],
  },
  {
    id: 'worldgen',
    p: ['biomas?', 'biomes?', 'terrenos?', 'terrain', 'generacion (?:de )?(?:mundos?|terrenos?)', 'world ?gen(?:eration)?', 'paisajes?', 'landscapes?', 'montanas?', 'mountains?', 'islas?', 'islands?', 'bosques?', 'forests?', 'desiertos?', 'deserts?', 'naturaleza', 'nature', 'paisagens?', 'florestas?'],
    q: { mod: ['biomes', 'terrain'], datapack: ['terrain', 'biomes'], modpack: ['exploration'] },
    cat: { mod: [['worldgen']], datapack: [['worldgen']] },
    boost: { mod: ['worldgen'], datapack: ['worldgen'] },
    types: ['mod', 'datapack', 'shader'],
  },
  {
    id: 'caves',
    p: ['cuevas?', 'caves?', 'cavernas?', 'mineria', 'mining', 'mines', 'subterrane[oa]s?', 'underground', 'mineracao'],
    q: { mod: ['caves', 'mining'], datapack: ['caves'] },
    boost: { mod: ['worldgen', 'adventure'], datapack: ['worldgen'] },
    types: ['mod', 'datapack'],
  },
  {
    id: 'building',
    p: ['construir', 'construcc?ion(?:es)?', 'building', 'builder', 'builds?', 'construcao', 'decora(?:cion|r|tion|tivos?|cao)', 'decor', 'muebles?', 'furniture', 'moveis', 'arquitectura', 'architecture', 'arquitetura', 'casas?', 'houses?', 'mansiones?', 'interiores?', 'interior'],
    q: { mod: ['furniture', 'decoration', 'building'], resourcepack: ['decoration', 'building'], datapack: ['decoration'], plugin: ['building'], modpack: ['building'] },
    cat: { mod: [['decoration']], resourcepack: [['decoration']] },
    boost: { mod: ['decoration'], resourcepack: ['decoration', 'vanilla-like'] },
    types: ['mod', 'resourcepack', 'shader'],
  },
  {
    id: 'fps',
    p: ['fps', 'rendimiento', 'performance', 'desempenho', 'optimiz[a-z]*', 'otimiz[a-z]*', 'lag(?:s|ea|uea|ueo)?', 'tirones?', 'stutter[a-z]*', 'pc (?:lenta|vieja|mala|papa|potato|humilde|basica|de bajos recursos|de pocos recursos|fraca)', 'compu(?:tadora)? (?:lenta|vieja)', 'notebook (?:vieja|lenta)', 'low ?end', 'low ?spec', 'bajos recursos', 'pocos recursos', 'mas fps', 'more fps', 'mais fps', '(?:va|anda|corre|funciona) lento', 'runs slow', 'slow pc', 'weak pc', 'old pc', 'computador fraco'],
    q: { mod: ['optimization', 'performance', 'fps'], modpack: ['optimized', 'performance'], resourcepack: ['fps', 'performance'], shader: ['potato', 'lite'], plugin: ['optimization', 'lag'] },
    cat: { mod: [['optimization']], modpack: [['optimization']], plugin: [['optimization']] },
    boost: { mod: ['optimization'], modpack: ['optimization', 'lightweight'], resourcepack: ['simplistic', '16x', '8x-', 'tweaks'], shader: ['potato', 'low'], plugin: ['optimization'] },
    flags: { lowEnd: true },
    types: ['mod', 'modpack'],
  },
  {
    id: 'pvp',
    p: ['pvp', 'combate', 'combat(?:e|s)?', 'peleas?', 'fight(?:ing|s)?', 'duel(?:o|os|s)?', 'bedwars', 'bed wars', 'skywars', 'sky wars', 'uhc', 'kit ?pvp', 'practice', 'hypixel', 'cps', 'pvp packs?'],
    q: { mod: ['pvp', 'combat'], modpack: ['pvp', 'combat'], resourcepack: ['pvp'], shader: ['pvp'], datapack: ['pvp', 'combat'], plugin: ['pvp', 'duels', 'arena'] },
    cat: { resourcepack: [['combat']], modpack: [['combat']] },
    boost: { mod: ['equipment', 'utility', 'game-mechanics', 'optimization'], resourcepack: ['combat', '16x', '8x-', 'simplistic'], plugin: ['minigame', 'game-mechanics'], modpack: ['combat'] },
    types: ['mod', 'resourcepack'],
  },
  {
    id: 'economy',
    p: ['econom[a-z]*', 'tiendas?', 'shops?', 'lojas?', 'dinero', 'money', 'dinheiro', 'comercio', 'commerce', 'trad(?:e|ing|ear)', 'subastas?', 'auctions?', 'leiloes?', 'mercados?', 'markets?', 'bancos?', 'banks?', 'monedas?', 'coins?', 'vault', 'jobs', 'trabajos', 'empleos'],
    q: { plugin: ['economy', 'shop', 'auction'], mod: ['economy', 'shop', 'trading'], datapack: ['economy', 'shop'], modpack: ['economy'] },
    cat: { plugin: [['economy']], mod: [['economy']] },
    boost: { plugin: ['economy', 'management'], mod: ['economy'], datapack: ['economy'] },
    types: ['mod', 'datapack'],
  },
  {
    id: 'skyblock',
    p: ['sky ?block', 'one ?block', 'islas? (?:en el|flotantes?|del) cielo', 'sky ?islands?', 'void world', 'mundo vacio', 'mundo vazio', 'ilha no ceu'],
    q: { modpack: ['skyblock', 'oneblock'], mod: ['skyblock', 'void world'], datapack: ['skyblock', 'one block'], plugin: ['skyblock', 'oneblock'], resourcepack: ['skyblock'] },
    boost: { modpack: ['quests', 'challenging', 'technology'], datapack: ['worldgen', 'game-mechanics'], plugin: ['minigame'] },
    avoidText: ['hypixel'],
    suppress: ['survival'],
    types: ['modpack', 'datapack', 'mod'],
  },
  {
    id: 'pirates',
    p: ['piratas?', 'pirates?', 'barcos?', 'ships?', 'boats?', 'navios?', 'navegar', 'sailing', 'oceanos?', 'oceans?', 'mares?', 'seas?', 'submarin[a-z]*', 'underwater', 'bajo el agua'],
    q: { mod: ['pirates', 'ships', 'ocean'], modpack: ['pirates'], datapack: ['pirate', 'ocean'], resourcepack: ['ocean'] },
    boost: { mod: ['adventure', 'transportation', 'worldgen'], datapack: ['worldgen'] },
    types: ['mod', 'datapack', 'shader'],
  },
  {
    id: 'space',
    p: ['espacio exterior', 'outer space', 'space', 'planetas?', 'planets?', 'cohetes?', 'rockets?', 'galaxias?', 'galax(?:y|ies)', 'marte', 'mars', 'astronaut[a-z]*', 'naves? espacial(?:es)?', 'spaceships?', 'ad astra', 'foguetes?'],
    q: { mod: ['space', 'planets', 'rocket'], modpack: ['space'], datapack: ['space'], resourcepack: ['space'] },
    boost: { mod: ['technology', 'adventure', 'worldgen'], modpack: ['technology', 'adventure'] },
    types: ['mod', 'modpack'],
  },
  {
    id: 'guns',
    p: ['armas de fuego', 'guns?', 'firearms?', 'pistolas?', 'rifles?', 'escopetas?', 'shotguns?', 'militar(?:es)?', 'military', 'guerras?', 'wars?', 'ww ?(?:1|2|i|ii)', 'segunda guerra', 'primera guerra', 'world war', 'ejercitos?', 'army', 'soldados?', 'soldiers?', 'tanques?', 'tanks?', 'balas', 'bullets', 'francotirador', 'sniper'],
    q: { mod: ['guns', 'firearms', 'military'], modpack: ['military', 'guns'], datapack: ['guns'], plugin: ['guns'], resourcepack: ['guns'] },
    boost: { mod: ['equipment', 'adventure'] },
    types: ['mod', 'resourcepack'],
  },
  {
    id: 'vehicles',
    p: ['autos?', 'coches?', 'carros?', 'cars?', 'vehiculos?', 'vehicles?', 'aviones?', 'avioes', 'planes?', 'airplanes?', 'trenes?', 'trens?', 'trains?', 'motos?', 'motorcycles?', 'helicopteros?', 'helicopters?', 'camiones?', 'trucks?'],
    q: { mod: ['vehicles', 'cars', 'planes', 'trains'], datapack: ['vehicles'], plugin: ['vehicles'] },
    cat: { mod: [['transportation']] },
    boost: { mod: ['transportation', 'technology'] },
    types: ['mod'],
  },
  {
    id: 'farming',
    p: ['agricultura', 'farming', 'cultivos?', 'crops?', 'cosechas?', 'harvest', 'cocina(?:r)?', 'cooking', 'cozinha(?:r)?', 'comidas?', 'food', 'recetas?', 'recipes?', 'huertas?', 'jardin(?:es)?', 'gardens?', 'granja de animales', 'ganaderia', 'livestock', 'pesca', 'fishing', 'apicultura', 'colmenas?', 'fazendas?', 'plantacao'],
    q: { mod: ['farming', 'cooking', 'crops'], datapack: ['farming', 'food'], modpack: ['farming'], plugin: ['farming'], resourcepack: ['food'] },
    cat: { mod: [['food']] },
    boost: { mod: ['food', 'decoration'], datapack: ['food'] },
    types: ['mod', 'resourcepack'],
  },
  {
    id: 'animals',
    p: ['animales?', 'animals?', 'animais', 'criaturas?', 'creatures?', 'mascotas?', 'pets?', 'fauna', 'bichos', 'wildlife', 'dinosaurios?', 'dinosaurs?', 'dinos?', 'lobos?', 'wolves', 'perros?', 'dogs?', 'gatos?', 'cats?', 'caballos?', 'horses?', 'aves', 'pajaros', 'birds?', 'peces', 'fish(?:es)?', 'insectos?', 'insects?', 'tiburones?', 'sharks?', 'mobs? nuevos', 'new mobs', 'more mobs', 'mas mobs', 'mais mobs'],
    q: { mod: ['animals', 'creatures'], datapack: ['animals', 'mobs'], resourcepack: ['animals', 'mobs'] },
    cat: { mod: [['mobs']] },
    boost: { mod: ['mobs'], datapack: ['mobs'], resourcepack: ['entities'] },
    types: ['mod', 'resourcepack'],
  },
  {
    id: 'monsters',
    p: ['monstruos?', 'monsters?', 'monstros?', 'criaturas? hostiles?', 'hostile mobs', 'enemigos', 'enemies', 'inimigos'],
    q: { mod: ['monsters', 'hostile mobs'], datapack: ['mobs'], resourcepack: ['mobs'] },
    boost: { mod: ['mobs', 'adventure'], datapack: ['mobs'] },
    types: ['mod', 'datapack'],
  },
  {
    id: 'bosses',
    p: ['jefes?', 'bosses', 'boss', 'jefes finales', 'chefes?'],
    q: { mod: ['bosses', 'boss'], datapack: ['bosses', 'boss'], modpack: ['bosses'], plugin: ['bosses'] },
    boost: { mod: ['mobs', 'adventure'], datapack: ['mobs', 'adventure'] },
    types: ['mod', 'datapack'],
  },
  {
    id: 'pokemon',
    p: ['pokemon(?:es|s)?', 'pixelmon', 'cobblemon', 'pokemones'],
    q: { mod: ['cobblemon', 'pokemon'], modpack: ['cobblemon', 'pokemon'], datapack: ['cobblemon'], resourcepack: ['pokemon', 'cobblemon'], plugin: ['pokemon'] },
    boost: { mod: ['mobs', 'adventure'] },
    types: ['mod', 'modpack', 'resourcepack'],
  },
  {
    id: 'realistic',
    p: ['realistas?', 'realistic[oa]?s?', 'realisticas?', 'fotorrealist[a-z]*', 'photorealis[a-z]*', 'hiper ?realist[a-z]*', 'hd', 'alta (?:definicion|resolucion|definicao|resolucao)', 'high ?res(?:olution)?', 'graficos? (?:lindos|hermosos|buenos|realistas|increibles|zarpados|bonitos)', 'mejores graficos', 'better graphics', 'melhores graficos', 'beautiful', 'hermos[oa]s?', 'lind[oa]s?', 'bonit[oa]s?', 'cinematic[oa]?s?', 'cinematografic[oa]s?', 'ray ?tracing', 'path ?tracing'],
    q: { resourcepack: ['realistic'], shader: ['realistic'], mod: ['visual'], modpack: ['realistic', 'graphics'] },
    cat: { resourcepack: [['realistic']], shader: [['realistic', 'semi-realistic']] },
    boost: { resourcepack: ['realistic', '64x', '128x', '256x', '512x+'], shader: ['realistic', 'semi-realistic', 'pbr', 'reflections', 'path-tracing'] },
    types: ['resourcepack', 'shader'],
  },
  {
    id: 'vanillaplus',
    p: ['vanilla ?(?:plus|\\+|mejorad[oa]|like)', 'calidad de vida', 'quality of life', 'qol', 'mejoras? sutiles?', 'subtle', 'retoques?', 'tweaks?', 'ajustes? (?:pequenos|sutiles)', 'qualidade de vida'],
    q: { mod: ['quality of life', 'vanilla+'], resourcepack: ['vanilla tweaks', 'vanilla'], datapack: ['tweaks', 'quality of life'], shader: ['vanilla'], modpack: ['vanilla+'], plugin: ['quality of life'] },
    cat: { resourcepack: [['vanilla-like', 'tweaks']], shader: [['vanilla-like']] },
    boost: { mod: ['utility', 'game-mechanics'], resourcepack: ['vanilla-like', 'tweaks'], shader: ['vanilla-like'], modpack: ['lightweight'] },
    suppress: ['survival'],
    types: ['mod', 'resourcepack', 'datapack'],
  },
  {
    id: 'cartoon',
    p: ['caricatur[a-z]*', 'cartoon[a-z]*', 'dibujos animados', 'tiern[oa]s?', 'cute', 'kawaii', 'colorid[oa]s?', 'colou?rful', 'anime', 'fofo', 'fofinho'],
    q: { resourcepack: ['cartoon', 'cute'], shader: ['cartoon'], mod: ['cute'] },
    cat: { shader: [['cartoon']], resourcepack: [['simplistic', 'themed']] },
    boost: { resourcepack: ['simplistic', 'themed'], shader: ['cartoon', 'fantasy'] },
    types: ['resourcepack', 'shader'],
  },
  {
    id: 'minigames',
    p: ['mini ?juegos?', 'mini ?games?', 'minijogos?', 'parkour', 'escondidas', 'hide and seek', 'esconde esconde', 'carreras', 'races?', 'racing', 'spleef', 'murder mystery', 'build battle', 'arenas?'],
    q: { plugin: ['minigames', 'parkour'], datapack: ['minigame', 'parkour'], mod: ['minigame'] },
    cat: { plugin: [['minigame']], datapack: [['minigame']] },
    boost: { plugin: ['minigame'], datapack: ['minigame'], mod: ['minigame'] },
    types: ['datapack', 'plugin'],
  },
  {
    id: 'servermgmt',
    p: ['administra[a-z]*', 'admins?', 'moderacion', 'moderation', 'moderar', 'moderacao', 'permisos', 'permissions', 'perms', 'anti ?cheats?', 'anti ?trampas?', 'proteccion', 'protection', 'protecao', 'proteger', 'protect', 'anti ?grief', 'grief(?:ing)?', 'rangos', 'ranks?', 'essentials?', 'homes?', 'teletransport[a-z]*', 'teleport[a-z]*', 'tpa', 'warps?', 'backups?', 'anuncios', 'announcements?', 'scoreboards?', 'tab ?list', 'login', 'authme', 'registro de jugadores'],
    q: { plugin: ['essentials', 'permissions', 'protection'], mod: ['server utilities', 'admin'], datapack: ['utility'] },
    cat: { plugin: [['management']] },
    boost: { plugin: ['management', 'utility', 'social'], mod: ['management', 'utility'] },
    types: ['plugin'],
    modeHint: 'server',
  },
  {
    id: 'factions',
    p: ['facciones', 'factions?', 'faccoes', 'towny', 'pueblos de jugadores', 'towns?', 'clanes?', 'clans?', 'territori[a-z]*', 'claims?', 'land claims?', 'reclamar terreno'],
    q: { plugin: ['factions', 'towny', 'clans'], mod: ['factions', 'claims'], datapack: ['teams'] },
    boost: { plugin: ['management', 'social', 'game-mechanics'], mod: ['management', 'social'] },
    types: ['plugin', 'mod'],
    modeHint: 'server',
  },
  {
    id: 'seasons',
    p: ['estaciones? del ano', 'estaciones', 'seasons?', 'estacoes', 'clima', 'weather', 'tormentas?', 'storms?', 'tornados?', 'lluvias?', 'rain', 'nieve', 'snow', 'invierno', 'winter', 'verano', 'summer', 'otono', 'autumn'],
    q: { mod: ['seasons', 'weather'], shader: ['weather'], resourcepack: ['seasons'], datapack: ['seasons', 'weather'] },
    boost: { mod: ['game-mechanics', 'worldgen'], shader: ['atmosphere'] },
    types: ['mod', 'shader'],
  },
  {
    id: 'minimap',
    p: ['mini ?mapas?', 'minimap[a-z]*', 'mapas?', 'maps?', 'world ?map', 'waypoints?', 'gps'],
    q: { mod: ['minimap', 'map'], plugin: ['map', 'dynmap'], datapack: ['map'] },
    boost: { mod: ['utility'], plugin: ['utility'] },
    types: ['mod'],
  },
  {
    id: 'storage',
    p: ['inventarios?', 'inventory', 'almacenamiento', 'storage', 'armazenamento', 'mochilas?', 'backpacks?', 'cofres?', 'chests?', 'ordenar', 'sorting', 'organizar', 'organize'],
    q: { mod: ['storage', 'backpacks', 'inventory'], datapack: ['storage'], plugin: ['backpacks'] },
    cat: { mod: [['storage']] },
    boost: { mod: ['storage', 'utility'] },
    types: ['mod'],
  },
  {
    id: 'immersion',
    p: ['inmersi[a-z]*', 'immersi[a-z]*', 'imersi[a-z]*', 'animaciones', 'animations?', 'animacoes', 'fisicas?', 'physics', 'primera persona', 'first person', 'primeira pessoa', 'realismo', 'realism', 'particulas', 'particles', 'efectos', 'effects', 'atmosfera', 'atmosphere', 'ambience', 'ambient'],
    q: { mod: ['immersive', 'animations', 'physics'], resourcepack: ['animated', '3d'], shader: ['atmospheric'] },
    boost: { mod: ['decoration', 'game-mechanics', 'utility'], resourcepack: ['models', 'entities'], shader: ['atmosphere', 'foliage'] },
    types: ['mod', 'resourcepack', 'shader'],
  },
  {
    id: 'sounds',
    p: ['sonidos?', 'sounds?', 'sons', 'musica', 'music', 'musicas', 'songs?', 'audio', 'ambiente sonoro', 'soundscape', 'sound effects?'],
    q: { mod: ['sounds', 'ambient sounds', 'music'], resourcepack: ['sounds', 'music'], datapack: ['music'] },
    cat: { resourcepack: [['audio']] },
    boost: { resourcepack: ['audio'], mod: ['decoration'] },
    types: ['mod', 'resourcepack'],
  },
  {
    id: 'darkui',
    p: ['modo oscuro', 'dark mode', 'dark ui', 'interfaz oscura', 'tema oscuro', 'dark theme', 'modo escuro', 'gui', 'interfaz', 'interface', 'menus?'],
    q: { resourcepack: ['dark mode', 'gui'], mod: ['dark mode'] },
    cat: { resourcepack: [['gui']] },
    boost: { resourcepack: ['gui', 'tweaks'] },
    types: ['resourcepack'],
  },
  {
    id: 'kitchensink',
    p: ['de todo un poco', 'un poco de todo', 'kitchen ?sink', 'muchos mods', 'lots of mods', 'cientos de mods', 'variedad', 'variety', 'tudo um pouco'],
    q: { modpack: ['kitchen sink'] },
    cat: { modpack: [['kitchen-sink']] },
    boost: { modpack: ['kitchen-sink'] },
    types: ['modpack'],
  },
  {
    id: 'quests',
    p: ['misiones', 'quests?', 'missoes', 'historia', 'story', 'lore', 'narrativa', 'campana', 'campaign'],
    q: { modpack: ['quests', 'story'], mod: ['quests'], datapack: ['quests'], plugin: ['quests'] },
    cat: { modpack: [['quests']] },
    boost: { modpack: ['quests', 'adventure'], mod: ['adventure'] },
    types: ['modpack', 'mod'],
  },
  {
    id: 'cozy',
    p: ['cozy', 'acogedor[a-z]*', 'tranquil[oa]s?', 'relajad[oa]s?', 'relaxing', 'relax', 'chill', 'pacific[oa]s?', 'peaceful', 'calm[oa]?s?', 'zen', 'aconchegante'],
    q: { mod: ['cozy', 'decoration', 'farming'], resourcepack: ['cozy', 'cute'], shader: ['cozy'], modpack: ['cozy', 'chill'], datapack: ['cozy'] },
    boost: { mod: ['decoration', 'food'], resourcepack: ['vanilla-like', 'decoration'], shader: ['vanilla-like', 'fantasy'], modpack: ['lightweight'] },
    types: ['mod', 'resourcepack', 'shader'],
  },
  {
    id: 'christmas',
    p: ['navidad', 'christmas', 'navidenas?', 'navidenos?', 'natal', 'xmas'],
    q: { mod: ['christmas'], resourcepack: ['christmas'], datapack: ['christmas'], plugin: ['christmas'] },
    types: ['resourcepack', 'mod'],
  },
  {
    id: 'halloween',
    p: ['halloween', 'dia de brujas', 'dia das bruxas', 'noche de brujas'],
    q: { mod: ['halloween'], resourcepack: ['halloween'], datapack: ['halloween'], plugin: ['halloween'] },
    types: ['resourcepack', 'mod'],
  },
  {
    id: 'japanese',
    p: ['japon[a-z]*', 'japan[a-z]*', 'samurais?', 'ninjas?', 'katanas?', 'oriental(?:es)?', 'asiatic[oa]s?', 'asian'],
    q: { mod: ['japanese', 'samurai', 'ninja'], resourcepack: ['japanese'], datapack: ['japanese'] },
    boost: { mod: ['decoration', 'equipment', 'worldgen'] },
    types: ['mod', 'resourcepack'],
  },
  {
    id: 'vikings',
    p: ['vikingos?', 'vikings?', 'nordic[oa]s?', 'norse'],
    q: { mod: ['vikings', 'norse'], resourcepack: ['viking'], datapack: ['viking'] },
    boost: { mod: ['adventure', 'equipment'] },
    types: ['mod', 'resourcepack'],
  },
  {
    id: 'western',
    p: ['vaqueros?', 'cowboys?', 'western', 'lejano oeste', 'wild west', 'far west', 'vaqueiros?'],
    q: { mod: ['western', 'cowboy'], resourcepack: ['western'] },
    boost: { mod: ['adventure', 'decoration'] },
    types: ['mod', 'resourcepack'],
  },
  {
    id: 'weapons',
    p: ['armas(?! de fuego)', 'weapons?', 'espadas?', 'swords?', 'armaduras?', 'armou?rs?', 'equipamiento', 'equipment', 'hachas?', 'axes?', 'arcos?', 'bows?', 'escudos?', 'shields?'],
    q: { mod: ['weapons', 'armor', 'swords'], datapack: ['weapons', 'armor'], resourcepack: ['weapons', 'swords'], plugin: ['custom items'] },
    cat: { mod: [['equipment']] },
    boost: { mod: ['equipment', 'adventure'], resourcepack: ['equipment', 'items'] },
    types: ['mod', 'resourcepack'],
  },
  {
    id: 'nether',
    p: ['nether', 'infierno', 'inframundo', 'el end', 'the end', 'dimensiones?', 'dimensions?', 'dimensoes'],
    q: { mod: ['nether', 'end', 'dimensions'], datapack: ['nether', 'end'] },
    boost: { mod: ['worldgen', 'adventure'], datapack: ['worldgen'] },
    types: ['mod', 'datapack'],
  },
  {
    id: 'voicechat',
    p: ['chat de voz', 'voice ?chat', 'proximity', 'proximidad', 'chat por proximidad', 'hablar', 'talk(?:ing)?'],
    q: { mod: ['simple voice chat', 'voice chat'], plugin: ['voice chat'] },
    boost: { mod: ['social', 'utility'], plugin: ['social'] },
    types: ['mod'],
  },
  {
    id: 'recording',
    p: ['grabar', 'record(?:ing)?', 'youtube', 'youtubers?', 'videos?', 'streams?', 'streamear', 'twitch', 'replay', 'camaras?', 'cameras?', 'fotos?', 'screenshots?', 'capturas?'],
    q: { mod: ['replay', 'camera', 'screenshot'], shader: ['cinematic'] },
    boost: { shader: ['screenshot', 'high'], mod: ['utility'] },
    types: ['mod', 'shader'],
  },
  {
    id: 'luckyblock',
    p: ['lucky ?blocks?', 'bloques? de la suerte', 'bloco da sorte'],
    q: { mod: ['lucky block'], datapack: ['lucky block'], plugin: ['lucky block'] },
    types: ['mod', 'datapack'],
  },
  {
    id: 'roleplay',
    p: ['rol', 'roleplay', 'role ?play', 'juego de rol'],
    q: { mod: ['roleplay'], plugin: ['roleplay'], modpack: ['roleplay'] },
    boost: { mod: ['social', 'decoration'], plugin: ['social'] },
    types: ['mod', 'plugin'],
  },
  {
    id: 'hud',
    p: ['hud', 'coordenadas', 'coordinates', 'zoom', 'keystrokes', 'informacion en pantalla'],
    q: { mod: ['hud', 'zoom', 'utility'] },
    boost: { mod: ['utility'] },
    types: ['mod'],
  },
  {
    id: 'speedrun',
    p: ['speed ?runs?', 'speed ?running', 'speedrunner'],
    q: { mod: ['speedrun'], datapack: ['speedrun'] },
    boost: { mod: ['utility', 'optimization'] },
    types: ['mod'],
  },
];

// Traducciones de sustantivos frecuentes (es/pt -> en) para las palabras sueltas del pedido.
// Modrinth esta casi todo en ingles: "vampiros" se busca como "vampires".
const WORDS = {
  vampiros: 'vampires', vampiro: 'vampire', 'hombres lobo': 'werewolves', 'hombre lobo': 'werewolf', licantropos: 'werewolves', lobisomem: 'werewolf', lobisomens: 'werewolves',
  dinosaurios: 'dinosaurs', dinosaurio: 'dinosaur', dinossauros: 'dinosaurs', dinos: 'dinosaurs',
  dragones: 'dragons', dragon: 'dragon', dragoes: 'dragons', robots: 'robots', robos: 'robots', aliens: 'aliens', extraterrestres: 'aliens', alienigenas: 'aliens',
  piratas: 'pirates', ninjas: 'ninja', samurais: 'samurai', vikingos: 'vikings', esqueletos: 'skeletons', fantasmas: 'ghosts', demonios: 'demons', angeles: 'angels',
  dioses: 'gods', titanes: 'titans', gigantes: 'giants', golems: 'golems', hadas: 'fairies', sirenas: 'mermaids', elfos: 'elves', enanos: 'dwarves', orcos: 'orcs',
  brujas: 'witches', brujos: 'witches', magos: 'wizards', caballeros: 'knights', castillos: 'castles', reinos: 'kingdoms', aldeas: 'villages', aldeanos: 'villagers',
  ciudades: 'cities', ciudad: 'city', casas: 'houses', muebles: 'furniture', arboles: 'trees', flores: 'flowers', plantas: 'plants', bosques: 'forests',
  montanas: 'mountains', rios: 'rivers', lagos: 'lakes', islas: 'islands', desiertos: 'deserts', selvas: 'jungle', selva: 'jungle', hielo: 'ice', volcanes: 'volcanoes',
  cristales: 'crystals', gemas: 'gems', minerales: 'ores', espadas: 'swords', arcos: 'bows', armaduras: 'armor', escudos: 'shields', mochilas: 'backpacks',
  barcos: 'ships', aviones: 'planes', trenes: 'trains', autos: 'cars', coches: 'cars', carros: 'cars', motos: 'motorcycles', cohetes: 'rockets', planetas: 'planets',
  aves: 'birds', pajaros: 'birds', peces: 'fish', tiburones: 'sharks', ballenas: 'whales', insectos: 'insects', aranas: 'spiders', abejas: 'bees', gatos: 'cats',
  perros: 'dogs', caballos: 'horses', lobos: 'wolves', osos: 'bears', vacas: 'cows', mascotas: 'pets', monstruos: 'monsters', monstros: 'monsters', jefes: 'bosses',
  mazmorras: 'dungeons', templos: 'temples', ruinas: 'ruins', tesoros: 'treasure', pociones: 'potions', hechizos: 'spells', cables: 'cables', tuberias: 'pipes',
  misiles: 'missiles', bombas: 'bombs', explosivos: 'explosives', tanques: 'tanks', pistolas: 'guns', policias: 'police', ladrones: 'thieves', presos: 'prison',
  carcel: 'prison', prision: 'prison', escuela: 'school', hospital: 'hospital', zoologico: 'zoo', parque: 'park', granja: 'farm', fazenda: 'farm', cocina: 'kitchen',
  deportes: 'sports', futbol: 'football', pesca: 'fishing', caza: 'hunting', comercio: 'trading', luces: 'lights', iluminacion: 'lighting', sombras: 'shadows',
  agua: 'water', reflejos: 'reflections', nubes: 'clouds', cielo: 'sky', niebla: 'fog', guerra: 'war', ninos: 'kids', familia: 'family',
  apocalipsis: 'apocalypse', zombis: 'zombies', zombies: 'zombies', zombie: 'zombie', momias: 'mummies', egipto: 'egypt', egipcio: 'egyptian', egipcia: 'egyptian',
  griego: 'greek', griega: 'greek', romano: 'roman', romanos: 'roman', aztecas: 'aztec', mayas: 'maya', nordicos: 'norse', celtas: 'celtic', chinos: 'chinese',
  comida: 'food', recetas: 'recipes', bebidas: 'drinks', cerveza: 'brewing', vino: 'wine', cafe: 'coffee', pan: 'bread', dulces: 'sweets',
  decoraciones: 'decorations', jardines: 'gardens', estatuas: 'statues', pinturas: 'paintings', cuadros: 'paintings', alfombras: 'carpets',
  calaveras: 'skulls', cuchillos: 'knives', hachas: 'axes', lanzas: 'spears', ballestas: 'crossbows', magia: 'magic', runas: 'runes', reliquias: 'relics',
};

// Palabras vacias (no se usan como terminos de busqueda).
const STOPWORDS = new Set(`
buscame busca buscar busco buscando buscarme encontrame encontra encontrar encuentra quiero quisiera queria necesito dame dar mostrame mostrar recomendame recomenda recomendar recomendas
pasame pasa armame arma armar hace haceme hacer tirame tira sugeri sugerime sugerir conseguime conseguir ayudame ayuda
algo alguno algunos alguna algunas unos unas un una uno el la los las lo le les al del de da do das dos y e o u ni que como cual cuales para por pra pro con sin com sem en no na nos nas a ante tras
mas muy mucho muchos mucha muchas poco pocos mejor mejores buen buenos buena buenas bueno top tipo tipos cosas cosa demas etc todo toda todos todas otro otra otros otras
mi mis tu tus su sus mio mia nuestro nuestra me te se nos yo vos usted ustedes ellos ellas el ella eso esto esta este estos estas ese esa esos esas aqui aca ahi alla
jugar juego juegos jugando jugable partida partidas mundo mundos minecraft java edition edicion bedrock version versiones ver
hola che onda estilo style please porfa favor gracias thanks
find me some for with and the an to of in on at play playing game games best good great cool nice want need looking look give show recommend suggest get make build
i my we our you your it its that this these those any all more most really very just also too like
quero queria preciso jogar jogo jogos mostre recomende encontre algum alguns alguma algumas um uma uns umas melhor melhores muito muitos
pack packs paquete paquetes pacote pacotes kit kits contenido content conteudo
modo mode
divertido divertidos divertida divertidas entretenido entretenidos interesante interesantes nuevo nuevos nueva nuevas viejo viejos vieja viejas original originales clasico clasicos
grande grandes pequeno pequenos simple simples facil faciles completo completos completa completas popular populares famoso famosos increible increibles genial geniales
copado copados piola piolas buenardo otra sea hay tiene tengan tenga sirva sirvan funcione funcionen compatible compatibles quede queden mejore mejoren agregue agreguen
cambie cambien haga hagan usar uso instalar descargar bajar poner meter agregar sumar cambiar mejorar ser estar tener ir jugarlo jugarla jugarlos entre sobre desde hasta
cuando donde mientras porque pero aunque tambien ademas bastante tan ya aun todavia siempre nunca ahora hoy cosa
fun funny interesting new old classic big small easy popular famous amazing awesome epic stuff things thing something anything kind sort list lot lots
legal massa divertidos novo novos nova novas
`.split(/\s+/).filter(Boolean));

// Palabras para adivinar el idioma del pedido.
const LANG_HINTS = {
  es: ['quiero', 'buscame', 'busca', 'jugar', 'con', 'los', 'las', 'una', 'del', 'y', 'tambien', 'algo', 'mejores', 'para', 'que', 'dame', 'mostrame', 'recomendame', 'amigos', 'supervivencia', 'texturas'],
  pt: ['quero', 'jogar', 'com', 'os', 'uma', 'do', 'da', 'e', 'mais', 'tambem', 'melhores', 'voce', 'pra', 'amigos', 'sobrevivencia', 'meus', 'jogo'],
  en: ['the', 'for', 'with', 'and', 'i', 'want', 'play', 'find', 'some', 'best', 'me', 'my', 'to', 'friends', 'looking', 'need', 'show'],
};

// Mods que hacen funcionar los shaders segun el loader (id de Modrinth).
const SHADER_HELPERS = {
  fabric: ['YL57xq9U'], // Iris
  quilt: ['YL57xq9U'],
  neoforge: ['YL57xq9U', 'GchcoXML'], // Iris (1.21+) u Oculus (1.20.1)
  forge: ['GchcoXML'], // Oculus
};
const IRIS_ID = 'YL57xq9U';

module.exports = {
  TYPES,
  CATEGORIES,
  MOD_LOADERS,
  PLUGIN_LOADERS,
  TYPE_PATTERNS,
  MORE_PATTERNS,
  NEGATION,
  LOADER_PATTERNS,
  SHADER_LOADER_PATTERNS,
  SERVER_SOFTWARE_PATTERNS,
  VANILLA_PATTERNS,
  MODE_PATTERNS,
  LOWEND_PATTERNS,
  HIGHEND_PATTERNS,
  MODDED_PATCH,
  LATEST_PATTERNS,
  THEMES,
  WORDS,
  STOPWORDS,
  LANG_HINTS,
  SHADER_HELPERS,
  IRIS_ID,
};
