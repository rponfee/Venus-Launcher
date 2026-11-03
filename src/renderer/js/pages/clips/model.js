// Datos de la pagina de Clips (sin DOM, se prueban con node:test): en que pestana va cada archivo, filtros por
// instancia, fecha, texto (nombre, mundo, instancia) y motivo de los clips automaticos.

export const TABS = ['screenshots', 'clips', 'recordings'];
export const RANGES = ['all', 'today', 'week', 'month', 'year'];
export const REASONS = ['death', 'advancement', 'boss'];

// Pestana de un item de worlds:media: capturas, grabaciones (carpeta recordings/) o clips (todo el resto de videos)
export function tabOf(item) {
  if (item?.kind === 'screenshot') return 'screenshots';
  const rel = String(item?.rel || '').replace(/\\/g, '/');
  return rel.startsWith('recordings/') ? 'recordings' : 'clips';
}

// Motivo de un clip automatico ('death' | 'advancement' | 'boss') o null: esta en el nombre del archivo, que arma
// logic.fileName ("2026-11-02_18.03.09_auto-death.webm"; lo que se exporta en el editor lo conserva)
export function reasonOf(item) {
  const m = /_auto-(death|advancement|boss)(?=[_.-])/.exec(String(item?.file || ''));
  return m ? m[1] : null;
}

// Desde cuando cuenta cada rango (ms) o 0 = todo
export function rangeStart(range, now = Date.now()) {
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (range === 'today') return midnight;
  if (range === 'week') return midnight - 6 * 86400000;
  if (range === 'month') return midnight - 29 * 86400000;
  if (range === 'year') return new Date(d.getFullYear(), 0, 1).getTime();
  return 0;
}

// Texto sin tildes ni mayusculas para comparar
export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// Todas las palabras de la busqueda tienen que aparecer en el nombre, el mundo, la instancia o la descripcion
export function matches(item, query, extra = '') {
  const words = normalizeText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = normalizeText(`${item?.file || ''} ${item?.world || ''} ${item?.instanceName || ''} ${extra || ''}`);
  return words.every((w) => hay.includes(w));
}

/**
 * Filtra y ordena (mas nuevo primero). f = { tab, instanceId, range, query, now, extraText(item), reason }.
 * reason ('death' | 'advancement' | 'boss') solo filtra la pestana de clips: el resto no tiene motivo.
 */
export function filterItems(items, f = {}) {
  const from = rangeStart(f.range, f.now);
  const extra = typeof f.extraText === 'function' ? f.extraText : () => '';
  return (Array.isArray(items) ? items : [])
    .filter((it) => (!f.tab || tabOf(it) === f.tab) && (!f.instanceId || it.instanceId === f.instanceId) && (!from || (it.date || 0) >= from) && (!f.reason || tabOf(it) !== 'clips' || reasonOf(it) === f.reason) && matches(it, f.query, extra(it)))
    .sort((a, b) => (b.date || 0) - (a.date || 0));
}

// Cantidad por pestana (con los mismos filtros salvo la pestana)
export function countByTab(items, f = {}) {
  const out = { screenshots: 0, clips: 0, recordings: 0 };
  for (const it of filterItems(items, { ...f, tab: null })) out[tabOf(it)]++;
  return out;
}

// Instancias que aparecen en la lista (para el filtro): [{ id, name, count }]
export function instancesOf(items) {
  const map = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const cur = map.get(it.instanceId) || { id: it.instanceId, name: it.instanceName || it.instanceId, count: 0 };
    cur.count++;
    map.set(it.instanceId, cur);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}
