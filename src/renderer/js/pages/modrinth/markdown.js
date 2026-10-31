// Markdown -> DOM seguro para descripciones y changelogs (nunca innerHTML). Soporta titulos, parrafos,
// listas anidadas y de tareas, tablas, citas (con avisos [!NOTE]), codigo, links (afuera del launcher o,
// si son de Modrinth, dentro), imagenes https y HTML crudo: ese pasa por safeHtml de ui.js y las
// imagenes / videos embebidos se convierten en nodos propios.
import { h, icon, safeHtml } from '../../ui.js';
import { t } from '../../i18n.js';

const MAX_LINES = 20000;
const MODRINTH_LINK = /^https?:\/\/(?:www\.)?modrinth\.com\/(?:mod|modpack|resourcepack|shader|datapack|plugin|project)\/([\w.-]+)\/?(?:[#?].*)?$/i;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  laquo: '«', raquo: '»', bull: '•', middot: '·', deg: '°', times: '×', divide: '÷', rarr: '→', larr: '←', uarr: '↑', darr: '↓', harr: '↔',
  check: '✓', hearts: '♥', star: '☆', ensp: ' ', emsp: ' ', thinsp: ' ', zwj: '‍', zwnj: '‌', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', plusmn: '±', frac12: '½', frac14: '¼', frac34: '¾',
  sup2: '²', sup3: '³', iexcl: '¡', iquest: '¿', ntilde: 'ñ', Ntilde: 'Ñ', aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', uuml: 'ü',
};

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

// ---------- URLs, links e imagenes ----------

function resolveUrl(raw, ctx) {
  const url = decodeEntities(String(raw || '').trim()).replace(/^<|>$/g, '');
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/') && ctx.base) return ctx.base + url;
  return null;
}

function linkNode(rawUrl, children, ctx, title) {
  const url = resolveUrl(rawUrl, ctx);
  if (!url) return h('span', { class: 'mx-md-deadlink' }, children);
  const internal = url.match(MODRINTH_LINK);
  return h(
    'a',
    {
      href: url,
      title: title || url,
      rel: 'noopener noreferrer',
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (internal && ctx.onProject) ctx.onProject(internal[1]);
        else window.venus.app.openExternal(url).catch(() => {});
      },
    },
    children,
  );
}

