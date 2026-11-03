'use strict';
// Genera la migracion con el catalogo de logros y misiones a partir de src/renderer/js/pages/achievements/catalog.js.
// Uso: node scripts/gen-achievements-sql.js supabase/migrations/00NN_logros_catalogo.sql
// No hay tope: para sumar logros se agrega al catalogo, se genera una migracion nueva y se aplica.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const quote = (v) => (v === null || v === undefined ? 'null' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

(async () => {
  const out = process.argv[2];
  if (!out) throw new Error('Falta el archivo de salida');
  const { ACHIEVEMENTS, MISSIONS } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/js/pages/achievements/catalog.js')).href);
  const rows = ACHIEVEMENTS.map((a) => `  (${[a.id, a.points, a.kind, a.sort, a.family, a.tier, a.metric, a.target].map(quote).join(', ')})`);
  const missions = MISSIONS.map((m) => `  (${[m.id, m.period, m.metric, m.target, m.points].map(quote).join(', ')})`);
  const sql = `-- Generado por scripts/gen-achievements-sql.js: no editar a mano. Catalogo de logros (${ACHIEVEMENTS.length}) y misiones (${MISSIONS.length}).
insert into public.achievements (id, points, check_kind, sort, family, tier, metric, target) values
${rows.join(',\n')}
on conflict (id) do update set points = excluded.points, check_kind = excluded.check_kind, sort = excluded.sort,
  family = excluded.family, tier = excluded.tier, metric = excluded.metric, target = excluded.target, active = true;

insert into public.missions (id, period, metric, target, points) values
${missions.join(',\n')}
on conflict (id) do update set period = excluded.period, metric = excluded.metric, target = excluded.target, points = excluded.points, active = true;
`;
  fs.writeFileSync(out, sql);
  console.log(`${ACHIEVEMENTS.length} logros, ${MISSIONS.length} misiones -> ${out}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
