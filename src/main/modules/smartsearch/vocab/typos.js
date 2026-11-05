'use strict';
// Errores de escritura frecuentes (es / en / pt) y correccion difusa contra el vocabulario propio.
// fix(texto normalizado) devuelve el texto con las palabras corregidas. Dos mecanismos:
//   EXACT   lista de errores conocidos -> palabra correcta (palabra suelta o frase de dos palabras)
//   CANON   palabras del vocabulario (largas, poco ambiguas) a las que se corrige una palabra desconocida que
//           difiera en 1 letra (2 si la palabra tiene 10 o mas): "optimisacion" -> "optimizacion".
// Para sumar un error nuevo alcanza con una linea en EXACT.

const EXACT = {
  // tipos
  shaderz: 'shaders', shadders: 'shaders', shaderes: 'shaders', sahders: 'shaders', shadres: 'shaders', shaer: 'shaders', shadder: 'shader', xaders: 'shaders', chaders: 'shaders', sheiders: 'shaders',
  modz: 'mods', mdos: 'mods', modss: 'mods', mosd: 'mods',
  modpak: 'modpack', modpaks: 'modpacks', modpakc: 'modpack', modapck: 'modpack', modpacs: 'modpacks', mdpack: 'modpack',
  texturass: 'texturas', textuas: 'texturas', texutras: 'texturas', texturs: 'texturas', textrues: 'textures', textrue: 'texture', texturaz: 'texturas', testuras: 'texturas',
  resourcepak: 'resourcepack', resourcepacs: 'resourcepacks', resorcepack: 'resourcepack', resoucepack: 'resourcepack', recoursepack: 'resourcepack', rsourcepack: 'resourcepack',
  datapak: 'datapack', datapaks: 'datapacks', dtapack: 'datapack',
  plugings: 'plugins', pluggins: 'plugins', plugns: 'plugins', plguins: 'plugins', plugn: 'plugin', pluing: 'plugin',
  // cargadores y motores
  fabrik: 'fabric', fabirc: 'fabric', fabrc: 'fabric', fabrci: 'fabric', farbic: 'fabric',
  forje: 'forge', forgee: 'forge', froge: 'forge', foge: 'forge',
  neoforje: 'neoforge', neofroge: 'neoforge', neoforg: 'neoforge', neofrge: 'neoforge',
  quil: 'quilt', qulit: 'quilt',
  optifin: 'optifine', optifne: 'optifine', optfine: 'optifine', optiefine: 'optifine',
  vainilla: 'vanilla', vanila: 'vanilla', vanilal: 'vanilla', vanillia: 'vanilla', vaniila: 'vanilla',
  minecrfat: 'minecraft', minecrat: 'minecraft', minecarf: 'minecraft', maincra: 'minecraft', mainkra: 'minecraft', minecrft: 'minecraft', mincraft: 'minecraft', minercraft: 'minecraft', minecraf: 'minecraft', maynkraft: 'minecraft',
  // rendimiento
  optimisacion: 'optimizacion', optimizasion: 'optimizacion', optimizcion: 'optimizacion', optimicacion: 'optimizacion', optmizacion: 'optimizacion', optimisation: 'optimization',
  fpss: 'fps', fsp: 'fps', rendimeinto: 'rendimiento', rendimento: 'rendimiento', rendiminto: 'rendimiento', perfomance: 'performance', performace: 'performance', preformance: 'performance', perfromance: 'performance',
  lagg: 'lag', laag: 'lag', laggy: 'lag', laguea: 'lag', lagueo: 'lag',
  // temas
  suprvivencia: 'supervivencia', supervivensia: 'supervivencia', supervibencia: 'supervivencia', supervivecia: 'supervivencia', suvivencia: 'supervivencia', survial: 'survival', survivla: 'survival', survaival: 'survival', suvival: 'survival',
  construcion: 'construccion', construccon: 'construccion', contruccion: 'construccion', consturccion: 'construccion', construsion: 'construccion', construcsion: 'construccion', buidling: 'building', biulding: 'building', bulding: 'building',
  aventuraz: 'aventuras', abentura: 'aventura', abenturas: 'aventuras', adveture: 'adventure', advneture: 'adventure', adventrue: 'adventure', adevnture: 'adventure',
  teror: 'terror', terrror: 'terror', horro: 'horror', horrro: 'horror', horor: 'horror', scarry: 'scary', scarey: 'scary',
  magiaa: 'magia', majia: 'magia', mgia: 'magia', magik: 'magic', majic: 'magic', magick: 'magic', mgic: 'magic',
  tecnolojia: 'tecnologia', tecnlogia: 'tecnologia', tecologia: 'tecnologia', tecnologa: 'tecnologia', technolgy: 'technology', tecnology: 'technology', technologie: 'technology',
  zonbies: 'zombies', zombeis: 'zombies', zomibes: 'zombies', zombei: 'zombie',
  dragonez: 'dragones', dragnes: 'dragones', dragonnes: 'dragones', draones: 'dragones', dragnos: 'dragons', dargons: 'dragons',
  medievl: 'medieval', medivales: 'medievales', medival: 'medieval', midieval: 'medieval', medeival: 'medieval', medevial: 'medieval',
  realsita: 'realista', realistaa: 'realista', realisata: 'realista', raelista: 'realista', realisitc: 'realistic', realisitic: 'realistic', realstic: 'realistic', relistic: 'realistic',
  minijuegoss: 'minijuegos', minihuegos: 'minijuegos', mijuegos: 'minijuegos', minigamse: 'minigames', minigmes: 'minigames', minigaems: 'minigames',
  multijugdor: 'multijugador', multijuagador: 'multijugador', multijugadr: 'multijugador', multiplyer: 'multiplayer', mutiplayer: 'multiplayer', multiplaer: 'multiplayer', multiplaye: 'multiplayer', multiplyr: 'multiplayer',
  singelplayer: 'singleplayer', singleplyer: 'singleplayer', singleplaer: 'singleplayer', sinlgeplayer: 'singleplayer', singlplayer: 'singleplayer',
  sevidor: 'servidor', servidr: 'servidor', servdor: 'servidor', sevrvidor: 'servidor', sevrer: 'server', srever: 'server', servr: 'server',
  mapaa: 'mapa', minimpa: 'minimapa', minimaap: 'minimap', miniampa: 'minimapa',
  cartun: 'cartoon', cartoom: 'cartoon', catroon: 'cartoon', cartonn: 'cartoon',
  fantacia: 'fantasia', fantasya: 'fantasia', fantsia: 'fantasia', fantsy: 'fantasy', fantacy: 'fantasy', fanatsy: 'fantasy',
  vikingoss: 'vikingos', bikingos: 'vikingos', viquingos: 'vikingos',
  piratass: 'piratas', pirtas: 'piratas', piratsa: 'piratas',
  granjaa: 'granja', granjs: 'granja', graja: 'granja',
  decoracin: 'decoracion', decoracon: 'decoracion', decorasion: 'decoracion', decoraion: 'decoracion', decroacion: 'decoracion',
  // palabras de pedido
  quiro: 'quiero', qiero: 'quiero', queiro: 'quiero', kiero: 'quiero', bsucame: 'buscame', buscm: 'buscame',
  necesto: 'necesito', nececito: 'necesito', necsito: 'necesito', nesecito: 'necesito',
  wnat: 'want', nedd: 'need', nede: 'need', lokking: 'looking', lookin: 'looking', luking: 'looking', serch: 'search', seach: 'search', saerch: 'search',
  // dos palabras
  'mod pak': 'modpack', 'mod pakc': 'modpack', 'mods pack': 'modpack', 'resource pak': 'resourcepack', 'recurso pack': 'resourcepack', 'sader pack': 'shaderpack',
  'mini juegoss': 'minijuegos', 'mini jeugos': 'minijuegos', 'multi jugador': 'multijugador', 'multi player': 'multiplayer', 'single plyaer': 'singleplayer',
};