function imageNode(rawSrc, alt, ctx, { width, height, title } = {}) {
  const url = resolveUrl(rawSrc, ctx);
  if (!url) return alt ? document.createTextNode(alt) : null;
  const src = url.replace(/^http:\/\//i, 'https://');
  const img = h('img', { src, alt: alt || '', title: title || alt || null, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', class: 'mx-md-img' });
  const w = parseInt(width, 10);
  const hh = parseInt(height, 10);
  if (w > 0 && w <= 4000) img.style.width = `${w}px`;
  else if (hh > 0 && hh <= 4000) img.style.height = `${hh}px`;
  img.addEventListener('error', () => img.classList.add('broken'), { once: true });
  const index = ctx.images.push({ url: src, title: alt || title || '' }) - 1;
  img.addEventListener('click', (e) => {
    if (e.target.closest('a') || !ctx.onImage) return;
    ctx.onImage(ctx.images, index);
  });
  return img;
}

// ---------- HTML crudo ----------

function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

function mediaNode(m, ctx) {
  if (m.kind === 'hr') return h('hr');
  if (m.kind === 'img') {
    const img = imageNode(m.attrs.src, m.attrs.alt, ctx, { width: m.attrs.width, height: m.attrs.height, title: m.attrs.title });
    if (!img) return null;
    return m.href ? linkNode(m.href, [img], ctx) : img;
  }
  const url = resolveUrl(m.attrs.src, ctx);
  if (!url) return null;
  const yt = url.match(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=|shorts\/)|youtu\.be\/)([\w-]{6,})/i);
  if (yt) {
    return linkNode(
      `https://www.youtube.com/watch?v=${yt[1]}`,
      [
        h(
          'span',
          { class: 'mx-md-video' },
          h('img', { src: `https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg`, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }),
          h('span', { class: 'mx-md-play' }, icon('play')),
          h('span', { class: 'mx-md-video-label' }, t('modrinth.watchVideo')),
        ),
      ],
      ctx,
    );
  }
  return h('p', {}, linkNode(url, [icon('external'), ' ', m.kind === 'video' ? t('modrinth.watchVideo') : t('modrinth.openEmbed')], ctx));
}

// Convierte HTML externo en nodos: el texto y las etiquetas basicas pasan por safeHtml; imagenes,
// imagenes con link, videos e iframes se reemplazan antes por marcadores y se crean aparte.
export function htmlNodes(html, ctx) {
  const media = [];
  const mark = (m) => `\u0000${media.push(m) - 1}\u0000`;
  let src = String(html || '').replace(/<!--[\s\S]*?(-->|$)/g, '');
  // estructura que safeHtml no conserva: se pasa a etiquetas equivalentes que si conserva
  src = src
    .replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi, '<p><b>$1</b></p>')
    .replace(/<(div|center|section|article|figure|figcaption)\b[^>]*>/gi, '<p>')
    .replace(/<\/(div|center|section|article|figure|figcaption)>/gi, '</p>')
    .replace(/<h[56]\b[^>]*>/gi, '<h4>')
    .replace(/<\/h[56]>/gi, '</h4>')
    .replace(/<\/t[dh]>\s*(?=<t[dh]\b)/gi, ' · ')
    .replace(/<\/tr>/gi, '<br>');
  src = src.replace(/<a\b([^>]*)>\s*(<img\b[^>]*>)\s*<\/a>/gi, (all, a, img) => mark({ kind: 'img', attrs: attrs(img), href: attrs(a).href }));
  src = src.replace(/<img\b[^>]*>/gi, (img) => mark({ kind: 'img', attrs: attrs(img) }));
  src = src.replace(/<iframe\b([^>]*)>(?:[\s\S]*?<\/iframe>)?/gi, (all, a) => mark({ kind: 'iframe', attrs: attrs(a) }));
  src = src.replace(/<video\b([^>]*)>([\s\S]*?)<\/video>/gi, (all, a, inner) => {
    const at = attrs(a);
    if (!at.src) at.src = attrs((inner.match(/<source\b[^>]*>/i) || [''])[0]).src;
    return mark({ kind: 'video', attrs: at });
  });
  src = src.replace(/<hr\b[^>]*>/gi, () => mark({ kind: 'hr' }));
  const out = [];
  const parts = src.split(/\u0000(\d+)\u0000/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const node = mediaNode(media[Number(part)], ctx);
      if (node) out.push(node);
      return;
    }
    if (!part.trim()) return;
    out.push(...safeHtml(part).childNodes);
  });
  return [...out];
}

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul', 'iframe', 'video', 'picture', 'source', 'br', 'font', 'span', 'b', 'strong',
]);

const VOID_TAGS = new Set(['br', 'img', 'hr', 'wbr', 'source', 'input']);

