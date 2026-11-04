// Compara el port en JS con la salida completa de harness.c (cubiomes en C) y cuenta lo comparado.
// Uso: node compare.js <salida-del-harness.jsonl> [--max-errores N]
import fs from 'node:fs';
import readline from 'node:readline';
import { checkCase, newStats } from './cases.js';

const file = process.argv[2];
if (!file) throw new Error('falta el archivo');
const flag = process.argv.indexOf('--max-errores');
const maxErrors = flag > 0 ? Number(process.argv[flag + 1]) : 20;

const stats = newStats();
const byKind = {};
let errors = 0;
const started = Date.now();
const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
for await (const raw of rl) {
  if (!raw.trim()) continue;
  const c = JSON.parse(raw);
  const diffs = await checkCase(c, stats);
  for (const d of diffs) {
    errors++;
    byKind[c.k] = (byKind[c.k] || 0) + 1;
    if (errors <= maxErrors) console.log(`DISTINTO ${d}\n  mc ${c.mc} dim ${c.dim} semilla ${c.seed} ${raw.slice(0, 160)}`);
  }
  if (stats.cases % 5000 === 0) console.log(`  ${stats.cases} casos, ${errors} diferencias, ${Math.round((Date.now() - started) / 1000)} s`);
}
console.log(JSON.stringify({ ...stats, seeds: stats.seeds.size, errors, byKind, seconds: Math.round((Date.now() - started) / 1000) }, null, 1));
process.exitCode = errors ? 1 : 0;
