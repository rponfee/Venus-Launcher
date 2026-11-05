'use strict';
// Vocabulario ampliado del Buscador inteligente. lexicon.js trae el nucleo (tipos, cargadores, temas...); esta
// carpeta suma sinonimos, jerga, errores de escritura y mas generos, siempre como DATOS: cada archivo es una lista
// que se agrega aca. Para entrenar el buscador con palabras nuevas se edita un archivo de esta carpeta, no el codigo.
//
//   types.js     tipos de contenido, negaciones y cantidades escritas con letras
//   loaders.js   cargadores, motores de shaders, software de servidor y "sin mods"
//   modes.js     modo de juego (servidor, con amigos, solo) y hardware (PC modesta o potente)
//   themes.js    generos, categorias, estilos visuales y mecanicas (sinonimos de temas y temas nuevos)
//   words.js     traducciones es/pt -> ingles de sustantivos sueltos
//   typos.js     errores de escritura frecuentes y correccion difusa
//   similar.js   "como X": proyectos y juegos conocidos que se toman de referencia
//   versions.js  rangos de version ("1.18 a 1.20", "1.19 o superior") y apodos de actualizaciones
//
// apply(L) lo llama lexicon.js al final, una sola vez, y agrega todo a sus estructuras (lo que ya existe no se pisa).
const types = require('./types');
const loaders = require('./loaders');
const modes = require('./modes');
const themes = require('./themes');
const words = require('./words');
const typos = require('./typos');
const similar = require('./similar');
const versions = require('./versions');

const uniq = (list) => [...new Set(list)];

// [clave, [alternativas]] -> suma las alternativas nuevas a la entrada de esa clave (la crea si falta)
function addAlternatives(entries, extra) {
  for (const [key, alts] of Object.entries(extra)) {
    let entry = entries.find(([k]) => k === key);
    if (!entry) {
      entry = [key, []];
      entries.push(entry);
    }
    for (const a of alts) if (!entry[1].includes(a)) entry[1].push(a);
  }
}

function extendTheme(L, id, def) {
  const theme = L.THEMES.find((th) => th.id === id);
  if (!theme) throw new Error(`vocab/themes.js: el tema "${id}" no existe en lexicon.js`);
  if (def.p) theme.p = uniq([...theme.p, ...def.p]);
  for (const key of ['q', 'boost']) {
    if (!def[key]) continue;
    theme[key] = theme[key] || {};
    for (const [type, list] of Object.entries(def[key])) theme[key][type] = uniq([...(theme[key][type] || []), ...list]);
  }
  if (def.cat) {
    theme.cat = theme.cat || {};
    for (const [type, lists] of Object.entries(def.cat)) {
      const have = (theme.cat[type] = theme.cat[type] || []);
      for (const cats of lists) if (!have.some((x) => x.join() === cats.join())) have.push(cats);
    }
  }
  for (const key of ['rel', 'types', 'avoid', 'avoidText', 'suppress']) if (def[key]) theme[key] = uniq([...(theme[key] || []), ...def[key]]);
}

function apply(L) {
  addAlternatives(L.TYPE_PATTERNS, types.TYPES);
  addAlternatives(L.LOADER_PATTERNS, loaders.LOADERS);
  addAlternatives(L.SHADER_LOADER_PATTERNS, loaders.SHADER_LOADERS);
  addAlternatives(L.SERVER_SOFTWARE_PATTERNS, loaders.SERVER_SOFTWARE);
  L.VANILLA_PATTERNS.push(...loaders.VANILLA.filter((a) => !L.VANILLA_PATTERNS.includes(a)));
  addAlternatives(L.MODE_PATTERNS, modes.MODES);
  L.LOWEND_PATTERNS.push(...modes.LOWEND.filter((a) => !L.LOWEND_PATTERNS.includes(a)));
  L.HIGHEND_PATTERNS.push(...modes.HIGHEND.filter((a) => !L.HIGHEND_PATTERNS.includes(a)));

  // Negaciones: las de lexicon.js mas las nuevas (siempre antes del tipo, con hasta dos palabras en el medio)
  const base = String(L.NEGATION.source).match(/\(\?:\^\|\\s\)\(\?:(.*?)\)\(\?:\\s\+/);
  const baseList = base ? base[1].split('|') : [];
  L.NEGATION = new RegExp(`(?:^|\\s)(?:${uniq([...baseList, ...types.NEGATIONS]).join('|')})(?:\\s+[a-z]+){0,2}\\s*$`);
  L.NUMBER_WORDS = types.NUMBER_WORDS;
  for (const word of Object.keys(types.NUMBER_WORDS)) L.STOPWORDS.add(word);

  for (const [id, def] of Object.entries(themes.extend)) extendTheme(L, id, def);
  for (const theme of themes.add) {
    if (L.THEMES.some((th) => th.id === theme.id)) throw new Error(`vocab/themes.js: el tema "${theme.id}" ya existe`);
    L.THEMES.push(theme);
  }
  for (const [word, en] of Object.entries(words.WORDS)) if (!Object.prototype.hasOwnProperty.call(L.WORDS, word)) L.WORDS[word] = en;

  L.LATEST_PATTERNS.push(...versions.LATEST.filter((a) => !L.LATEST_PATTERNS.includes(a)));
  L.NEGATION_SRC = uniq([...baseList, ...types.NEGATIONS]).join('|');
  L.fixTypos = typos.fix;
  L.versions = versions;
  L.SIMILAR = { markers: similar.MARKERS, projects: similar.PROJECTS };
  return L;
}

module.exports = { apply, types, loaders, modes, themes, words, typos, similar, versions };
