// Reescritura de colores de todas las hojas de estilo (temas de color, daltonismo y alto contraste).
//
// Muchas hojas usan colores fijos (rgba(242, 154, 46, .2), #ffd36b...) en vez de variables. Para que
// un tema o un modo de accesibilidad llegue a TODA la interfaz, cada hoja <link>/<style> recibe justo
// despues una hoja "espejo" con los mismos selectores y los colores transformados.
// Para no alterar la cascada, el espejo copia (en el mismo orden) todas las declaraciones de cada
// familia de propiedades que tuvo algun cambio en esa hoja: asi gana siempre la misma regla que antes.
import { parseColor, toCss } from './color.js';

const MARK = 'data-ax-restyle';
// Propiedades que se pisan entre si (atajo y longhands) y van juntas en el espejo
const GROUPS = ['background', 'border', 'outline', 'text-decoration', 'column-rule', 'text-emphasis', 'text-stroke', 'mask', 'scrollbar'];
const COLOR_RE = /url\((?:[^()"']|"[^"]*"|'[^']*')*\)|(#[0-9a-fA-F]{3,8}\b|rgba?\([^()]*\))/g;

let mapper = null; // (color, ctx) => color | null
const mirrors = new Map(); // nodo fuente -> <style> espejo
let observer = null;
let scheduled = false;

// Activa (fn) o desactiva (null) la transformacion de colores y regenera los espejos
// (en el proximo cuadro, o en el momento con { now: true }).
export function setMapper(fn, { now = false } = {}) {
  mapper = typeof fn === 'function' ? fn : null;
  if (mapper) watch();
  if (now) {
    scheduled = false;
    refreshAll();
  } else schedule();
}

export function isActive() {
  return Boolean(mapper);
}

// Transforma los colores de un valor CSS suelto (util para estilos en linea o variables).
export function mapValue(value, prop = '') {
  if (!mapper || !/#|rgb/i.test(value)) return value;
  const ctx = { prop, gradient: /gradient\(/i.test(value) };
  return String(value).replace(COLOR_RE, (m, color) => {
    if (!color) return m;
    const c = parseColor(color);
    if (!c) return m;
    const out = mapper(c, ctx);
    return out ? toCss(out) : m;
  });
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    if (!scheduled) return;
    scheduled = false;
    refreshAll();
  });
}

function sources() {
  return [...document.querySelectorAll('link[rel~="stylesheet"], style')].filter((n) => !n.hasAttribute(MARK) && !n.hasAttribute('data-ax-skip'));
}

function refreshAll() {
  const list = sources();
  for (const node of list) processNode(node);
  for (const [node, st] of mirrors) {
    if (!mapper || !node.isConnected) {
      st.remove();
      mirrors.delete(node);
    }
  }
}

function watch() {
  if (observer) return;
  observer = new MutationObserver((records) => {
    if (!mapper) return;
    for (const r of records) {
      for (const n of r.addedNodes) {
        if ((n.nodeName === 'LINK' || n.nodeName === 'STYLE') && !n.hasAttribute?.(MARK)) processNode(n);
      }
      for (const n of r.removedNodes) {
        const st = mirrors.get(n);
        if (st) {
          st.remove();
          mirrors.delete(n);
        }
      }
    }
  });
  observer.observe(document.head, { childList: true });
}

function processNode(node) {
  if (node.nodeName === 'LINK' && !/\bstylesheet\b/i.test(node.rel || '')) return;
  if (node.hasAttribute('data-ax-skip')) return;
  if (!mapper) return;
  const sheet = node.sheet;
  if (!sheet) {
    // <link> que todavia no termino de cargar
    if (node.nodeName === 'LINK' && !node.dataset.axWait) {
      node.dataset.axWait = '1';
      node.addEventListener(
        'load',
        () => {
          delete node.dataset.axWait;
          processNode(node);
        },
        { once: true },
      );
    }
    return;
  }
  let rules;
  try {
    rules = sheet.cssRules;
  } catch {
    return; // hoja de otro origen: no se puede leer
  }
  let text = '';
  try {
    text = buildMirror(rules);
  } catch (err) {
    console.warn('[a11y] restyle', err);
    text = '';
  }
  let st = mirrors.get(node);
  if (!text) {
    if (st) {
      st.remove();
      mirrors.delete(node);
    }
    return;
  }
  if (!st) {
    st = document.createElement('style');
    st.setAttribute(MARK, '');
    mirrors.set(node, st);
  }
  if (node.media && st.media !== node.media) st.media = node.media;
  if (st.textContent !== text) st.textContent = text;
  if (node.nextSibling !== st) node.after(st);
}

// ---------- Construccion del espejo ----------
function family(prop) {
  if (prop.startsWith('--')) return prop;
  const p = prop.replace(/^-webkit-/, '');
  for (const g of GROUPS) if (p === g || p.startsWith(`${g}-`)) return g;
  return p;
}

function splitDecls(text) {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  const push = (raw) => {
    const s = raw.trim();
    if (!s) return;
    const c = s.indexOf(':');
    if (c <= 0) return;
    const prop = s.slice(0, c).trim();
    let value = s.slice(c + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
    out.push({ prop, value, important });
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) {
      push(text.slice(start, i));
      start = i + 1;
    }
  }
  push(text.slice(start));
  return out;
}

function prelude(rule) {
  const css = rule.cssText || '';
  const i = css.indexOf('{');
  return i > 0 ? css.slice(0, i).trim() : '';
}

// Recorre las reglas y arma un arbol con los valores originales y transformados.
function walk(rules, changed) {
  const nodes = [];
  const declsOf = (style) =>
    splitDecls(style.cssText).map((d) => {
      const next = mapValue(d.value, d.prop);
      const fam = family(d.prop);
      if (next !== d.value) changed.add(fam);
      return { ...d, next, fam };
    });
  for (const rule of rules) {
    if (rule instanceof CSSStyleRule) {
      const children = rule.cssRules?.length ? walk(rule.cssRules, changed) : [];
      nodes.push({ kind: 'style', selector: rule.selectorText, decls: declsOf(rule.style), children });
    } else if (rule.constructor?.name === 'CSSNestedDeclarations' && rule.style) {
      // declaraciones sueltas dentro de una regla anidada
      nodes.push({ kind: 'style', selector: '', decls: declsOf(rule.style), children: [] });
    } else if (rule instanceof CSSKeyframesRule) {
      const text = rule.cssText;
      const next = mapValue(text, 'keyframes');
      nodes.push({ kind: 'raw', text: next, changed: next !== text });
    } else if (typeof CSSImportRule !== 'undefined' && rule instanceof CSSImportRule) {
      let inner = null;
      try {
        inner = rule.styleSheet?.cssRules;
      } catch {
        inner = null;
      }
      if (inner) {
        const media = rule.media?.mediaText;
        nodes.push({ kind: 'group', prelude: media ? `@media ${media}` : '', children: walk(inner, changed) });
      }
    } else if (rule.cssRules && !(rule instanceof CSSFontFaceRule)) {
      // @media, @supports, @container, @layer {...}
      const pre = prelude(rule);
      if (pre.startsWith('@')) nodes.push({ kind: 'group', prelude: pre, children: walk(rule.cssRules, changed) });
    }
  }
  return nodes;
}

function emit(nodes, changed) {
  const out = [];
  for (const n of nodes) {
    if (n.kind === 'style') {
      const decls = n.decls.filter((d) => changed.has(d.fam)).map((d) => `${d.prop}: ${d.next}${d.important ? ' !important' : ''};`);
      const kids = n.children.length ? emit(n.children, changed) : '';
      if (!n.selector) {
        if (decls.length) out.push(decls.join(' '));
      } else if (decls.length || kids) out.push(`${n.selector} { ${decls.join(' ')}${kids ? ` ${kids}` : ''} }`);
    } else if (n.kind === 'group') {
      const kids = emit(n.children, changed);
      if (kids) out.push(n.prelude ? `${n.prelude} {\n${kids}\n}` : kids);
    } else if (n.kind === 'raw' && n.changed) {
      out.push(n.text);
    }
  }
  return out.join('\n');
}

function buildMirror(rules) {
  const changed = new Set();
  const tree = walk(rules, changed);
  const hasRaw = (list) => list.some((n) => (n.kind === 'raw' && n.changed) || (n.children && hasRaw(n.children)));
  if (!changed.size && !hasRaw(tree)) return '';
  return emit(tree, changed);
}
