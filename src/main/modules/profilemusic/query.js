'use strict';
// Arma el pedido a Openverse (GET /v1/audio/) a partir de lo que escribe la persona: texto, genero, duracion y
// fuente. Sin Electron. Todo valor que llega de la interfaz se vuelve a validar aca (la interfaz no es de fiar).
//
// Parametros usados (verificados con pedidos reales, ver docs/perfiles.md):
//   q            texto; la API busca en titulo, etiquetas y autor y exige todas las palabras
//   source       jamendo y/o wikimedia_audio
//   license      solo las que permiten uso comercial (by, by-sa, by-nd, cc0, pdm); nada de license_type=commercial
//                porque esa familia incluye "sampling+"
//   category     music (solo con Jamendo: Wikimedia no tiene categoria y quedaria afuera)
//   length       short (hasta ~2 min), medium (2 a 10 min) y long (mas de 10 min). "shortest" (hasta ~10 s) no se pide
//   extension    solo formatos que Chromium reproduce directo y livianos (sin wav ni flac)
//   page_size    20 (el maximo para pedidos anonimos)
const { LICENSE_IDS, SOURCES, cleanText } = require('./policy');

// Genero -> palabra que se busca (Jamendo etiqueta en ingles). Los que dan pocos resultados no se ofrecen.
const GENRES = Object.freeze({
  electronic: 'electronic',
  rock: 'rock',
  pop: 'pop',
  jazz: 'jazz',
  classical: 'classical',
  ambient: 'ambient',
  chillout: 'chillout',
  folk: 'folk',
  metal: 'metal',
  piano: 'piano',
  orchestral: 'orchestral',
  cinematic: 'cinematic',
  chiptune: 'chiptune',
  reggae: 'reggae',
  lofi: 'lofi',
});
const GENRE_IDS = Object.freeze(Object.keys(GENRES));

const LENGTHS = Object.freeze({ any: 'short,medium,long', short: 'short', medium: 'medium', long: 'long' });
const LENGTH_IDS = Object.freeze(Object.keys(LENGTHS));

// 'jamendo' (musica, por defecto), 'wikimedia' (grabaciones libres, mucha clasica) o 'both'
const SOURCE_CHOICES = Object.freeze({
  jamendo: [SOURCES.jamendo.api],
  wikimedia: [SOURCES.wikimedia.api],
  both: [SOURCES.jamendo.api, SOURCES.wikimedia.api],
});
const SOURCE_CHOICE_IDS = Object.freeze(Object.keys(SOURCE_CHOICES));

const PAGE_SIZE = 20;
const MAX_PAGE = 12; // la API no pasa de 240 resultados por busqueda
const MAX_TEXT = 100;
const EXTENSIONS = 'mp32,mp3,ogg,oga,opus';

function queryError(code) {
  return Object.assign(new Error(code), { code });
}

/**
 * input: { text?, genre?, length?, source?, page? } -> { params, key }
 * params: lo que va en la URL (objeto plano). key: texto estable para la cache (mismos filtros, misma clave).
 * Error con code 'bad_query' si no hay nada que buscar.
 */
function buildSearch(input) {
  const i = input && typeof input === 'object' ? input : {};
  const text = cleanText(typeof i.text === 'string' ? i.text : '', MAX_TEXT);
  const genre = GENRE_IDS.includes(i.genre) ? i.genre : '';
  const length = LENGTH_IDS.includes(i.length) ? i.length : 'any';
  const sourceChoice = SOURCE_CHOICE_IDS.includes(i.source) ? i.source : 'jamendo';
  const page = Math.max(1, Math.min(MAX_PAGE, Math.floor(Number(i.page)) || 1));
  const q = [text, genre ? GENRES[genre] : ''].filter(Boolean).join(' ').slice(0, 200);
  if (!q) throw queryError('bad_query');
  const sources = SOURCE_CHOICES[sourceChoice];
  const params = {
    q,
    source: sources.join(','),
    license: LICENSE_IDS.join(','),
    length: LENGTHS[length],
    extension: EXTENSIONS,
    page_size: String(PAGE_SIZE),
    page: String(page),
  };
  if (sources.length === 1 && sources[0] === SOURCES.jamendo.api) params.category = 'music';
  const key = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return { params, key, page, text, genre, length, source: sourceChoice };
}

module.exports = { GENRES, GENRE_IDS, LENGTHS, LENGTH_IDS, SOURCE_CHOICES, SOURCE_CHOICE_IDS, PAGE_SIZE, MAX_PAGE, MAX_TEXT, EXTENSIONS, buildSearch, queryError };
