// Comparar dos instancias: campos simples (version, loader, memoria, Java...) y listas de contenido
// (mods, shaders, resource packs) -> que se agrego, que se quito y que cambio de version.
// Funciones puras, sin DOM ni imports, para probarlas con Node.

// Nombre comparable de un archivo de contenido: sin ".disabled", sin extension y sin distinguir mayusculas.
export function normalizeName(name) {
  return String(name || '')
    .replace(/\.disabled$/i, '')
    .replace(/\.(jar|zip|litemod)$/i, '')
    .trim()
    .toLowerCase();
}

// Clave para emparejar un elemento en las dos listas: el proyecto (Modrinth o CurseForge) o el nombre.
export function entryKey(item) {
  if (item?.projectId) return `p:${String(item.projectId).toLowerCase()}`;
  if (item?.modId) return `c:${String(item.modId).toLowerCase()}`;
  return `n:${normalizeName(item?.name || item?.file)}`;
}

function sameVersion(a, b) {
  const va = String(a?.version || '').trim().toLowerCase();
  const vb = String(b?.version || '').trim().toLowerCase();
  if (va && vb) return va === vb;
  // Sin numero de version conocido, se compara el archivo
  return normalizeName(a?.file || a?.name) === normalizeName(b?.file || b?.name);
}

/**
 * Diferencias entre dos listas de contenido ([{ name, version, file, projectId?, enabled? }]).
 * -> { same: [{ a, b }], changed: [{ a, b }], removed: [a] (solo en la primera), added: [b] (solo en la segunda) }
 */
export function diffLists(listA, listB) {
  const byKey = new Map();
  for (const b of listB || []) {
    const k = entryKey(b);
    if (!byKey.has(k)) byKey.set(k, b);
  }
  const same = [];
  const changed = [];
  const removed = [];
  const seen = new Set();
  for (const a of listA || []) {
    const k = entryKey(a);
    if (seen.has(k)) continue;
    seen.add(k);
    const b = byKey.get(k);
    if (!b) removed.push(a);
    else if (sameVersion(a, b) && Boolean(a.enabled ?? true) === Boolean(b.enabled ?? true)) same.push({ a, b });
    else changed.push({ a, b });
  }
  const added = [];
  for (const [k, b] of byKey) if (!seen.has(k)) added.push(b);
  const byName = (x, y) => String(x.name || x.file || '').localeCompare(String(y.name || y.file || ''), undefined, { sensitivity: 'base', numeric: true });
  same.sort((x, y) => byName(x.a, y.a));
  changed.sort((x, y) => byName(x.a, y.a));
  removed.sort(byName);
  added.sort(byName);
  return { same, changed, removed, added };
}

// Campos simples: [{ key, label, a, b }] -> cada fila con `same` (texto igual, sin distinguir espacios).
export function compareFields(fields) {
  const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  return (fields || []).map((f) => ({ ...f, same: norm(f.a).toLowerCase() === norm(f.b).toLowerCase() }));
}

export function diffCount(diff) {
  return (diff?.changed?.length || 0) + (diff?.removed?.length || 0) + (diff?.added?.length || 0);
}

function label(item) {
  const name = item?.name || item?.file || '?';
  const ver = item?.version ? ` ${item.version}` : '';
  const off = item && item.enabled === false ? ' (off)' : '';
  return `${name}${ver}${off}`;
}

/**
 * Texto plano con las diferencias (para "Copiar diferencias").
 *   names: [nombreA, nombreB] · fields: salida de compareFields · sections: [{ title, diff }]
 *   texts: { onlyIn: 'Solo en {name}', changed: 'Distintos', none: 'Sin diferencias', same: '{count} iguales' }
 *   (same y onlyIn tambien pueden ser funciones: same(count), onlyIn(name), para textos con plural)
 */
export function diffText({ names, fields = [], sections = [], texts = {} }) {
  const [na, nb] = names || ['A', 'B'];
  const fmt = (s, vars) => (typeof s === 'function' ? String(s(Object.values(vars)[0])) : String(s || '').replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? String(vars[k]) : m)));
  const lines = [`${na}  |  ${nb}`];
  // Un renglon en blanco antes de cada bloque (nunca dos seguidos)
  const block = (...rows) => {
    if (lines[lines.length - 1] !== '') lines.push('');
    lines.push(...rows);
  };
  const diffFields = fields.filter((f) => !f.same);
  if (diffFields.length) block(...diffFields.map((f) => `${f.label}: ${f.a || '—'}  |  ${f.b || '—'}`));
  let any = diffFields.length > 0;
  for (const s of sections) {
    const d = s.diff;
    if (!diffCount(d)) continue;
    any = true;
    block(`== ${s.title} ==`);
    if (d.removed.length) {
      lines.push(fmt(texts.onlyIn || 'Solo en {name}', { name: na }));
      for (const a of d.removed) lines.push(`  - ${label(a)}`);
    }
    if (d.added.length) {
      lines.push(fmt(texts.onlyIn || 'Solo en {name}', { name: nb }));
      for (const b of d.added) lines.push(`  + ${label(b)}`);
    }
    if (d.changed.length) {
      lines.push(texts.changed || 'Distintos');
      for (const { a, b } of d.changed) lines.push(`  ~ ${label(a)}  ->  ${label(b)}`);
    }
    if (d.same.length) lines.push(fmt(texts.same || '{count} iguales', { count: d.same.length }));
  }
  if (!any) block(texts.none || 'Sin diferencias');
  return lines.join('\n').trim();
}
