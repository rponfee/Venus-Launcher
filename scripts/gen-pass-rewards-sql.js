'use strict';
// Genera el bloque de premios de supabase/migrations/0041_venus_pass_tiempo.sql (los marcos nuevos del pase y los 380
// premios de la pista) a partir de src/renderer/js/pages/pass/plan.js, y lo deja entre las marcas
// "-- >>> premios-generados" y "-- <<< premios-generados" del archivo.
// Uso:  node scripts/gen-pass-rewards-sql.js              reescribe el bloque en la migración
//       node scripts/gen-pass-rewards-sql.js --check      falla (código 1) si el bloque no coincide con el plan
//       node scripts/gen-pass-rewards-sql.js --print      muestra el bloque sin escribir nada
//       node scripts/gen-pass-rewards-sql.js <archivo>    usa otro archivo con las mismas marcas
process.removeAllListeners('warning'); // sin el aviso de módulos ES sin "type"
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const DEFAULT_FILE = path.join(__dirname, '..', 'supabase', 'migrations', '0041_venus_pass_tiempo.sql');
const START = '-- >>> premios-generados';
const END = '-- <<< premios-generados';
const quote = (v) => (v === null || v === undefined ? 'null' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

function buildBlock(plan) {
  const rewards = plan.buildRewards();
  const items = plan.planItemIds();
  const frames = plan.FRAME_ITEMS.map((f) => `  (${[f.id, f.kind, 0, false, f.sort, JSON.stringify({ style: f.style }), 'pass'].map((v) => (typeof v === 'boolean' ? String(v) : quote(v))).join(', ')})`);
  const rows = rewards.map((r) => `  (${[plan.SEASON_ID, r.level, plan.TRACK, r.kind, r.kind === 'points' ? r.amount : null, r.kind === 'item' ? r.itemId : null].map(quote).join(', ')})`);
  const points = rewards.filter((r) => r.kind === 'points');
  return [
    `${START} (scripts/gen-pass-rewards-sql.js: no editar a mano; para cambiarlos se edita pages/pass/plan.js y se vuelve a correr el script)`,
    `-- ${rewards.length} niveles: ${points.length} de puntos (${points.reduce((a, r) => a + r.amount, 0)} Venus Points en total) y ${rewards.length - points.length} cosméticos.`,
    '-- Marcos del pase (los dibuja social/frames.js; el id pass_frame_N va con el estilo passN).',
    'insert into public.shop_items (id, kind, price, premium_only, sort, data, source) values',
    `${frames.join(',\n')}`,
    'on conflict (id) do update set kind = excluded.kind, price = excluded.price, premium_only = excluded.premium_only,',
    '  sort = excluded.sort, data = excluded.data, source = excluded.source;',
    '',
    '-- Todo cosmético de la pista tiene que existir en shop_items (si falta uno, la migración se detiene con el nombre).',
    'do $$',
    'declare v_missing text;',
    'begin',
    `  select string_agg(x, ', ' order by x) into v_missing from unnest(array[${items.map(quote).join(', ')}]) x`,
    '   where not exists (select 1 from public.shop_items s where s.id = x);',
    "  if v_missing is not null then raise exception 'pass_items_missing: %', v_missing using errcode = '22023'; end if;",
    'end $$;',
    '',
    'insert into public.pass_rewards (season_id, level, track, kind, amount, item_id) values',
    `${rows.join(',\n')}`,
    'on conflict (season_id, level, track) do nothing;',
    END,
  ].join('\n');
}

function splice(text, block) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lf = text.replace(/\r\n/g, '\n');
  const a = lf.indexOf(START);
  const b = lf.indexOf(END);
  if (a < 0 || b < a) throw new Error(`No encuentro las marcas "${START}" y "${END}" en el archivo.`);
  const next = lf.slice(0, a) + block + lf.slice(b + END.length);
  return { next: next.replace(/\n/g, eol), same: lf.slice(a, b + END.length) === block };
}

(async () => {
  const args = process.argv.slice(2);
  const file = path.resolve(args.find((a) => !a.startsWith('--')) || DEFAULT_FILE);
  const plan = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'pages', 'pass', 'plan.js')).href);
  const block = buildBlock(plan);
  if (args.includes('--print')) {
    console.log(block);
    return;
  }
  const { next, same } = splice(fs.readFileSync(file, 'utf8'), block);
  if (args.includes('--check')) {
    if (!same) {
      console.error(`El bloque de premios de ${path.relative(process.cwd(), file)} no coincide con pages/pass/plan.js: corré node scripts/gen-pass-rewards-sql.js`);
      process.exit(1);
    }
    console.log('Los premios de la migración coinciden con el plan.');
    return;
  }
  if (!same) fs.writeFileSync(file, next);
  console.log(`${plan.LEVELS} niveles -> ${path.relative(process.cwd(), file)}${same ? ' (sin cambios)' : ''}`);
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