// Palabras del vocabulario a las que se corrige por cercania. Largas (>= 7) para no pisar palabras reales cortas.
const CANON = [
  'shaders', 'modpacks', 'modpack', 'texturas', 'resourcepack', 'resourcepacks', 'datapacks', 'datapack', 'plugins', 'neoforge', 'optifine', 'vanilla', 'minecraft',
  'optimizacion', 'optimization', 'rendimiento', 'performance', 'supervivencia', 'construccion', 'aventura', 'aventuras', 'adventure', 'building', 'survival', 'tecnologia', 'technology',
  'multijugador', 'multiplayer', 'singleplayer', 'servidor', 'minijuegos', 'minigames', 'realista', 'realistas', 'realistic', 'cartoon', 'fantasia', 'fantasy', 'magia',
  'dragones', 'dragons', 'zombies', 'medieval', 'medievales', 'vikingos', 'piratas', 'terror', 'horror', 'decoracion', 'exploracion', 'exploration', 'mazmorras', 'dungeons',
  'inventario', 'inventory', 'minimapa', 'minimap', 'calidad', 'amigos', 'friends', 'versiones', 'economia', 'economy', 'automatizacion', 'automation', 'maquinas', 'machines',
  'animales', 'animals', 'monstruos', 'monsters', 'vehiculos', 'vehicles', 'espacio', 'cuevas', 'mapas', 'sonidos', 'animaciones', 'animations', 'ambientacion', 'atmosphere',
];
const CANON_SET = new Set(CANON);

// Distancia de edicion de Damerau-Levenshtein con tope (corta apenas se pasa de `max`).
function distance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, (prev2[j - 2] ?? Infinity) + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2.length = 0;
    prev2.push(...prev);
    prev = cur;
  }
  return prev[b.length];
}

function nearest(word, known) {
  if (word.length < 6 || known.has(word) || /[0-9.+]/.test(word)) return null;
  const max = word.length >= 10 ? 2 : 1;
  let best = null;
  let bestD = max + 1;
  let tie = false;
  for (const c of CANON) {
    const d = distance(word, c, max);
    if (d < bestD) {
      best = c;
      bestD = d;
      tie = false;
    } else if (d === bestD && d <= max && c !== best) tie = true;
  }
  return best && bestD <= max && !tie ? best : null;
}

// text: texto ya normalizado. known: Set de palabras conocidas del diccionario (no se corrigen).
function fix(text, known = CANON_SET) {
  const words = String(text || '').split(' ');
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const two = i + 1 < words.length ? `${w} ${words[i + 1]}` : null;
    if (two && Object.prototype.hasOwnProperty.call(EXACT, two)) {
      out.push(EXACT[two]);
      i++;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(EXACT, w)) out.push(EXACT[w]);
    else out.push(nearest(w, known) || w);
  }
  return out.join(' ');
}

module.exports = { EXACT, CANON, fix, distance, nearest };
