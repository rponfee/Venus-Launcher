'use strict';
// Vocabulario de TIPOS de contenido, cantidades y negaciones (es / en / pt).
// Se suma al de lexicon.js al cargarlo (ver vocab/index.js). Para agregar palabras, sumá alternativas de expresion
// regular (sobre texto normalizado: minusculas, sin tildes ni signos) a la lista del tipo. Los guiones y
// apostrofes ya llegaron convertidos en espacios: "mini-juegos" = "mini juegos".

// type -> alternativas nuevas. "recursos" suelto no va: "pocos recursos" habla de la PC, no de texturas.
const TYPES = {
  modpack: [
    'paquetes? de modificaciones', 'conjuntos? de mods', 'packs? (?:de )?mods? (?:ya )?(?:armados?|listos?|hechos?)', 'pacotes? de mod',
    'mod ?pack', 'ready ?made packs?', 'curated packs?', 'prebuilt packs?', 'preconfigured packs?', 'pre ?made packs?', 'mods? bundles?',
    'colecao de mods', 'modpaks?',
  ],
  resourcepack: [
    'paquetes? de recurso', 'paquetes? visuales', 'visual packs?', 'texturizacion', 'retextur[a-z]*', 'pack de textura', 'packs? de textura',
    'pacotes? de recurso', 'texturas? (?:hd|4k|realistas?)', 'recursos de minecraft',
  ],
  shader: [
    'shaderpacks?', 'packs? de shaders?', 'paquetes? de shaders?', 'pacotes? de shaders?', 'shaders? de luz', 'chaders?', 'shader ?mods?',
    'iluminacion (?:realista|mejorada)', 'mejor iluminacion',
  ],
  datapack: ['data ?paks?', 'datapacks?', 'paquetes? de datos? (?:para|de) (?:el )?mundo'],
  plugin: [
    'plug ?ins?', 'extensiones? de servidor', 'addons? (?:de|para) (?:servidor|server)', 'complementos? (?:de|para) (?:paper|spigot|bukkit|purpur)',
    'plugins? de (?:paper|spigot|bukkit|purpur)', 'server plugins?', 'complementos? do servidor',
  ],
  mod: ['add ?ons?', 'extensiones? (?:para |de |del )?(?:el )?(?:juego|minecraft)', 'modzinhos?', 'modificadores', 'mods? (?:para|de) minecraft'],
};

// Negaciones que preceden a un tipo ("sin shaders", "nada de plugins", "no necesito modpacks").
// Se suman a las de lexicon.js. Cada una puede ir seguida de hasta dos palabras antes del tipo.
const NEGATIONS = [
  'ni', 'tampoco', 'evitar', 'evita', 'sin ningun', 'sin ninguna', 'no necesito', 'no me interesan?', 'no me gustan?', 'no uses', 'no pongas',
  'no incluyas?', 'no agregues?', 'sacar', 'saca', 'quitar', 'quita', 'ignora', 'olvidate de', 'sin necesidad de',
  'but not', 'minus', 'excluding', 'exclude', 'skip', 'avoid', 'do not want', 'don t want', 'dont want', 'i don t need', 'no thanks to', 'ignore',
  'nao quero', 'nao preciso de', 'sem nenhum', 'sem nenhuma', 'evite', 'tire',
];

// Cantidades escritas con letras: "cinco mods", "five shaders", "dez texturas". Se leen como el numero.
const NUMBER_WORDS = {
  dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12,
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  dois: 2, duas: 2, quatro: 4, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
};

module.exports = { TYPES, NEGATIONS, NUMBER_WORDS };
