'use strict';
// Revisa lo que realmente entró en el paquete (app.asar de la versión compilada): ningún archivo pesado sin aprobar y
// nada de lo que tiene que quedar afuera. Lo corre el workflow Build después de compilar.
//   node scripts/check-package.js [ruta a app.asar]
// Para aprobar un archivo grande, agregalo a APPROVED con el motivo.
const asar = require('@electron/asar');
const path = require('path');

const ARCHIVE = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar'));
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 150 * 1024 * 1024;
const APPROVED = new Map([
  ['src/renderer/assets/venus/points-ticket.png', 'Ticket de Venus generado con transparencia; original de 2,05 MiB, sin descarga externa.'],
]);
const FORBIDDEN = [
  [/\.mp4$/i, 'los fondos animados se bajan a demanda (modules/wallpapers.js)'],
  [/^node_modules[\\/]@anthropic-ai[\\/]/, 'el SDK de Anthropic solo lo usan las pruebas de las Edge Functions'],
  [/^node_modules[\\/]@supabase[\\/]/, 'la interfaz usa src/renderer/vendor/supabase.js'],
  [/^supabase[\\/]/, 'el código del servidor no va en el launcher'],
];

const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
const files = [];
for (const entry of asar.listPackage(ARCHIVE, { isPack: false })) {
  const name = entry.replace(/^[\\/]+/, '');
  const stat = asar.statFile(ARCHIVE, name, false);
  if (stat.files || stat.link) continue; // carpetas y enlaces
  files.push({ name, size: Number(stat.size) || 0 });
}
files.sort((a, b) => b.size - a.size);
const total = files.reduce((sum, f) => sum + f.size, 0);

console.log(`${path.basename(ARCHIVE)}: ${files.length} archivos, ${mib(total)}`);
for (const f of files.slice(0, 8)) console.log(`  ${mib(f.size).padStart(9)}  ${f.name}`);

const problems = [];
if (total > MAX_TOTAL) problems.push(`El paquete pesa ${mib(total)} (tope ${mib(MAX_TOTAL)}).`);
for (const f of files) {
  const unixName = f.name.replace(/\\/g, '/');
  if (f.size > MAX_FILE && !APPROVED.has(unixName)) problems.push(`${unixName} pesa ${mib(f.size)} (tope ${mib(MAX_FILE)}): reducilo o aprobalo en scripts/check-package.js.`);
  for (const [re, why] of FORBIDDEN) if (re.test(f.name)) problems.push(`${unixName} no tiene que estar en el paquete: ${why}.`);
}
if (problems.length) {
  for (const p of problems.slice(0, 40)) console.error(process.env.GITHUB_ACTIONS ? `::error title=Paquete::${p}` : `MAL: ${p}`);
  process.exit(1);
}
console.log('Paquete en orden.');
