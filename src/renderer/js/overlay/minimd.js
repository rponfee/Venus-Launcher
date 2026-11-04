// Markdown minimo para las respuestas del asistente en el overlay: parrafos, titulos, listas, citas, negrita, cursiva,
// codigo y bloques de codigo. Siempre nodos de texto, nunca HTML. Los enlaces se muestran como texto con su direccion:
// la ventana del overlay no navega ni abre nada. Sin imports de la interfaz (la pagina no carga ui.js); la logica de
// bloques e inline no toca el DOM, asi la prueban las pruebas.

// Texto de una linea -> partes: { t: 'text' | 'b' | 'i' | 'code' | 'a', v, href? }
export function inlineParts(text) {
  const out = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  const s = String(text ?? '');
  for (const m of s.matchAll(re)) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    const part = m[0];
    if (part.startsWith('`')) out.push({ t: 'code', v: part.slice(1, -1) });
    else if (part.startsWith('**') || part.startsWith('__')) out.push({ t: 'b', v: part.slice(2, -2) });
    else if (part.startsWith('*')) out.push({ t: 'i', v: part.slice(1, -1) });
    else {
      const cut = part.indexOf('](');
      out.push({ t: 'a', v: part.slice(1, cut), href: part.slice(cut + 2, -1) });
    }
    last = m.index + part.length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}

// Texto completo -> bloques: { t: 'p' | 'h' | 'quote' | 'code' | 'ul' | 'ol', ... }
export function mdBlocks(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push({ t: 'p', text: para.join(' ') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      const body = [];
      for (i++; i < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[i]); i++) body.push(lines[i]);
      out.push({ t: 'code', text: body.join('\n') });
      continue;
    }
    let m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (m) {
      flush();
      out.push({ t: 'h', text: m[2] });
      continue;
    }
    m = /^\s*>\s?(.*)$/.exec(line);
    if (m) {
      flush();
      out.push({ t: 'quote', text: m[1] });
      continue;
    }
    m = /^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (m) {
      flush();
      const kind = /\d/.test(m[1]) ? 'ol' : 'ul';
      const prev = out[out.length - 1];
      if (prev?.t === kind && lines[i - 1] !== undefined && /^\s*([-*+]|\d{1,3}[.)])\s+/.test(lines[i - 1])) prev.items.push(m[2]);
      else out.push({ t: kind, items: [m[2]] });
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  return out;
}

// Dibuja el markdown con la h() de la pagina
export function renderMd(src, h) {
  const inline = (text) =>
    inlineParts(text).map((p) => {
      if (p.t === 'code') return h('code', {}, p.v);
      if (p.t === 'b') return h('strong', {}, p.v);
      if (p.t === 'i') return h('em', {}, p.v);
      if (p.t === 'a') return h('span', { class: 'ova-link', title: p.href }, p.v);
      return p.v;
    });
  return h(
    'div',
    { class: 'ova-md' },
    mdBlocks(src).map((b) => {
      if (b.t === 'h') return h('p', { class: 'ova-md-h' }, inline(b.text));
      if (b.t === 'quote') return h('blockquote', {}, inline(b.text));
      if (b.t === 'code') return h('pre', {}, h('code', {}, b.text));
      if (b.t === 'ul' || b.t === 'ol') return h(b.t, {}, b.items.map((x) => h('li', {}, inline(x))));
      return h('p', {}, inline(b.text));
    }),
  );
}