function readInlineHtml(text, i) {
  const m = text.slice(i).match(/^<(\/?)([a-zA-Z][\w-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/);
  if (!m) return null;
  const tag = m[2].toLowerCase();
  const open = m[0];
  if (m[1]) return { html: '', end: i + open.length };
  if (VOID_TAGS.has(tag) || m[3]) return { html: open, end: i + open.length };
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = i + open.length;
  let depth = 1;
  let mm;
  while ((mm = re.exec(text))) {
    depth += mm[1] ? -1 : 1;
    if (depth === 0) return { html: text.slice(i, re.lastIndex), end: re.lastIndex };
  }
  return { html: open, end: i + open.length };
}

// ---------- Inline ----------

function matchEmphasis(text, i) {
  const rest = text.slice(i);
  const prev = i > 0 ? text[i - 1] : ' ';
  let m;
  if ((m = rest.match(/^~~(?=\S)([\s\S]*?\S)~~/))) return { end: i + m[0].length, make: (ctx) => h('del', {}, inline(m[1], ctx)) };
  if ((m = rest.match(/^(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/)) && !(m[1][0] === '_' && /\w/.test(prev))) {
    return { end: i + m[0].length, make: (ctx) => h('strong', {}, h('em', {}, inline(m[2], ctx))) };
  }
  if ((m = rest.match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/)) && !(m[1][0] === '_' && (/\w/.test(prev) || /\w/.test(text[i + m[0].length] || '')))) {
    return { end: i + m[0].length, make: (ctx) => h('strong', {}, inline(m[2], ctx)) };
  }
  if ((m = rest.match(/^\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/))) return { end: i + m[0].length, make: (ctx) => h('em', {}, inline(m[1], ctx)) };
  if (!/\w/.test(prev) && (m = rest.match(/^_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/))) return { end: i + m[0].length, make: (ctx) => h('em', {}, inline(m[1], ctx)) };
  return null;
}

function parseLink(text, i, ctx) {
  let depth = 0;
  let j = i;
  for (; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') {
      j++;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (j >= text.length) return null;
  const label = text.slice(i + 1, j);
  const k = j + 1;
  if (text[k] === '(') {
    let p = k + 1;
    while (text[p] === ' ' || text[p] === '\n') p++;
    let url = '';
    if (text[p] === '<') {
      const close = text.indexOf('>', p);
      if (close < 0) return null;
      url = text.slice(p + 1, close);
      p = close + 1;
    } else {
      const start = p;
      let par = 0;
      for (; p < text.length; p++) {
        const ch = text[p];
        if (ch === '\\') {
          p++;
          continue;
        }
        if (/\s/.test(ch)) break;
        if (ch === '(') par++;
        else if (ch === ')') {
          if (par === 0) break;
          par--;
        }
      }
      url = text.slice(start, p);
    }
    while (text[p] === ' ' || text[p] === '\n') p++;
    let title = '';
    if (text[p] === '"' || text[p] === "'" || (text[p] === '(' && url)) {
      const closeCh = text[p] === '(' ? ')' : text[p];
      const end = text.indexOf(closeCh, p + 1);
      if (end < 0) return null;
      title = text.slice(p + 1, end);
      p = end + 1;
      while (text[p] === ' ') p++;
    }
    if (text[p] !== ')') return null;
    return { label, url, title, end: p + 1 };
  }
  let ref = label;
  let end = j + 1;
  if (text[k] === '[') {
    const close = text.indexOf(']', k + 1);
    if (close < 0) return null;
    ref = text.slice(k + 1, close) || label;
    end = close + 1;
  }
  const def = ctx.defs[ref.trim().toLowerCase().replace(/\s+/g, ' ')];
  return def ? { label, url: def.url, title: def.title, end } : null;
}

export function inline(text, ctx) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(document.createTextNode(decodeEntities(buf)));
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\') {
      if (text[i + 1] === '\n') {
        flush();
        out.push(h('br'));
        i += 2;
        continue;
      }
      if (i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1])) {
        buf += text[i + 1];
        i += 2;
        continue;
      }
    }
    if (c === '\n') {
      if (/ {2,}$/.test(buf)) {
        buf = buf.replace(/ +$/, '');
        flush();
        out.push(h('br'));
      } else buf = `${buf.replace(/ +$/, '')} `;
      i++;
      continue;
    }
    if (c === '`') {
      const run = text.slice(i).match(/^`+/)[0];
      const close = text.indexOf(run, i + run.length);
      if (close > i) {
        flush();
        out.push(h('code', {}, text.slice(i + run.length, close).replace(/\n/g, ' ').replace(/^ (.+) $/, '$1')));
        i = close + run.length;
      } else {
        buf += run;
        i += run.length;
      }
      continue;
    }
    if (c === '!' && text[i + 1] === '[') {
      const r = parseLink(text, i + 1, ctx);
      if (r) {
        flush();
        const img = imageNode(r.url, decodeEntities(r.label.replace(/[*_`]/g, '')), ctx, { title: r.title });
        if (img) out.push(img);
        i = r.end;
        continue;
      }
    }
    if (c === '[') {
      const r = parseLink(text, i, ctx);
      if (r) {
        flush();
        out.push(linkNode(r.url, inline(r.label, ctx), ctx, r.title));
        i = r.end;
        continue;
      }
    }
    if (c === '<') {
      const rest = text.slice(i);
      let m = rest.match(/^<((?:https?:\/\/)[^\s<>]+)>/i);
      if (m) {
        flush();
        out.push(linkNode(m[1], [m[1]], ctx));
        i += m[0].length;
        continue;
      }
      m = rest.match(/^<!--[\s\S]*?-->/);
      if (m) {
        i += m[0].length;
        continue;
      }
      const tag = readInlineHtml(text, i);
      if (tag) {
        flush();
        if (/^<br\b/i.test(tag.html)) out.push(h('br'));
        else if (tag.html) out.push(...htmlNodes(tag.html, ctx));
        i = tag.end;
        continue;
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      const em = matchEmphasis(text, i);
      if (em) {
        flush();
        out.push(em.make(ctx));
        i = em.end;
        continue;
      }
    }
    if ((c === 'h' || c === 'H') && (i === 0 || /[\s(*_~>]/.test(text[i - 1]))) {
      const m = text.slice(i).match(/^https?:\/\/[^\s<>"]+/i);
      if (m) {
        let url = m[0].replace(/[.,:;!?'"*_~]+$/, '');
        while (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
        flush();
        out.push(linkNode(url, [url], ctx));
        i += url.length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

// ---------- Bloques ----------

const RE = {
  fence: /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/,
  heading: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/,
  hr: /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/,
  quote: /^ {0,3}>/,
  setext1: /^ {0,3}=+[ \t]*$/,
  setext2: /^ {0,3}-+[ \t]*$/,
  def: /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/,
};

const isBlank = (line) => !line || !line.trim();
const indentOf = (line) => line.match(/^ */)[0].length;

function htmlBlockStart(line) {
  if (/^ {0,3}<!--/.test(line)) return true;
  const m = line.match(/^ {0,3}<\/?([a-zA-Z][\w-]*)(?=[\s/>]|$)/);
  return Boolean(m && BLOCK_TAGS.has(m[1].toLowerCase()));
}

function matchItem(line) {
  let m = line.match(/^( *)([-*+])( +|$)(.*)$/);
  if (m && !RE.hr.test(line)) {
    const spaces = m[3].length > 4 || !m[3].length ? 1 : m[3].length;
    return { indent: m[1].length, ordered: false, start: 1, text: m[4], content: m[1].length + 1 + spaces };
  }
  m = line.match(/^( *)(\d{1,9})([.)])( +|$)(.*)$/);
  if (m) {
    const spaces = m[4].length > 4 || !m[4].length ? 1 : m[4].length;
    return { indent: m[1].length, ordered: true, start: parseInt(m[2], 10), text: m[5], content: m[1].length + m[2].length + 1 + spaces };
  }
  return null;
}

function startsBlock(line, inParagraph = false) {
  if (RE.fence.test(line) || RE.heading.test(line) || RE.hr.test(line) || RE.quote.test(line) || htmlBlockStart(line)) return true;
  const item = matchItem(line);
  if (!item || item.indent > 3) return false;
  if (!inParagraph) return true;
  // dentro de un parrafo solo lo cortan listas con texto (y las numeradas si empiezan en 1)
  return Boolean(item.text.trim()) && (!item.ordered || item.start === 1);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let code = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') {
      cur += '|';
      k++;
      continue;
    }
    if (ch === '`') code = !code;
    if (ch === '|' && !code) {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

function isTableSep(line) {
  if (!line || !line.includes('-') || !/^[\s|:-]+$/.test(line)) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c)) && (line.includes('|') || cells.length > 1);
}

function isTableStart(lines, i) {
  return lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]) && splitRow(lines[i]).length === splitRow(lines[i + 1]).length;
}

function heading(level, text, ctx) {
  return h(`h${Math.min(6, level)}`, { class: 'mx-md-h' }, inline(text.trim(), ctx));
}

const ALERTS = { note: ['info', 'info'], tip: ['good', 'sparkles'], important: ['info', 'alert'], warning: ['', 'alert'], caution: ['bad', 'alert'] };

function parseBlocks(lines, ctx, depth = 0) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    // codigo con cercas
    let m = line.match(RE.fence);
    if (m) {
      const fence = m[1];
      const indent = indentOf(line);
      const code = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(lines[i])) {
        code.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''));
        i++;
      }
      i++;
      out.push(h('pre', { class: 'mx-md-pre' }, h('code', {}, code.join('\n'))));
      continue;
    }
    // comentario HTML
    if (/^\s*<!--/.test(line)) {
      while (i < lines.length && !lines[i].includes('-->')) i++;
      i++;
      continue;
    }
    m = line.match(RE.heading);
    if (m) {
      out.push(heading(m[1].length, m[2] || '', ctx));
      i++;
      continue;
    }
    if (RE.hr.test(line)) {
      out.push(h('hr'));
      i++;
      continue;
    }
    if (RE.quote.test(line)) {
      const inner = [];
      while (i < lines.length && !isBlank(lines[i])) {
        if (RE.quote.test(lines[i])) inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
        else if (!startsBlock(lines[i], true)) inner.push(lines[i]);
        else break;
        i++;
      }
      const alert = (inner[0] || '').match(/^\s*\[!(note|tip|important|warning|caution)\]\s*$/i);
      if (alert && depth < 8) {
        const [kind, ic] = ALERTS[alert[1].toLowerCase()];
        out.push(h('div', { class: ['notice', kind, 'mx-md-alert'] }, icon(ic), h('div', {}, parseBlocks(inner.slice(1), ctx, depth + 1))));
      } else out.push(h('blockquote', {}, depth < 8 ? parseBlocks(inner, ctx, depth + 1) : inner.join(' ')));
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = splitRow(lines[i]);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const s = c.trim();
        if (s.startsWith(':') && s.endsWith(':')) return 'center';
        if (s.endsWith(':')) return 'right';
        return s.startsWith(':') ? 'left' : null;
      });
      const rows = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|') && !startsBlock(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const cell = (tag, txt, k) => h(tag, { style: aligns[k] ? { textAlign: aligns[k] } : null }, inline((txt || '').trim(), ctx));
      out.push(
        h(
          'div',
          { class: 'mx-md-table-wrap' },
          h('table', { class: 'mx-md-table' }, h('thead', {}, h('tr', {}, header.map((c, k) => cell('th', c, k)))), h('tbody', {}, rows.map((r) => h('tr', {}, header.map((_, k) => cell('td', r[k], k)))))),
        ),
      );
      continue;
    }
    const item = matchItem(line);
    if (item && item.indent <= 3 && depth < 12) {
      const r = parseList(lines, i, ctx, depth);
      out.push(r.node);
      i = r.next;
      continue;
    }
    if (htmlBlockStart(line)) {
      const buf = [];
      while (i < lines.length && !isBlank(lines[i])) buf.push(lines[i++]);
      const html = buf.join('\n');
      const nodes = htmlNodes(html, ctx);
      if (nodes.length) out.push(/align\s*=\s*["']?center|<center\b/i.test(html) ? h('div', { class: 'mx-md-center' }, nodes) : h('div', { class: 'mx-md-html' }, nodes));
      continue;
    }
    if (/^ {4}/.test(line)) {
      const code = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]) || isBlank(lines[i]))) code.push(lines[i++].slice(4));
      while (code.length && !code[code.length - 1].trim()) code.pop();
      out.push(h('pre', { class: 'mx-md-pre' }, h('code', {}, code.join('\n'))));
      continue;
    }
    // parrafo (o titulo con subrayado)
    const buf = [];
    let node = null;
    while (i < lines.length && !isBlank(lines[i])) {
      const l = lines[i];
      if (buf.length) {
        if (RE.setext1.test(l) || RE.setext2.test(l)) {
          node = heading(RE.setext1.test(l) ? 1 : 2, buf.join(' '), ctx);
          i++;
          break;
        }
        if (startsBlock(l, true) || isTableStart(lines, i)) break;
      }
      buf.push(l.replace(/^ +/, ''));
      i++;
    }
    out.push(node || h('p', {}, inline(buf.join('\n'), ctx)));
  }
  return out;
}

