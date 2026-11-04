// Cuentas del gráfico del historial de rendimiento: escalas y líneas, sin DOM (pruebas en test/chart-math.test.js).
const numeric = (v) => typeof v === 'number' && Number.isFinite(v);

// Tope redondo para el eje: 1, 2 o 5 por una potencia de 10, por encima del valor.
export function niceMax(value) {
  if (!numeric(value) || value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 2, 5, 10]) if (value <= m * pow) return m * pow;
  return 10 * pow;
}

// Tope de la RAM (en MB): GB pares, asi las marcas del eje quedan redondas (de 4 GB salen 1, 2, 3 y 4).
export function niceRam(mb) {
  if (!numeric(mb) || mb <= 0) return 1024;
  const gb = Math.ceil(mb / 1024);
  return (gb <= 1 ? 1 : gb + (gb % 2)) * 1024;
}

export function ticks(max, count = 4) {
  return Array.from({ length: count + 1 }, (_, i) => (max * i) / count);
}

// Las series [{ t: [segundos], v: [valor o null] }] -> el tope de cada eje
export function bounds(series, nice = niceMax) {
  let tMax = 0;
  let vMax = 0;
  for (const s of series) {
    for (const x of s.t || []) if (numeric(x) && x > tMax) tMax = x;
    for (const x of s.v || []) if (numeric(x) && x > vMax) vMax = x;
  }
  return { tMax: tMax || 1, vMax: nice(vMax) };
}

// Atributo d de una línea. Un dato que falta la corta (no se inventa un valor en el medio).
export function linePath(t, v, { x, y }) {
  let d = '';
  let open = false;
  for (let i = 0; i < Math.min(t?.length || 0, v?.length || 0); i++) {
    if (!numeric(t[i]) || !numeric(v[i])) {
      open = false;
      continue;
    }
    d += `${open ? 'L' : 'M'}${x(t[i]).toFixed(1)} ${y(v[i]).toFixed(1)}`;
    open = true;
  }
  return d;
}

// Filas para comparar dos partidas: promedio, mínimo, 1 % bajo y máximo de cada medida, y la diferencia del promedio.
export function compareRows(a, b, metrics = ['ram', 'cpu', 'fps']) {
  return metrics.map((key) => {
    const x = a?.[key] || null;
    const y = b?.[key] || null;
    const diff = x && y ? Math.round((y.avg - x.avg) * 10) / 10 : null;
    const pct = x && y && x.avg ? Math.round(((y.avg - x.avg) / x.avg) * 100) : null;
    return { key, a: x, b: y, diff, pct };
  });
}
