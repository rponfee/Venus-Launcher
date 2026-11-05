'use strict';
// Genera la migracion con el catalogo de logros y misiones a partir de src/renderer/js/pages/achievements/catalog.js.
// Uso: node scripts/gen-achievements-sql.js supabase/migrations/00NN_logros_catalogo.sql
//      node scripts/gen-achievements-sql.js salida.sql --since supabase/migrations/0024_logros_catalogo.sql [--since otra.sql]
// No hay tope: para sumar logros se agrega al catalogo, se genera una migracion nueva y se aplica.
// Con --since solo se genera lo de los logros (sin misiones) y ademas se desactivan (active = false) los ids que esas
// migraciones anteriores definieron y el catalogo ya no tiene: no se borra ningun desbloqueo ni se quitan puntos (4.6).
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const quote = (v) => (v === null || v === undefined ? 'null' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

// ids de los logros que define una migracion generada por este mismo script (insert de 8 columnas)
const ROW = /^\s*\('([a-z0-9_]+)', \d+, '(?:client|server)', \d+, '[a-z0-9_]+', '[a-z]+', (?:null|'[A-Za-z]+'), \d+\)/;
function idsDe(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => ROW.exec(line)?.[1])
    .filter(Boolean);
}

(async () => {
  const args = process.argv.slice(2);
  const out = args[0];
  if (!out || out.startsWith('--')) throw new Error('Falta el archivo de salida');
  const since = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--since' && args[i + 1]) since.push(args[++i]);
    else throw new Error(`Argumento desconocido: ${args[i]}`);
  }
  const { ACHIEVEMENTS, MISSIONS } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/js/pages/achievements/catalog.js')).href);
  const rows = ACHIEVEMENTS.map((a) => `  (${[a.id, a.points, a.kind, a.sort, a.family, a.tier, a.metric, a.target].map(quote).join(', ')})`);
  const upsert = `insert into public.achievements (id, points, check_kind, sort, family, tier, metric, target) values
${rows.join(',\n')}
on conflict (id) do update set points = excluded.points, check_kind = excluded.check_kind, sort = excluded.sort,
  family = excluded.family, tier = excluded.tier, metric = excluded.metric, target = excluded.target, active = true;
`;
  let sql;
  if (since.length) {
    const current = new Set(ACHIEVEMENTS.map((a) => a.id));
    const retired = [...new Set(since.flatMap(idsDe))].filter((id) => !current.has(id));
    const lines = [];
    for (let i = 0; i < retired.length; i += 4) lines.push(`  ${retired.slice(i, i + 4).map(quote).join(', ')}`);
    sql = `-- Generado por scripts/gen-achievements-sql.js: no editar a mano. Se desactivan ${retired.length} logros y el catalogo queda en ${ACHIEVEMENTS.length}.
-- Los desbloqueos y los puntos ya dados no se tocan: solo dejan de poder conseguirse.
update public.achievements set active = false
 where active and id in (
${lines.join(',\n')}
);

${upsert}`;
  } else {
    const missions = MISSIONS.map((m) => `  (${[m.id, m.period, m.metric, m.target, m.points].map(quote).join(', ')})`);
    sql = `-- Generado por scripts/gen-achievements-sql.js: no editar a mano. Catalogo de logros (${ACHIEVEMENTS.length}) y misiones (${MISSIONS.length}).
${upsert}
insert into public.missions (id, period, metric, target, points) values
${missions.join(',\n')}
on conflict (id) do update set period = excluded.period, metric = excluded.metric, target = excluded.target, points = excluded.points, active = true;
`;
  }
  fs.writeFileSync(out, sql);
  console.log(`${ACHIEVEMENTS.length} logros${since.length ? '' : `, ${MISSIONS.length} misiones`} -> ${out}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