function parseList(lines, start, ctx, depth) {
  const first = matchItem(lines[start]);
  const base = first.indent;
  const items = [];
  let cur = null;
  let loose = false;
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j])) j++;
      if (j >= lines.length || !cur) break;
      const next = lines[j];
      const nm = matchItem(next);
      if (nm && nm.ordered === first.ordered && nm.indent <= base + 1) {
        loose = true;
        i = j;
        continue;
      }
      if (indentOf(next) >= cur.content) {
        cur.lines.push('');
        cur.blank = true;
        i++;
        continue;
      }
      break;
    }
    const m = matchItem(line);
    if (m && m.indent <= base + 1) {
      if (m.ordered !== first.ordered) break;
      cur = { lines: [m.text], content: m.content, blank: false };
      items.push(cur);
      i++;
      continue;
    }
    if (!cur) break;
    const ind = indentOf(line);
    if (ind >= cur.content || (m && ind > base)) {
      cur.lines.push(line.slice(Math.min(ind, cur.content)));
      i++;
      continue;
    }
    if (!startsBlock(line, true) && !isBlank(cur.lines[cur.lines.length - 1] || '')) {
      cur.lines.push(line.trim());
      i++;
      continue;
    }
    break;
  }
  const list = h(first.ordered ? 'ol' : 'ul', first.ordered && first.start !== 1 ? { start: first.start } : {});
  for (const it of items) {
    let task = null;
    const tm = it.lines[0].match(/^\[([ xX])\]\s+(.*)$/);
    if (tm) {
      task = tm[1] !== ' ';
      it.lines[0] = tm[2];
    }
    const children = parseBlocks(it.lines, ctx, depth + 1);
    let content = children;
    if (!loose && !it.blank && children[0]?.tagName === 'P') content = [...children[0].childNodes, ...children.slice(1)];
    list.append(
      h(
        'li',
        { class: task !== null ? 'mx-md-task' : null },
        task !== null ? h('span', { class: ['mx-md-check', task && 'on'], role: 'img', 'aria-label': task ? t('modrinth.taskDone') : t('modrinth.taskPending') }, task ? icon('check') : null) : null,
        content,
      ),
    );
  }
  return { node: list, next: i };
}

