'use strict';
// Vocabulario de TEMAS (generos, categorias y estilos) del Buscador inteligente: es / en / pt.
//
//   extend  suma sinonimos y busquedas a un tema que ya existe en lexicon.js (por id)
//   add     temas nuevos, con el mismo formato que THEMES de lexicon.js
//
// Formato de cada tema (ver lexicon.js para el detalle):
//   p        alternativas de expresion regular sobre texto normalizado (minusculas, sin tildes ni signos)
//   q        consultas de texto por tipo (las primeras pesan mas)
//   cat      busquedas por categoria de Modrinth (cada lista es un OR); solo categorias validas del tipo
//   boost    categorias que suben el puntaje de un resultado
//   rel      temas relacionados;  types: tipos que conviene incluir en un kit del tema
//   suppress / modeHint / avoid / avoidText / flags: igual que en lexicon.js
// Para sumar palabras nuevas alcanza con agregar alternativas a `p`. test/vocab.test.js comprueba que cada
// expresion compile y que cada categoria exista.

const extend = {
  recording: { p: ['streamers?', 'streaming', 'directos?', 'contenido (?:para|de) (?:youtube|tiktok)', 'content creators?', 'creadores de contenido', 'tiktok', 'shorts', 'reels', 'editar videos?', 'video editing', 'videos? cinematicos?', 'cinematic videos?', 'camara cinematica', 'cinematic camera'] },
  zombies: { p: ['caminantes', 'walkers?', 'brote', 'outbreak', 'plaga', 'plague', 'virus', 'muertos caminantes', 'zombies? (?:apocalipsis|apocalypse)'] },
  horror: {
    p: ['sobrenatural(?:es)?', 'supernatural', 'pesadillas?', 'nightmares?', 'siniestr[oa]s?', 'sinister', 'macabr[oa]s?', 'diabolic[oa]s?', 'demoniac[oa]s?', 'espeluznant[a-z]*', 'eerie', 'gore',
      'sangrient[oa]s?', 'bloody', 'slender(?: ?man)?', 'fnaf', 'five nights', 'backrooms', 'entity ?303', 'jump ?scares?', 'lovecraft(?:ian)?', 'cosmic horror', 'eldritch', 'creepypasta', 'de miedo'],
    q: { mod: ['creepy', 'nightmare'], datapack: ['scary'] },
  },
  magic: {
    p: ['hechicer[a-z]*', 'conjuros?', 'varitas?', 'wands?', 'runas?', 'runes?', 'pociones?', 'potions?', 'necromanc[a-z]*', 'taumaturg[a-z]*', 'thaumaturg[a-z]*', 'arcan[oa]s?', 'arcane', 'misticismo', 'mistic[oa]s?', 'mystic[a-z]*',
      'ocultismo', 'occult', 'maldiciones?', 'curses?', 'rituales?', 'rituals?', 'grimorios?', 'grimoires?', 'mana', 'torres? de (?:mago|magos|hechicero)', 'wizard towers?', 'brewing', 'elixires?', 'elixirs?', 'sortilegios?', 'encantad[oa]s?', 'enchanted', 'sobrenatural magico'],
    q: { mod: ['wizard', 'sorcery'] },
  },
  technology: {
    p: ['robots?', 'robotica', 'robotics', 'ciencia', 'science', 'quimica', 'chemistry', 'reactores?', 'reactors?', 'nuclear', 'tuberias', 'pipes', 'cables', 'logistica', 'logistics', 'cintas? transportadoras?', 'conveyors?',
      'ae2', 'applied energistics', 'refined storage', 'immersive engineering', 'industrial ?craft', 'build ?craft', 'redes? de (?:items|objetos)', 'item networks?', 'generadores?', 'generators?', 'paneles? solares?', 'solar panels?',
      'tecnologico', 'tecnologica', 'tecnologicos', 'tecnologicas', 'technological', 'mecanic[oa]s?', 'mechanical'],
  },
  technical: { p: ['granjas? automaticas?', 'automatic farms?', 'redstone (?:avanzada|compleja)', 'technical minecraft', 'minecraft tecnico', 'tmc server', 'contraption', 'schematic', 'litematic[a-z]*', 'cintas'] },
  exploration: {
    p: ['aventureros?', 'adventurers?', 'expediciones?', 'expeditions?', 'mundo abierto', 'open world', 'catacumbas?', 'catacombs?', 'fortalezas?', 'fortress(?:es)?', 'laberintos?', 'mazes?', 'ciudades? perdidas?',
      'lost cities', 'jefes? de mazmorras?', 'dungeon bosses', 'loot', 'botin', 'rpg de aventuras?', 'aventura epica', 'epic adventures?', 'misterios?', 'mysteries', 'mysterious', 'misterios[oa]s?',
      'cazatesoros', 'treasure hunt(?:ing)?', 'busqueda del tesoro', 'cazar tesoros', 'mazmorra'],
    q: { mod: ['exploration'] },
  },
  worldgen: {
    p: ['generacion', 'world generation', 'nuevos? biomas?', 'new biomes?', 'mundos? (?:mas )?(?:grandes|variados|bonitos|hermosos|reales)', 'bigger worlds?', 'terrenos? realistas?', 'realistic terrain', 'montanas? altas', 'tall mountains',
      'rios', 'rivers?', 'lagos', 'lakes?', 'oceanos? profundos', 'deep oceans?', 'acantilados', 'cliffs?', 'paisaje', 'scenery', 'mundo (?:mas )?(?:epico|espectacular)', 'epic worlds?', 'procedural'],
  },
  building: {
    p: ['world ?edit', 'planos', 'blueprints?', 'bloques? de construccion', 'building blocks?', 'paletas? de bloques', 'block palettes?', 'materiales de construccion', 'bloques nuevos', 'new blocks', 'chisel', 'macetas', 'ventanas',
      'puertas', 'techos', 'roofs?', 'escaleras', 'stairs', 'pisos', 'floors?', 'disenos?', 'designs?', 'ciudades?', 'cities', 'city', 'urban[a-z]*', 'edificios?', 'buildings', 'paisajismo', 'landscaping', 'terraform[a-z]*',
      'constructores', 'builders', 'arquitect[a-z]*', 'modo creativo', 'creative mode', 'bloques decorativos', 'decorative blocks', 'ladrillos', 'bricks', 'estructuras? propias', 'my builds', 'mis construcciones',
      'decorar', 'decorating', 'decorative', 'ornamentos?', 'ornaments?'],
    q: { mod: ['blocks', 'building blocks'], resourcepack: ['blocks'], datapack: ['building'] },
    boost: { mod: ['utility'] },
  },
  fps: {
    p: ['mejorar (?:el )?(?:rendimiento|fps)', 'subir (?:los )?fps', 'aumentar (?:los )?fps', 'boost (?:de )?fps', 'fps boost', 'sin lag', 'quitar (?:el )?lag', 'lag spikes?', 'mejor rendimiento', 'better performance', 'fluidez',
      'fluid[oa]s?', 'smooth(?:er)?(?: gameplay)?', 'runs? (?:smooth(?:ly)?|well|better|faster)', 'consumo de (?:ram|memoria)', 'low (?:ram|memory)', 'poca (?:ram|memoria)', 'ram usage', 'memory usage', 'uso de memoria',
      'bajo consumo', 'ahorrar (?:ram|memoria|bateria)', 'save (?:ram|memory|battery)', 'bateria', 'battery', 'stuttering', 'micro ?stutters?', 'frame ?rate', 'frames por segundo', 'frames per second', 'fps estables?', 'stable fps',
      'lagueando', 'lagging', 'carga lenta', 'slow loading', 'tarda en cargar', 'long load times?', 'inicio rapido', 'faster startup', 'arranque rapido', 'mas rapido', 'chunk loading', 'carga de chunks',
      'sin tirones', 'sin trabas', 'se (?:trab|tild|cuelg|congel)[a-z]*', 'trabad[oa]', 'pc (?:de )?(?:papa|patata|tomate|ladrillo|tostadora|abuela)', 'compu (?:de )?(?:papa|tostadora)', 'tostadora', 'lagu(?:e|ee|ea|eo|ear|eando|eas|eos)', 'sin laguear', 'sin caidas de fps', 'fps drops?', 'caidas de fps', 'bajones? de fps', 'se traba', 'se tilda', 'se congela', 'freezing', 'freezes', 'travando', 'trava', 'pesa mucho',
      'leve'],
    q: { mod: ['memory', 'lag'], resourcepack: ['low res'], datapack: ['performance'] },
  },
  vanillaplus: {
    p: ['mejoras? de calidad de vida', 'conveniencias?', 'convenience', 'comodidad(?:es)?', 'pequenas mejoras', 'small improvements', 'mejoras menores', 'minor improvements', 'cosas utiles', 'useful stuff', 'utilidades', 'utilities',
      'mas comodo', 'more convenient', 'sin cambiar (?:el )?(?:juego|gameplay)', 'mantener (?:el )?(?:estilo )?vanilla', 'keep it vanilla', 'vanilla friendly', 'estilo vanilla', 'vanilla style', 'sin alterar', 'sutil(?:es)?',
      'mejoras? del juego base', 'improvements? to vanilla', 'vanilla improved', 'vanilla mejorado', 'juego base mejorado', 'sin romper (?:el )?(?:juego|balance)', 'balanced', 'balanceado', 'equilibrado', 'detalles? utiles?', 'pequenos detalles',
      'tweaks', 'refinamientos?', 'refinements?', 'pulido', 'polish(?:ed)?', 'mejoras visuales sutiles'],
  },
  minigames: {
    p: ['juegos? de (?:servidor|server|fiesta|lobby)', 'party games?', 'battle royale', 'capture the flag', 'ctf', 'tnt ?run', 'murder', 'lobby', 'lobbies', 'trivia', 'juegos? de mesa', 'board games?', 'juegos? multijugador',
      'juegos? rapidos?', 'quick games?', 'partidas rapidas', 'minijuego'],
  },
  minimap: {
    p: ['mapa del mundo', 'world map', 'cartografia', 'cartography', 'brujula', 'compass', 'xaero[a-z]*', 'journey ?map', 'voxel ?map', 'dynmap', 'blue ?map', 'mapa (?:en )?(?:tiempo real|vivo|web)', 'live map', 'web map', 'marcadores', 'ubicaciones', 'orientarme', 'orientarse', 'no perderme', 'not get lost', 'no me pierda', 'saber donde estoy', 'where i am'],
  },
  pvp: {
    p: ['1 ?v ?1', 'combate (?:por turnos|cuerpo a cuerpo)', 'melee', 'clicks? por segundo', 'hit ?boxes?', 'hit ?registration', 'knockback', 'crystal pvp', 'cpvp', 'lifesteal', 'hcf', 'kit ?battle', 'arenas? de pvp', 'torneos?', 'tournaments?', 'ranked', 'competitiv[oa]s?', 'competitive'],
  },
  cozy: { p: ['calid[oa]s?', 'warm', 'hogaren[oa]s?', 'homey', 'campo', 'countryside', 'rural', 'cottagecore', 'granja relajada', 'relaxed', 'sin estres', 'stress ?free', 'sin presion', 'low pressure', 'casual', 'chill vibes', 'comfy', 'comfort(?:able)?', 'comodo', 'tranquilidad'] },
  cartoon: { p: ['dibujo animado', 'toon', 'toony', 'comics?', 'comic book', 'cel ?shad[a-z]*', 'cell ?shad[a-z]*', 'manga', 'estilo anime', 'ghibli', 'infantil', 'kid ?friendly', 'para ninos', 'for kids', 'dibujado a mano', 'hand ?drawn', 'estilo comic'] },
  realistic: { p: ['pbr', 'parallax', 'pom', 'ray ?traced', 'fotograf[a-z]*', 'photographic', 'super realist[a-z]*', 'ultra realist[a-z]*', 'muy realista', 'como la vida real', 'real life', 'life ?like', 'vida real', 'hiperrealist[a-z]*', 'mejores? visuales', 'visuales (?:increibles|impresionantes|espectaculares)', 'graficos? (?:de nueva generacion|next gen|nextgen)', 'next ?gen', 'se vea (?:muy )?(?:bien|lindo|hermoso|real)', 'look (?:great|amazing|realistic|good|real)', 'impresionante', 'stunning', 'breathtaking', 'espectacular'] },
  darkui: { p: ['modo noche', 'night mode', 'interfaz negra', 'dark inventory', 'inventario oscuro', 'gui oscura', 'ui oscura', 'ui negra', 'pantallas? oscuras?', 'menus? oscuros?', 'tema negro', 'black theme', 'dark gui'] },
  sounds: { p: ['sonido', 'sound', 'ambient sounds?', 'sonidos? ambientes?', 'sonidos? realistas?', 'realistic sounds?', 'footsteps', 'pasos', 'sound physics', 'reverb', 'reverberacion', 'eco', 'echo', 'musica ambiental', 'ambient music', 'banda sonora', 'soundtrack', 'ost', 'discos? de musica', 'music discs?', 'musicas? de fundo', 'sonoro', 'audio realista', 'realistic audio', 'espacial', '3d audio'] },
  immersion: { p: ['mas vivo', 'more alive', 'living world', 'mundo vivo', 'detalles? (?:visuales|ambientales)', 'ambient details', 'animaciones de (?:jugador|mobs|criaturas)', 'player animations?', 'mob animations?', 'camera shake', 'bobbing', 'view bobbing', 'inmersion total', 'sentirse (?:real|vivo)', 'feel (?:real|alive)'] },
  economy: { p: ['sistema economico', 'compras? y ventas?', 'compra y venta', 'buy and sell', 'buying and selling', 'economic system', 'monedas? del servidor', 'server currency', 'tienda del servidor', 'server shop', 'chest ?shop', 'player shops?', 'tiendas? de jugadores', 'precios', 'prices', 'compraventa', 'trueque', 'barter', 'gemas? del servidor'] },
  servermgmt: {
    p: ['lista blanca', 'white ?lists?', 'baneos?', 'bans?', 'banear', 'kick', 'luck ?perms', 'world ?guard', 'core ?protect', 'grief ?prevention', 'chat (?:management|manager|filter)', 'filtro de chat', 'anti ?spam', 'anti ?bot', 'captcha', 'verificacion', 'verification',
      'discord (?:link|sync|integration)', 'integracion con discord', 'votifier', 'votos?', 'votes?', 'tienda de rangos', 'rank shop', 'motd', 'mensajes? de bienvenida', 'welcome messages?', 'bungee(?:cord)?', 'velocity', 'logs? de acciones', 'registro de acciones'],
  },
};

