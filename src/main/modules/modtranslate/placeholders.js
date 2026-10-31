'use strict';
// Marcadores que una traduccion tiene que conservar tal cual: %s, %d, %1$s, %.1f, %%, codigos de
// formato con §, {0}/{nombre}, etiquetas <b>, macros $(...) de los libros (Patchouli), &a y saltos de linea.

// Orden importante: primero los patrones mas largos/especificos.
const PATTERNS = [
  { kind: 'keybind', re: /%[a-z_]+(?:\.[a-z0-9_]+)+%/g },
  { kind: 'printf', re: /%(?:(\d+)\$)?[-#+0,(]*\d*(?:\.\d+)?([bBhHsScCdoxXeEfgGaAn%])/g },
  { kind: 'section', re: /§[0-9a-fk-orA-FK-ORxX]/g },
  { kind: 'amp', re: /(?<![A-Za-z0-9&])&[0-9a-fk-or](?=[A-Za-z0-9 [(])/g },
  { kind: 'brace', re: /\{[A-Za-z0-9_.:-]*\}/g },
  { kind: 'macro', re: /\$\([^()\s]*\)/g },
  { kind: 'tag', re: /<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*)?\/?>/g },
  { kind: 'newline', re: /\r?\n|\\n/g },
];

// Normaliza una etiqueta a su nombre ("<a href='x'>" -> "<a>") para no exigir atributos identicos.
function normTag(tok) {
  const m = /^<(\/?)([A-Za-z][\w:.-]*)/.exec(tok);
  const selfClose = /\/>$/.test(tok);
  return m ? `<${m[1]}${m[2].toLowerCase()}${selfClose ? '/' : ''}>` : tok;
}

// Devuelve los marcadores de un texto en orden de aparicion: [{ kind, token, positional }]
function extract(text) {
  const s = String(text ?? '');
  const found = [];
  const taken = new Array(s.length).fill(false);
  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      if (!m[0]) {
        re.lastIndex++;
        continue;
      }
      let overlap = false;
      for (let i = m.index; i < m.index + m[0].length; i++) {
        if (taken[i]) {
          overlap = true;
          break;
        }
      }
      if (overlap) continue;
      for (let i = m.index; i < m.index + m[0].length; i++) taken[i] = true;
      let token = m[0];
      if (kind === 'newline') token = '\\n';
      else if (kind === 'tag') token = normTag(token);
      else if (kind === 'section' || kind === 'amp') token = token.toLowerCase();
      found.push({ kind, token, index: m.index, positional: kind === 'printf' && Boolean(m[1]) });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

function countMap(list) {
  const m = new Map();
  for (const x of list) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

// Lista de marcadores "a conservar" (para pedirle a la IA que los respete).
function keepList(text) {
  return [...new Set(extract(text).map((p) => p.token))];
}

/**
 * Compara una traduccion con el original.
 * Devuelve { ok, reason, missing: [...], extra: [...] }.
 *   reason: 'empty' | 'placeholders' | 'order' | 'artifact'
 */
function validate(source, translation) {
  const src = String(source ?? '');
  const tr = typeof translation === 'string' ? translation : '';
  if (src.trim() && !tr.trim()) return { ok: false, reason: 'empty', missing: [], extra: [] };
  // Restos tipicos de una respuesta mal armada
  if (/^\s*\{\s*"(key|text)"\s*:/.test(tr) && !/^\s*\{\s*"/.test(src)) return { ok: false, reason: 'artifact', missing: [], extra: [] };
  const a = extract(src);
  const b = extract(tr);
  const ca = countMap(a.map((p) => p.token));
  const cb = countMap(b.map((p) => p.token));
  const missing = [];
  const extra = [];
  for (const [tok, n] of ca) for (let i = (cb.get(tok) || 0); i < n; i++) missing.push(tok);
  for (const [tok, n] of cb) for (let i = (ca.get(tok) || 0); i < n; i++) extra.push(tok);
  if (missing.length || extra.length) return { ok: false, reason: 'placeholders', missing, extra };
  // Los %s/%d sin numero se asignan en orden: ese orden no puede cambiar.
  const seqA = a.filter((p) => p.kind === 'printf' && !p.positional && p.token !== '%%').map((p) => p.token);
  const seqB = b.filter((p) => p.kind === 'printf' && !p.positional && p.token !== '%%').map((p) => p.token);
  if (seqA.join('\u0000') !== seqB.join('\u0000')) return { ok: false, reason: 'order', missing: [], extra: [] };
  return { ok: true, reason: null, missing: [], extra: [] };
}

module.exports = { extract, validate, keepList };