// Junta las definiciones de links de referencia ([id]: https://...) y las quita del texto.
function collectDefs(lines, ctx) {
  let fence = null;
  return lines.filter((line) => {
    const f = line.match(RE.fence);
    if (f) fence = fence ? (line.trim().startsWith(fence) ? null : fence) : f[1];
    if (fence) return true;
    const m = line.match(RE.def);
    if (!m) return true;
    const key = m[1].trim().toLowerCase().replace(/\s+/g, ' ');
    if (!ctx.defs[key]) ctx.defs[key] = { url: m[2], title: m[3] ?? m[4] ?? m[5] ?? '' };
    return false;
  });
}

// options: { base, onImage(images, index), onProject(slug), class }
export function renderMarkdown(src, options = {}) {
  const ctx = { defs: {}, base: options.base === undefined ? 'https://modrinth.com' : options.base, onImage: options.onImage, onProject: options.onProject, images: [] };
  const lines = String(src || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n').slice(0, MAX_LINES);
  const root = h('div', { class: ['rich', 'selectable', 'mx-md', options.class] });
  for (const node of parseBlocks(collectDefs(lines, ctx), ctx)) root.append(node);
  return root;
}

// HTML externo (descripciones de CurseForge) con el mismo tratamiento de imagenes y links.
export function renderHtml(html, options = {}) {
  const ctx = { defs: {}, base: options.base ?? null, onImage: options.onImage, onProject: options.onProject, images: [] };
  const root = h('div', { class: ['rich', 'selectable', 'mx-md', options.class] });
  for (const node of htmlNodes(html, ctx)) root.append(node);
  return root;
}
