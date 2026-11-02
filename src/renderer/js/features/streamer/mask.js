// Modo streamer: tapa codigos de amigo y de pack (VENUS-XXXXXX, PACK-XXXXXX), IPs y direcciones de servidor
// en los textos de la interfaz (toasts). Copia de las reglas de src/main/modules/streamer/mask.js (el proceso
// principal es CommonJS y la pagina no lo puede cargar): si se cambia algo aca, cambiarlo alla tambien.
// Sin DOM, probado con node:test contra la copia del proceso principal (test/mask.test.js).

const DOT = '•';
export const CODE_MASK = DOT.repeat(6);

const FILE_EXT = new Set(['jar', 'zip', 'json', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'toml', 'cfg', 'conf', 'js', 'ts', 'exe', 'mrpack', 'log', 'md', 'yml', 'yaml', 'dat', 'nbt', 'mca', 'tar', 'gz', 'mp4', 'webm', 'mp3', 'ogg', 'wav', 'properties', 'lock', 'bak', 'old', 'tmp', 'html', 'css', 'svg', 'ico', 'dll', 'so', 'sh', 'bat', 'ps1', 'py', 'java', 'class', 'xml', 'csv', 'pdf']);

const RULES = [
  [/\b(VENUS|PACK)-[A-Z0-9]{6}\b/gi, (m, p) => `${p.toUpperCase()}-${CODE_MASK}`],
  [/(?<![\w.:-])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?::\d{2,5})?(?![\w.-]|\.\d)/g, `${DOT.repeat(3)}.${DOT.repeat(3)}.${DOT.repeat(3)}.${DOT.repeat(3)}`],
  [/(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])/gi, `${DOT.repeat(4)}:${DOT.repeat(4)}`],
  [/(?<![\w:])(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4}(?![\w:])/gi, `${DOT.repeat(4)}:${DOT.repeat(4)}`],
  [
    /(?<![\w.@/-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+)([a-z]{2,24})(:\d{2,5})?(?![\w.@/-])/gi,
    (m, labels, tld, port) => (FILE_EXT.has(tld.toLowerCase()) || !/[a-z]/i.test(labels) ? m : `${DOT.repeat(8)}.${tld.toLowerCase()}${port || ''}`),
  ],
];

export function maskText(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const [re, rep] of RULES) out = out.replace(re, rep);
  return out;
}
