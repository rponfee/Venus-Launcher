// Lo que llama la interfaz contra lo que define la migración (no hay Postgres en las pruebas): nombres de las funciones y
// de sus parámetros, y que todo código de error tenga su texto en español y en inglés.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SERVER_CODES, classifyError } from '../logic.js';
import es from '../../../../i18n/es/multiplayer.js';
import en from '../../../../i18n/en/multiplayer.js';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const sql = read('../../../../../../supabase/migrations/0029_resenas_servidores.sql');
const backend = read('../backend.js');

function sqlFunctions() {
  const out = new Map();
  for (const m of sql.matchAll(/create or replace function public\.(\w+)\(([^)]*)\)/g)) out.set(m[1], [...m[2].matchAll(/\b(p_\w+)\b/g)].map((x) => x[1]));
  return out;
}

test('cada RPC que llama la interfaz existe, con esos parámetros', () => {
  const fns = sqlFunctions();
  const calls = [...backend.matchAll(/active\.rpc\('(\w+)',\s*\{([^}]*)\}/g)];
  assert.ok(calls.length >= 10, `llamadas: ${calls.length}`);
  for (const [, name, args] of calls) {
    assert.ok(fns.has(name), `${name} no está en la migración`);
    const params = [...args.matchAll(/\b(p_\w+):/g)].map((x) => x[1]);
    for (const p of params) assert.ok(fns.get(name).includes(p), `${name} no tiene ${p}`);
    for (const p of fns.get(name)) assert.ok(params.includes(p), `${name}: falta mandar ${p}`);
  }
  for (const name of fns.keys()) assert.ok(calls.some((c) => c[1] === name), `${name} no se usa`);
});

test('cada error de la migración tiene código y texto', () => {
  const raised = new Set([...sql.matchAll(/raise exception '(\w+)'/g)].map((m) => m[1]));
  assert.ok(raised.size >= 10);
  for (const code of [...raised, 'user_banned', 'user_muted']) {
    assert.ok(SERVER_CODES.has(code), `${code} no está en SERVER_CODES`);
    assert.equal(classifyError({ message: code }), code);
  }
  for (const code of [...SERVER_CODES, 'unavailable', 'network', 'server']) {
    assert.ok(es[`rev_err_${code}`], `falta rev_err_${code} en español`);
    assert.ok(en[`rev_err_${code}`], `falta rev_err_${code} en inglés`);
  }
});

test('leer anda sin sesión; opinar y administrar, no', () => {
  for (const name of ['featured_reviews_summary', 'featured_reviews_list']) assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to anon, authenticated`));
  for (const name of ['featured_review_save', 'featured_review_delete', 'featured_server_vote', 'featured_review_report', 'admin_reviews_list', 'admin_review_set_hidden', 'admin_review_delete', 'admin_review_dismiss']) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to authenticated;`));
  }
  assert.equal([...sql.matchAll(/security definer/g)].length, [...sql.matchAll(/security definer set search_path = ''/g)].length);
  for (const fn of ['admin_reviews_list', 'admin_review_set_hidden', 'admin_review_delete', 'admin_review_dismiss']) {
    const body = sql.slice(sql.indexOf(`function public.${fn}(`));
    assert.ok(body.slice(0, body.indexOf('end $$')).includes('public.admin_guard()'), `${fn} sin admin_guard`);
  }
  assert.ok(!/apply_migration/.test(sql));
});