const add = [
  {
    id: 'adventuremaps',
    p: ['mapas? de aventuras?', 'adventure maps?', 'mapas? personalizad[oa]s?', 'custom maps?', 'mundos? (?:de )?(?:aventuras?|parkour|descargables?|prefabricados?|ya hechos?|hechos?|prediseñados?)', 'mundos? para descargar', 'downloadable worlds?',
      'pre ?made worlds?', 'worlds? (?:to|for) download', 'mapas? de (?:terror|parkour|puzzles?|escape)', 'escape rooms?', 'puzzle maps?', 'parkour maps?', 'mapas? de supervivencia', 'survival maps?', 'mundos? de (?:youtubers?|streamers?)', 'mapas? descargables?', 'mapas? jugables?'],
    q: { datapack: ['adventure map', 'custom map'], modpack: ['adventure map'], mod: ['adventure map'] },
    boost: { datapack: ['adventure', 'minigame'], modpack: ['adventure', 'quests'], mod: ['adventure'] },
    rel: ['exploration'],
    suppress: ['minimap'],
    types: ['datapack', 'modpack', 'mod'],
  },
  {
    id: 'pixelart',
    p: ['pixel ?art', 'pixelad[oa]s?', 'pixeles', 'pixels?', 'estilo pixel', 'pixel style', '8 ?bits?', '16 ?bits?', '8 ?bit', 'retro pixel', 'pixeleado', 'pixel perfect'],
    q: { resourcepack: ['pixel art', 'pixel'], shader: ['pixel'], mod: ['pixel'] },
    cat: { resourcepack: [['simplistic', 'themed']] },
    boost: { resourcepack: ['simplistic', '16x', '32x'], shader: ['cartoon'] },
    types: ['resourcepack', 'shader'],
  },
  {
    id: 'lowpoly',
    p: ['low ?poly', 'poligonos?', 'poligonal(?:es)?', 'polygon(?:al|s)?', 'geometric[oa]s?', 'faceted', 'facetad[oa]s?'],
    q: { resourcepack: ['low poly'], shader: ['low poly'], mod: ['low poly'] },
    boost: { resourcepack: ['simplistic', 'themed'], shader: ['cartoon'] },
    types: ['resourcepack', 'shader'],
  },
  {
    id: 'minimalist',
    p: ['minimalistas?', 'minimalis[a-z]*', 'minimal', 'simplificad[oa]s?', 'simplified', 'limpi[oa]s?', 'sencill[oa]s?', 'flat design', 'sin detalles', 'menos detalles', 'less detail', 'simple look', 'basic look'],
    q: { resourcepack: ['minimalist', 'simple', 'clean'], shader: ['minimal'], mod: ['minimal'] },
    cat: { resourcepack: [['simplistic']] },
    boost: { resourcepack: ['simplistic', 'vanilla-like', '16x'], shader: ['vanilla-like'] },
    types: ['resourcepack', 'shader'],
  },
  {
    id: 'futuristic',
    p: ['futurist[a-z]*', 'futuristic', 'futuro', 'future', 'ciencia ficcion', 'sci ?fi', 'science fiction', 'cyber ?punk', 'cyber[a-z]*', 'neon city', 'blade runner', 'ciberpunk', 'ficcao cientifica', 'dystopi[a-z]*', 'distopi[a-z]*', 'robotic world', 'mundo futuro'],
    q: { resourcepack: ['futuristic', 'sci-fi', 'cyberpunk'], shader: ['cyberpunk', 'neon'], mod: ['futuristic', 'sci-fi', 'cyberpunk'], modpack: ['sci-fi'] },
    boost: { mod: ['technology', 'decoration'], resourcepack: ['themed'], shader: ['fantasy', 'atmosphere'] },
    types: ['resourcepack', 'shader', 'mod'],
  },
  {
    id: 'steampunk',
    p: ['steam ?punk', 'steampunk', 'vapor', 'engranajes', 'gears?', 'clockwork', 'mecanismos? de reloj', 'victorian[oa]?s?', 'victorian', 'epoca victoriana', 'dieselpunk', 'diesel ?punk', 'industrial age', 'revolucion industrial'],
    q: { resourcepack: ['steampunk', 'victorian'], mod: ['steampunk', 'gears'], shader: ['steampunk'], modpack: ['steampunk'] },
    boost: { mod: ['technology', 'decoration', 'adventure'], resourcepack: ['themed'] },
    types: ['mod', 'resourcepack'],
  },
  {
    id: 'retro',
    p: ['retro', 'old ?school', 'clasic[oa]s? de antes', 'beta ?(?:1\\.7|1\\.8)?', 'minecraft (?:antiguo|viejo|clasico|original)', 'classic minecraft', 'old minecraft', '(?:viejas|antiguas|clasicas) de (?:antes|minecraft)', 'de antes', 'de la vieja escuela', 'old ?style', 'nostalgi[a-z]*', 'nostalgic', 'nostalgia',
      'infdev', 'indev', 'vintage', 'los viejos tiempos', 'the good old days', 'como antes', 'like (?:before|back then|the old days)', 'estilo antiguo', 'as in the past'],
    q: { resourcepack: ['retro', 'old'], shader: ['retro'], mod: ['retro', 'beta'] },
    cat: { resourcepack: [['vanilla-like', 'themed']] },
    boost: { resourcepack: ['vanilla-like', 'themed', '16x'], mod: ['utility'] },
    types: ['resourcepack', 'mod'],
  },
  {
    id: 'gothic',
    p: ['gotic[oa]s?', 'gothic', 'goth', 'dark(?:er)? (?:style|fantasy|theme|vibes?|atmosphere)', 'dark fantasy', 'fantasia oscura', 'dark souls', 'elden ring', 'bloodborne', 'soulslike', 'souls ?like', 'vampiric[oa]s?', 'vampiro', 'vampiros', 'vampires?', 'noche eterna', 'eternal night', 'sombri[oa]s?', 'gloomy', 'grim', 'grimdark', 'lugubre', 'melancolic[oa]s?', 'moody'],
    q: { resourcepack: ['gothic', 'dark'], shader: ['dark', 'moody'], mod: ['gothic', 'dark fantasy', 'vampire'], modpack: ['dark fantasy'] },
    boost: { mod: ['adventure', 'mobs', 'magic'], resourcepack: ['themed'], shader: ['atmosphere', 'fantasy'] },
    avoid: ['dark mode', 'dark ui', 'dark theme', 'dark gui'],
    types: ['mod', 'resourcepack', 'shader'],
  },
  {
    id: 'neon',
    p: ['neon', 'neones', 'fluorescent[a-z]*', 'fluorescente', 'brillantes?', 'glowing', 'resplandeciente', 'luces de neon', 'glow ?in ?the ?dark', 'synthwave', 'vaporwave', 'retrowave', 'outrun', 'rgb'],
    q: { resourcepack: ['neon', 'glow'], shader: ['neon', 'bloom'], mod: ['neon', 'glowing'] },
    boost: { shader: ['bloom', 'colored-lighting', 'cartoon'], resourcepack: ['themed'] },
    types: ['resourcepack', 'shader'],
  },
  {
    id: 'painterly',
    p: ['acuarela', 'watercolou?r', 'oleo', 'oil paint(?:ing)?', 'pintad[oa]s?', 'painted', 'painterly', 'pintura', 'impresionis[a-z]*', 'impressionis[a-z]*', 'artistic[oa]s?', 'artistic', 'estilo artistico', 'art style', 'dibujo', 'sketch', 'boceto', 'lapiz', 'pencil', 'van gogh', 'cuadro'],
    q: { resourcepack: ['painted', 'watercolor', 'artistic'], shader: ['painterly', 'watercolor', 'artistic'], mod: ['artistic'] },
    cat: { shader: [['cartoon', 'fantasy']] },
    boost: { shader: ['cartoon', 'fantasy', 'atmosphere'], resourcepack: ['themed', 'realistic'] },
    types: ['resourcepack', 'shader'],
  },
  {
    id: 'modern',
    p: ['moderno', 'moderna', 'modernos', 'modernas', 'modern', 'contemporane[oa]s?', 'contemporary', 'ciudad moderna', 'modern city', 'siglo xxi', 'actualidad', 'present day', 'rascacielos', 'skyscrapers?', 'apartamentos?', 'apartments?', 'departamentos?', 'oficinas?', 'offices?', 'calles?', 'streets?', 'carreteras?', 'roads?', 'autopistas?', 'highways?', 'semaforos?', 'traffic', 'trafico', 'supermercados?', 'supermarkets?', 'centro comercial'],
    q: { mod: ['modern', 'furniture', 'city', 'roads'], resourcepack: ['modern'], modpack: ['modern'], datapack: ['modern'] },
    boost: { mod: ['decoration', 'transportation', 'technology'], resourcepack: ['themed', 'decoration'] },
    types: ['mod', 'resourcepack'],
  },
  {
    id: 'recipes',
    p: ['jei', 'rei', 'emi', 'ver (?:las )?recetas', '(?:shows?|mostrar|muestr[ae]n?|display[a-z]*|ver|view) (?:the |las |los |me )?(?:recipes|recetas|crafteos?)', 'recetas en pantalla', 'recipe (?:viewer|lookup|browser|book)', 'visor de recetas', 'lista de (?:objetos|items)', 'item list', 'buscar (?:recetas|items|objetos)', 'search (?:recipes|items)', 'que se craftea con', 'what (?:can i craft|crafts into)', 'como se craftea', 'how to craft', 'crafting (?:guide|help)', 'guia de crafteo', 'libro de crafteo', 'enciclopedia', 'encyclopedia', 'wiki (?:in ?game|dentro del juego)', 'patchouli', 'guide ?book'],
    q: { mod: ['jei', 'rei', 'emi', 'recipe viewer', 'guidebook'], datapack: ['recipes'], resourcepack: ['recipes'] },
    boost: { mod: ['utility', 'library'], datapack: ['utility'] },
    types: ['mod'],
  },
  {
    id: 'enchanting',
    p: ['encantar', 'encantamiento', 'enchant(?:ing|ments?|ed|s)?', 'libros? encantados?', 'enchanted books?', 'mesa de encantamientos?', 'enchanting table', 'yunque', 'anvil', 'desencantar', 'disenchant', 'grindstone'],
    q: { mod: ['enchantments', 'enchanting'], datapack: ['enchantments'], resourcepack: ['enchant glint'] },
    boost: { mod: ['equipment', 'game-mechanics', 'magic'], datapack: ['game-mechanics', 'magic'] },
    types: ['mod', 'datapack'],
  },
  {
    id: 'villagers',
    p: ['aldeanos?', 'villagers?', 'aldeas? (?:mejoradas|nuevas|grandes)', 'better villages?', 'new villages?', 'pueblos? (?:de aldeanos|nuevos)', 'comercio con aldeanos', 'villager trading', 'iron golems?', 'golems? de hierro', 'saqueadores', 'pillagers?', 'raids?', 'asaltos?', 'invasiones?'],
    q: { mod: ['villagers', 'villages'], datapack: ['villagers', 'villages'], resourcepack: ['villagers'] },
    boost: { mod: ['mobs', 'game-mechanics', 'worldgen'], datapack: ['mobs', 'worldgen'] },
    types: ['mod', 'datapack'],
  },
  {
    id: 'progression',
    p: ['experiencia', 'skills?', 'habilidades', 'talentos', 'talents', 'clases', 'classes', 'progresion', 'progression', 'leveling', 'level ?up', 'subir de nivel', 'arbol de habilidades', 'skill tree', 'perks', 'mmorpg', 'mmo', 'mcmmo', 'attributes?', 'atributos', 'estadisticas', 'rpg mechanics', 'mecanicas de rpg', 'mejoras? de personaje', 'character progression'],
    q: { mod: ['skills', 'leveling', 'rpg'], modpack: ['rpg'], plugin: ['skills', 'mcmmo', 'leveling'], datapack: ['skills', 'leveling'] },
    boost: { mod: ['game-mechanics', 'adventure', 'equipment'], plugin: ['game-mechanics'], datapack: ['game-mechanics'] },
    types: ['mod', 'plugin', 'datapack'],
  },
  {
    id: 'survivalmech',
    p: ['sed', 'thirst', 'temperatura', 'temperature', 'hambre', 'hunger', 'fatiga', 'fatigue', 'stamina', 'resistencia fisica', 'enfermedades?', 'diseases?', 'cansancio', 'tiredness', 'insomnio', 'insomnia', 'sobrevivir al frio', 'hipotermia', 'hypothermia', 'sangrado', 'bleeding', 'heridas', 'wounds?', 'huesos rotos', 'broken bones', 'primeros auxilios', 'first aid', 'realismo de supervivencia', 'realistic survival', 'tough as nails', 'serene seasons', 'dehydration', 'deshidratacion'],
    q: { mod: ['thirst', 'temperature', 'survival', 'hunger'], datapack: ['thirst', 'temperature', 'survival'], modpack: ['survival'] },
    boost: { mod: ['game-mechanics', 'food'], datapack: ['game-mechanics'], modpack: ['challenging'] },
    types: ['mod', 'datapack'],
  },
  {
    id: 'ores',
    p: ['minerales?', 'ores?', 'vetas?', 'veins?', 'nuevos? minerales?', 'new ores?', 'diamantes?', 'diamonds?', 'esmeraldas?', 'emeralds?', 'netherita', 'netherite', 'cobre', 'copper', 'estano', 'plata', 'silver', 'rubies', 'rubi', 'zafiros?', 'sapphires?', 'gemas?', 'gems?', 'cristales?', 'crystals?', 'metales?', 'metals?', 'aleaciones?', 'alloys?', 'fundir', 'smelting', 'hornos?', 'furnaces?', 'forjar', 'forging'],
    q: { mod: ['ores', 'gems', 'metals'], datapack: ['ores'], resourcepack: ['ores'] },
    boost: { mod: ['worldgen', 'equipment', 'technology'], datapack: ['worldgen'], resourcepack: ['blocks'] },
    types: ['mod', 'resourcepack'],
  },
  {
    id: 'flora',
    p: ['arboles?', 'trees?', 'flores', 'flowers?', 'plantas', 'plants?', 'hojas', 'leaves', 'vegetacion', 'vegetation', 'jardineria', 'gardening', 'follaje', 'foliage', 'pasto', 'cesped', 'grass', 'musgo', 'moss', 'helechos?', 'ferns?', 'hongos?', 'mushrooms?', 'bambu', 'bamboo', 'cerezos?', 'cherry blossoms?', 'palmeras?', 'palm trees?', 'flora'],
    q: { mod: ['trees', 'flowers', 'plants'], resourcepack: ['foliage', 'leaves', 'flowers'], shader: ['foliage'], datapack: ['trees', 'flowers'] },
    boost: { mod: ['worldgen', 'decoration'], resourcepack: ['blocks', 'environment'], shader: ['foliage'] },
    types: ['mod', 'resourcepack', 'shader'],
  },
  {
    id: 'water',
    p: ['agua', 'water', 'aguas? cristalinas?', 'crystal clear water', 'cascadas?', 'waterfalls?', 'olas', 'waves', 'oceano', 'ocean', 'playas?', 'beach(?:es)?', 'costa', 'coast', 'arrecifes?', 'reefs?', 'coral', 'corales', 'buceo', 'diving', 'acuatic[oa]s?', 'aquatic', 'pesca submarina', 'agua realista', 'realistic water', 'reflejos en el agua', 'water reflections?'],
    q: { mod: ['water', 'ocean', 'aquatic'], shader: ['water'], resourcepack: ['water', 'ocean'], datapack: ['ocean'] },
    boost: { shader: ['reflections', 'atmosphere'], resourcepack: ['environment'], mod: ['worldgen', 'mobs'] },
    types: ['shader', 'resourcepack', 'mod'],
  },
  {
    id: 'sky',
    p: ['cielo', 'sky', 'cielos? (?:bonitos?|realistas?|estrellados?)', 'nubes', 'clouds?', 'luna', 'moon', 'estrellas', 'stars?', 'atardeceres?', 'sunsets?', 'amaneceres?', 'sunrises?', 'aurora', 'auroras', 'arcoiris', 'rainbows?', 'eclipses?', 'cometas?', 'comets?', 'cielo nocturno', 'night sky', 'volumetric clouds', 'nubes volumetricas', 'god rays', 'rayos de sol', 'sun rays', 'volumetric light'],
    q: { shader: ['sky', 'clouds'], resourcepack: ['sky', 'clouds'], mod: ['sky', 'clouds'] },
    boost: { shader: ['atmosphere', 'shadows', 'bloom'], resourcepack: ['environment'] },
    types: ['shader', 'resourcepack'],
  },
  {
    id: 'lighting',
    p: ['iluminacion', 'lighting', 'luces', 'lights?', 'luz dinamica', 'dynamic (?:lights?|lighting)', 'lamparas?', 'lamps?', 'linternas?', 'lanterns?', 'antorchas?', 'torches', 'velas', 'candles?', 'luz colorida', 'colou?red (?:lights?|lighting)', 'luces de colores', 'sombras suaves', 'soft shadows', 'shadows?', 'sombras', 'oscuridad', 'darkness', 'brillo', 'brightness', 'gamma', 'fullbright', 'full ?bright'],
    q: { mod: ['dynamic lights', 'lighting', 'lamps'], shader: ['lighting', 'shadows'], resourcepack: ['lighting'], datapack: ['lights'] },
    cat: { shader: [['colored-lighting', 'shadows']] },
    boost: { shader: ['colored-lighting', 'shadows', 'bloom'], mod: ['decoration', 'utility'] },
    types: ['mod', 'shader'],
  },
  {
    id: 'fonts',
    p: ['fuentes?', 'fonts?', 'tipografias?', 'typography', 'letras? (?:bonitas?|lindas?|grandes?|pixeladas?)', 'letra (?:bonita|linda|grande)', 'tipos? de letra', 'typefaces?', 'caligrafia', 'calligraphy', 'texto (?:mas )?(?:grande|legible|claro)', 'letra (?:mas )?(?:grande|legible|clara|bonita|linda)', 'legible', 'legibilidad', 'readability', 'legible text', 'readable text', 'big text', 'large text'],
    q: { resourcepack: ['fonts', 'font'], mod: ['fonts'] },
    cat: { resourcepack: [['fonts']] },
    boost: { resourcepack: ['fonts', 'gui'] },
    types: ['resourcepack'],
  },
  {
    id: 'locale',
    p: ['traduc[a-z]*', 'translat[a-z]*', 'idiomas?', 'languages?', 'lenguajes?', 'en espanol', 'in spanish', 'en castellano', 'em portugues', 'in portuguese', 'localiza[a-z]*', 'localiz[a-z]*', 'espanol latino', 'latin spanish', 'castellano', 'subtitulos?', 'subtitles?', 'idioma del juego'],
    q: { resourcepack: ['translation', 'spanish', 'language'], mod: ['translation', 'language'] },
    cat: { resourcepack: [['locale']] },
    boost: { resourcepack: ['locale'] },
    types: ['resourcepack'],
  },
  {
    id: 'accessibility',
    p: ['accesibilidad', 'accessibility', 'accesible', 'accessible', 'daltonismo', 'colou?r ?blind(?:ness)?', 'daltonic[oa]s?', 'alto contraste', 'high contrast', 'discapacidad', 'disability', 'disabilities', 'baja vision', 'low vision', 'vision reducida', 'visually impaired', 'ceguera', 'blindness', 'sordera', 'deaf', 'hard of hearing', 'subtitulos para sordos', 'lector de pantalla', 'screen readers?', 'narrador', 'narrator', 'text to speech', 'tts', 'movilidad reducida', 'one ?handed', 'una sola mano', 'a una mano', 'epilepsia', 'epilepsy', 'sin parpadeos', 'no flashing', 'photosensitiv[a-z]*', 'fotosensib[a-z]*'],
    q: { mod: ['accessibility', 'colorblind'], resourcepack: ['high contrast', 'accessibility', 'colorblind'] },
    cat: { resourcepack: [['utility']] },
    boost: { resourcepack: ['utility', 'gui', 'tweaks'], mod: ['utility'] },
    types: ['mod', 'resourcepack'],
  },
  {
    id: 'emotes',
    p: ['emotes?', 'emotes', 'emociones', 'bailes?', 'danc(?:e|es|ing)', 'bailar', 'gestos?', 'gestures?', 'saludar', 'poses?', 'posar', 'animaciones? del? (?:jugador|personaje)', 'player animations?', 'sentarse', 'acostarse', 'lay down', 'gatear', 'crawl(?:ing)?', 'agacharse', 'crouching', 'sprint animations?', 'flashmob', 'taunts?', 'burlas'],
    q: { mod: ['emotes', 'player animations', 'poses'], datapack: ['emotes'] },
    boost: { mod: ['utility', 'decoration', 'social'], datapack: ['utility'] },
    types: ['mod'],
  },
  {
    id: 'cosmetics',
    p: ['cosmeticos?', 'cosmetics?', 'capas?', 'capes?', 'sombreros?', 'hats?', 'clothes', 'clothing', 'outfits?', 'disfraces?', 'costumes?', 'accesorios?', 'accessories', 'mochilas? decorativas?', 'alas', 'wings', 'cuernos', 'horns', 'colas', 'tails?', 'orejas', 'ears', 'peinados?', 'hairstyles?', 'tatuajes?', 'tattoos?', 'skins? (?:de|para) (?:armadura|jugador)', 'player models?', 'modelos? de jugador', 'avatar', 'avatars?', 'personaliz[a-z]*', 'customi[sz][a-z]*', 'apariencia', 'appearance', 'look del personaje'],
    q: { mod: ['cosmetics', 'capes', 'hats', 'accessories'], resourcepack: ['cosmetics', 'armor'] },
    boost: { mod: ['decoration', 'equipment', 'utility'], resourcepack: ['equipment', 'models'] },
    types: ['mod', 'resourcepack'],
  },
  {
    id: 'models3d',
    p: ['3d', 'tres d', 'modelos? 3d', '3d models?', 'volumen', 'volumetric', 'hojas 3d', 'better leaves', 'hojas mejoradas', 'fresh animations', 'mob animations?', 'connected', 'conectad[oa]s?', 'ctm', 'bloques conectados', 'connected blocks?', 'emissive', 'emisivas?', 'emisiv[oa]s?', 'bumpy', 'relieve', 'bump mapping', 'modelos? de items?', 'item models?', 'items? 3d', 'bloques? 3d', 'blocks? 3d', 'cabezas', 'heads', 'sombras de bloques', 'detallad[oa]s?', 'detailed', 'alto detalle', 'high detail', 'mas detalles?', 'more detail'],
    q: { resourcepack: ['3d', 'models', 'better leaves'], mod: ['3d models', 'cit'], shader: ['pbr'] },
    cat: { resourcepack: [['models']] },
    boost: { resourcepack: ['models', 'entities', 'blocks', 'items'], mod: ['utility'] },
    types: ['resourcepack', 'mod'],
  },
];

module.exports = { extend, add };
