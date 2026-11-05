'use strict';
// Traducciones de sustantivos frecuentes (es / pt -> ingles) para las palabras sueltas del pedido: Modrinth esta casi
// todo en ingles, asi que "ardillas" se busca como "squirrels". Se suma a WORDS de lexicon.js (lo que ya existe no se
// pisa). Palabras ya normalizadas: minusculas, sin tildes ni signos. Para agregar una, una linea.

const WORDS = {
  // animales
  ardillas: 'squirrels', zorros: 'foxes', ranas: 'frogs', serpientes: 'snakes', cocodrilos: 'crocodiles', elefantes: 'elephants', leones: 'lions', tigres: 'tigers', jirafas: 'giraffes', monos: 'monkeys',
  pinguinos: 'penguins', delfines: 'dolphins', pulpos: 'octopus', cangrejos: 'crabs', mariposas: 'butterflies', conejos: 'rabbits', ovejas: 'sheep', cerdos: 'pigs', gallinas: 'chickens', ciervos: 'deer',
  buhos: 'owls', aguilas: 'eagles', murcielagos: 'bats', ratas: 'rats', tortugas: 'turtles', panteras: 'panthers', hipopotamos: 'hippos', rinocerontes: 'rhinos', cebras: 'zebras', canguros: 'kangaroos',
  pandas: 'pandas', loros: 'parrots', cuervos: 'crows', gaviotas: 'seagulls', ciempies: 'centipedes', escorpiones: 'scorpions', camaleones: 'chameleons', lagartos: 'lizards', salamandras: 'salamanders',
  coelhos: 'rabbits', raposas: 'foxes', sapos: 'frogs', cobras: 'snakes', tartarugas: 'turtles', morcegos: 'bats', corujas: 'owls', macacos: 'monkeys', ovelhas: 'sheep', porcos: 'pigs', galinhas: 'chickens', veados: 'deer',
  // fantasia y criaturas
  unicornios: 'unicorns', fenix: 'phoenix', grifos: 'griffins', centauros: 'centaurs', minotauros: 'minotaurs', trolls: 'trolls', goblins: 'goblins', duendes: 'goblins', gnomos: 'gnomes', krakens: 'krakens', kraken: 'kraken',
  liches: 'liches', necromantes: 'necromancers', paladines: 'paladins', chamanes: 'shamans', druidas: 'druids', arqueros: 'archers', guerreros: 'warriors', asesinos: 'assassins', cazadores: 'hunters',
  yetis: 'yetis', yeti: 'yeti', basiliscos: 'basilisks', quimeras: 'chimeras', hidras: 'hydras', gargolas: 'gargoyles', espectros: 'wraiths', banshees: 'banshees', elementales: 'elementals',
  unicornio: 'unicorn', ogros: 'ogres', ogro: 'ogre', cyclopes: 'cyclops', ciclopes: 'cyclops', sirenos: 'mermen', licantropo: 'werewolf', momia: 'mummy', calavera: 'skull', esqueleto: 'skeleton', fantasma: 'ghost',
  // edificios y lugares
  torres: 'towers', puentes: 'bridges', faros: 'lighthouses', molinos: 'windmills', cabanas: 'cabins', iglesias: 'churches', catedrales: 'cathedrals', piramides: 'pyramids', laberintos: 'mazes', tuneles: 'tunnels',
  minas: 'mines', portales: 'portals', puertas: 'doors', ventanas: 'windows', techos: 'roofs', escaleras: 'stairs', faroles: 'lanterns', velas: 'candles', antorchas: 'torches', cercas: 'fences', vallas: 'fences',
  fortalezas: 'fortresses', cuarteles: 'barracks', murallas: 'walls', acueductos: 'aqueducts', coliseos: 'colosseum', teatros: 'theaters', museos: 'museums', bibliotecas: 'libraries', tabernas: 'taverns', posadas: 'inns',
  mercados: 'markets', puertos: 'harbors', aeropuertos: 'airports', estaciones: 'stations', laboratorios: 'laboratories', bunkers: 'bunkers', refugios: 'shelters', pantanos: 'swamps',
  playas: 'beaches', praderas: 'meadows', sabanas: 'savannas', tundra: 'tundra', glaciares: 'glaciers', cascadas: 'waterfalls', arrecifes: 'reefs', abismos: 'abysses', oasis: 'oasis',
  castelo: 'castle', torre: 'tower', ponte: 'bridge', igreja: 'church', piramide: 'pyramid', labirinto: 'maze', tunel: 'tunnel', mina: 'mine', porta: 'door', janela: 'window', cabana: 'cabin',
  // objetos y materiales
  herramientas: 'tools', picos: 'pickaxes', palas: 'shovels', azadas: 'hoes', anillos: 'rings', collares: 'necklaces', coronas: 'crowns', libros: 'books', banderas: 'banners', pergaminos: 'scrolls',
  joyas: 'jewelry', relojes: 'clocks', instrumentos: 'instruments', guitarras: 'guitars', pianos: 'pianos', tambores: 'drums', madera: 'wood', piedra: 'stone', ladrillos: 'bricks', vidrio: 'glass', metal: 'metal',
  oro: 'gold', hierro: 'iron', plata: 'silver', obsidiana: 'obsidian', lava: 'lava', arena: 'sand', barro: 'mud', bambu: 'bamboo', cerezo: 'cherry', ceramica: 'ceramics', lana: 'wool', cuero: 'leather', papel: 'paper',
  ferramentas: 'tools', ouro: 'gold', ferro: 'iron', pedra: 'stone', madeira: 'wood', vidro: 'glass', areia: 'sand', livros: 'books', aneis: 'rings', coroas: 'crowns', joias: 'jewelry',
  // conceptos
  cumpleanos: 'birthday', bodas: 'wedding', escuelas: 'school', universidad: 'university', oficinas: 'offices', bomberos: 'firefighters', medicos: 'doctors', hospitales: 'hospitals', enfermedades: 'diseases',
  plagas: 'plague', epidemia: 'epidemic', pandemia: 'pandemic', virus: 'virus', carnaval: 'carnival', circo: 'circus', feria: 'fair', fiesta: 'party', fiestas: 'parties', pascua: 'easter',
  pesadillas: 'nightmares', suenos: 'dreams', misterio: 'mystery', misterios: 'mysteries', secretos: 'secrets', leyendas: 'legends', mitos: 'myths', cuentos: 'fairy tales', fabulas: 'fables', historias: 'stories',
  espias: 'spies', espia: 'spy', detectives: 'detectives', crimen: 'crime', crimenes: 'crimes', mafia: 'mafia', gangsters: 'gangsters', bandidos: 'bandits', cazarrecompensas: 'bounty hunters',
  gladiadores: 'gladiators', espartanos: 'spartans', troyanos: 'trojans', persas: 'persians', arabes: 'arabian', hindues: 'indian', mongoles: 'mongols', esquimales: 'inuit', africanos: 'african', tribales: 'tribal',
  // verbos y acciones como sustantivo
  volar: 'flying', nadar: 'swimming', escalar: 'climbing', trepar: 'climbing', saltar: 'jumping', correr: 'running', planear: 'gliding', teletransporte: 'teleport', teletransportacion: 'teleportation',
  cazar: 'hunting', domar: 'taming', criar: 'breeding', reproducir: 'breeding', fusionar: 'fusion', combinar: 'combining', reciclar: 'recycling', trueque: 'barter',
  // gente y roles
  jugadores: 'players', jugador: 'player', bebes: 'babies', ancianos: 'elders', reyes: 'kings', reinas: 'queens', principes: 'princes', princesas: 'princesses', nobles: 'nobles',
  campesinos: 'peasants', mercaderes: 'merchants', herreros: 'blacksmiths', alquimistas: 'alchemists', exploradores: 'explorers', aventureros: 'adventurers', mineros: 'miners', pescadores: 'fishermen', granjeros: 'farmers',
};

module.exports = { WORDS };
