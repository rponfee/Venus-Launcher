// ¿La versión a es más nueva que la b? Formato del manifiesto: mayor.menor.parche con un sufijo opcional, y una versión
// con sufijo (1.2.0-beta) es anterior a la misma sin sufijo. Sin DOM: se prueba con Node.
function parts(version) {
  const [main, ...rest] = String(version).split('-');
  return { nums: main.split('.').map((n) => Number(n) || 0), pre: rest.join('-') };
}

export function isNewer(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return d > 0;
  }
  if (x.pre === y.pre) return false;
  if (!x.pre) return true;
  if (!y.pre) return false;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true }) > 0;
}
