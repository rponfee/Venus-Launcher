'use strict';
// Openverse de mentira para capturas y pruebas de la interfaz (VENUS_PROFILEMUSIC_FAKE=1, solo con VENUS_DEVSHOT y la
// app sin empaquetar): contesta con el mismo formato que la API real y pasa por el mismo cliente, asi se ve todo el
// recorrido sin gastar cupo ni depender de internet. Los titulos y autores son inventados y los audios no existen.
//   VENUS_PROFILEMUSIC_FAKE=1       resultados de ejemplo
//   VENUS_PROFILEMUSIC_FAKE=limit   siempre 429 con Retry-After de 30 s (para ver el aviso del limite)
//   VENUS_PROFILEMUSIC_FAKE=empty   sin resultados

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ROWS = [
  ['Aurora pixelada', 'Estudio Lunaria', 'by-sa', '4.0', 'jamendo', 192, 'ambient/electronic'],
  ['Campamento nocturno', 'Dúo Cuarzo', 'by', '3.0', 'jamendo', 236, 'folk'],
  ['Redstone en la madrugada', 'Los Bloques', 'by-nd', '4.0', 'jamendo', 151, 'electronic/chiptune'],
  ['Mar de lava', 'Nube Cuántica', 'cc0', '1.0', 'wikimedia', 204, ''],
  ['Valle de los aldeanos', 'Quinteto Arcilla', 'by-sa', '3.0', 'wikimedia', 318, 'classical'],
  ['Viaje al End', 'Caracola Sonora', 'by', '4.0', 'jamendo', 267, 'ambient/chillout'],
  ['Mina abandonada', 'Eco de Piedra', 'by', '2.5', 'jamendo', 98, 'rock'],
  ['Pesca tranquila', 'Marea Baja', 'pdm', '1.0', 'wikimedia', 140, ''],
  ['Ciudad de cobre', 'Taller Tres', 'by-sa', '4.0', 'jamendo', 221, 'electronic'],
  ['Amanecer en la pradera', 'Trío Girasol', 'by', '4.0', 'jamendo', 175, 'piano/classical'],
  ['Cielo de ceniza', 'Fuego Lento', 'by-sa', '3.0', 'jamendo', 289, 'metal'],
  ['Puerto de madera', 'Brisa y Sal', 'by-nd', '3.0', 'jamendo', 133, 'reggae'],
];

const HEX = '0123456789abcdef';
function raw(row, i) {
  const [title, creator, license, version, source, seconds, genres] = row;
  const jam = source === 'jamendo';
  const kind = license === 'cc0' ? 'publicdomain/zero' : license === 'pdm' ? 'publicdomain/mark' : `licenses/${license}`;
  return {
    id: uuid(i + 1),
    title,
    creator,
    license,
    license_version: version,
    license_url: `https://creativecommons.org/${kind}/${version}/${jam ? '' : 'deed.en/'}`,
    source: jam ? 'jamendo' : 'wikimedia_audio',
    url: jam ? `https://prod-1.storage.jamendo.com/?trackid=${9_000_001 + i}&format=mp32` : `https://upload.wikimedia.org/wikipedia/commons/${HEX[i % 16]}/${HEX[i % 16]}${HEX[(i * 7) % 16]}/Demo_${i + 1}.ogg`,
    foreign_landing_url: jam ? `https://www.jamendo.com/track/${9_000_001 + i}` : `https://commons.wikimedia.org/w/index.php?curid=${9_000_001 + i}`,
    genres: genres ? genres.split('/') : [],
    duration: seconds * 1000,
    mature: false,
    unstable__sensitivity: [],
  };
}

function json(status, body, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

// Imita GET /v1/audio/: filtra por las palabras de q (en titulo, autor y generos) y por source
function fakeFetch(mode = '1') {
  return async (url) => {
    if (mode === 'limit') return json(429, { detail: 'Request was throttled. Expected available in 30 seconds.' }, { 'retry-after': '30' });
    const u = new URL(url);
    const words = (u.searchParams.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
    const sources = (u.searchParams.get('source') || '').split(',');
    const all = mode === 'empty' ? [] : ROWS.map(raw);
    const hit = all.filter((r) => sources.includes(r.source) && words.every((w) => `${r.title} ${r.creator} ${r.genres.join(' ')}`.toLowerCase().includes(w)));
    // Sin coincidencias por texto, una busqueda de ejemplo igual muestra algo (como pasa con palabras sueltas)
    const results = hit.length || mode === 'empty' ? hit : all.filter((r) => sources.includes(r.source));
    return json(200, { result_count: results.length, page_count: 1, page_size: 20, page: 1, results }, { 'x-ratelimit-available-anon_burst': '19', 'x-ratelimit-available-anon_sustained': '199' });
  };
}

module.exports = { fakeFetch, ROWS, raw };
