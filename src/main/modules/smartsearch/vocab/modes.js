'use strict';
// Vocabulario de MODO DE JUEGO y de HARDWARE (es / en / pt). Se suma al de lexicon.js (ver vocab/index.js).

// mode -> alternativas nuevas
const MODES = {
  server: [
    'servidor (?:privado|propio|personal|casero|local|de amigos|de la escuela)', 'private servers?', 'friends? servers?', 'home ?servers?',
    'mi (?:propio )?realm', 'montar (?:un )?(?:server|servidor)', 'host(?:ing|ear)? (?:un |a |my |mi )?(?:server|servidor)', 'servidor dedicado', 'dedicated servers?',
    'servidor para mis amigos', 'servidor de (?:la )?comunidad', 'community servers?', 'servidor survival', 'survival servers?', 'servidor creativo', 'creative servers?',
    'servidor (?:de )?(?:pvp|rol|rpg|minijuegos|hcf|kitpvp|bedwars|skywars|lifesteal|prison|vanilla|modded|modeado)', 'servidor com plugins',
    'para (?:administrar|moderar|gestionar) (?:mi |un |el )?(?:server|servidor)', 'minecraft server', 'servidor minecraft',
  ],
  multiplayer: [
    'realms?', 'lan ?party', 'en grupo', 'in a group', 'mis amigos y yo', 'mi (?:novi[oa]|hermano|hermana|pareja|amig[oa]|primo|prima) y yo', 'my friends and i', 'me and my (?:friends|brother|sister|girlfriend|boyfriend|cousin)', 'entre nosotros', 'queremos jugar', 'we want to play', 'jugamos', 'meu amigo e eu', 'meus amigos e eu', 'a gente quer', 'con la familia', 'con mi familia', 'en familia', 'with (?:the |my )?family', 'with my (?:parents|kids|children|cousins)', 'com (?:minha|a) familia', 'com meus (?:pais|filhos|primos)', 'con (?:mis )?(?:padres|hijos|primos|tios|abuelos|sobrinos)', 'con mi (?:equipo|team|clan|grupo|squad)', 'entre amigos',
    'jugar con (?:otros|gente|mas personas)', 'play with (?:others|people|more people)', 'con (?:otras personas|mas gente)', 'cooperacion', 'coop', 'cooperation',
    'pvp con amigos', 'competitiv[oa]s?', 'competitive', 'jugando con (?:amigos|mis amigos)', 'playing with (?:friends|my friends)', 'com a familia', 'em grupo',
    'con (?:mis )?compas', 'con mis colegas', 'con (?:los )?pibes', 'con (?:mis )?parceros', 'con la banda', 'with the squad', 'with my squad', 'with my crew', 'with my team',
  ],
  singleplayer: [
    'sin (?:internet|conexion|wifi|red|online)', 'offline', 'modo offline', 'sin estar online', 'juego (?:en )?(?:solitario|offline)', 'modo un jugador', 'one player', 'just me',
    'only me', 'solo yo', 'para mi solo', 'para mi sola', 'en mi mundo', 'in my world', 'survival (?:solo|en solitario)', 'solo play', 'sozinho no meu mundo', 'so eu',
    'single ?player world', 'my own world', 'mi propio mundo', 'sin amigos', 'no friends', 'nobody else', 'sin nadie mas', 'jogo offline',
  ],
};

// Hardware: PC modesta / PC potente. Las menciones numericas de RAM entran como "4 gb ram".
const LOWEND = [
  '(?:pc|compu|computadora|computador|laptop|notebook|netbook|ordenador|equipo|maquina)(?: [a-z]+){0,3} (?:vieja|viejo|lenta|lento|antigua|antiguo|humilde|modesta|modesto|fraca|fraco|velha|velho|mala|malo|obsoleta|obsoleto|limitada|limitado|basica|basico)',
  'pc (?:de )?(?:papa|patata|tomate|ladrillo|tostadora|abuela)', 'compu (?:de )?(?:papa|tostadora)', 'tostadora', 'toaster', 'potato pc', 'pc antigua', 'pc modesta',
  'computadora (?:vieja|antigua|lenta|humilde|modesta)', 'computador (?:velho|antigo|fraco)', 'equipo (?:viejo|lento|humilde|modesto|antiguo)', 'maquina (?:vieja|lenta|humilde)',
  'chromebook', 'intel hd', 'intel uhd', 'grafica integrada', 'graficos? integrad[oa]s?', 'integrated (?:graphics|gpu)', 'igpu', 'sin (?:placa|tarjeta) (?:de video|grafica|dedicada)',
  'sin gpu', 'no (?:dedicated )?gpu', 'poca ram', 'low ram', 'little ram', 'ram baja', 'pocos gigas', '[1-4] ?gb (?:de )?ram', '[1-4] gigas? de ram',
  'budget pc', 'cheap (?:pc|laptop)', 'old (?:laptop|computer|pc)', 'laptop (?:vieja|lenta|antigua)', 'notebook (?:fraca|velha|antiga)', 'pc velho', 'pc fraco', 'pc fraca',
  'sem placa de video', 'celeron', 'pentium', 'core 2 duo', 'dual core', 'i3', 'ryzen 3', 'mac (?:viejo|antiguo)', 'macbook (?:air|viejo)', 'raspberry',
  'pc de (?:oficina|escritorio basica)', 'office pc', 'school (?:pc|laptop)', 'compu de la (?:escuela|facultad)', 'netbook', 'minipc', 'mini pc',
];
const HIGHEND = [
  'pc (?:de )?(?:ultima generacion|alta gama|gama alta|tope de gama|bestial|monstruosa|de la nasa|de la muerte)', 'alta gama', 'gama alta', 'top ?end', 'rtx ?[2-5][0-9]{2,3}', 'gtx ?10[6-8]0',
  'rx ?[5-9][0-9]{3}', 'ryzen ?9', 'i9', '(?:16|24|32|64|128) ?gb (?:de )?ram', 'mucha ram', 'lots of ram', 'plenty of ram', 'beast (?:pc|machine|rig)', 'gaming (?:pc|rig|laptop)',
  'gaming rig', 'maquina potente', 'equipo potente', 'compu(?:tadora)? (?:gamer|potente|buena)', 'placa de video (?:buena|potente|nueva)', 'graphics card (?:is )?(?:good|powerful|new)', 'sobra (?:ram|potencia)',
  'potencia de sobra', 'power to spare', 'pc (?:forte|poderoso|poderosa|gamer)', 'computador (?:forte|potente)', '4090', '4080', '3090', '7800x3d',
];

module.exports = { MODES, LOWEND, HIGHEND };
