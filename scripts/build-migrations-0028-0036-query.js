#!/usr/bin/env node
'use strict';
// Arma SQL puro en memoria. No abre conexiones ni ejecuta SQL.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
let mode = 'structural';
let output;
let check = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--mode') mode = args[++i];
  else if (args[i] === '--output') output = args[++i];
  else if (args[i] === '--check') check = true;
  else throw Error('Uso: node scripts/build-migrations-0028-0036-query.js [--mode structural|all] [--output archivo.sql] [--check]');
}
assert(['structural', 'all'].includes(mode), 'Modo structural o all');
assert(!output || !check, 'Elegí --output o --check');
const harness = fs.readFileSync(path.join(root, 'supabase/tests/migrations-0028-0036-rollback.sql'), 'utf8').replace(/\r\n/g, '\n');
const begin = harness.indexOf('BEGIN;');
const catalogStart = harness.indexOf('CREATE TEMP TABLE venus_checks');
const catalogEnd = harness.indexOf('end $structure$;') + 'end $structure$;'.length;
assert(begin >= 0 && catalogStart > begin && catalogEnd > catalogStart, 'Marcadores de estructura');
let sql;
if (mode === 'all') {
  // Conserva los controles de loopback, base vacía, barreras sin red y protección de secuencias.
  sql = harness.slice(begin).replace(/^\\echo .*\n?/gm, '');
} else {
  // Sin fixtures ni consultas de negocio: puede entregarse al parent para su transacción autorizada.
  // Ninguna función de la migración se invoca; definir una función que menciona Vault no lee Vault.
  sql = [
    '-- SOLO ESTRUCTURA: no usuarios, no datos de negocio, no push, no realtime.send ni lectura de Vault.',
    '-- Inspección autorizada con rollback; no es un despliegue ni una prueba de escenarios.',
    "BEGIN;\nSET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '90s';\nSET LOCAL idle_in_transaction_session_timeout = '120s';\nSET LOCAL search_path = public, pg_catalog;",
    'DO $guard$',
    'begin',
    "  if to_regclass('public.profile_gifts') is null then raise exception 'Se requiere base hasta 0027'; end if;",
    "  if to_regclass('public.settings_sync') is not null or to_regclass('public.clan_prefs') is not null or to_regclass('public.community_extensions') is not null then",
    "    raise exception '0028–0036 ya aplicadas: este ensayo requiere la base previa';",
    '  end if;',
    // Las únicas escrituras de las migraciones sobre tablas preexistentes son estos catálogos.
    "  if exists (select 1 from pg_trigger where tgrelid in ('public.shop_items'::regclass, 'storage.buckets'::regclass)",
    "      and not tgisinternal and tgenabled <> 'D') then",
    "    raise exception 'Hay triggers en catálogos de tienda/buckets: no ejecutar sin revisión';",
    '  end if;',
    'end $guard$;',
    harness.slice(catalogStart, catalogEnd),
    'SELECT count(*) AS comprobaciones_estructurales_ok FROM pg_temp.venus_checks;',
    'ROLLBACK;',
    "SELECT 'OK estructural; escenarios, pg_net y entrega de push NO ejecutados' AS resultado;"
  ].join('\n') + '\n';
}
const included = [];
sql = sql.replace(/^\\ir \.\.\/migrations\/(00(?:2[89]|3[0-6])_[a-z_]+\.sql)$/gm, (_, file) => {
  included.push(file);
  return '\n-- INICIO ' + file + '\n' + fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8').replace(/\r\n/g, '\n') + '\n-- FIN ' + file + '\n';
});
assert.equal(included.length, 9, 'Nueve migraciones incluidas');
assert.deepEqual(included, [...included].sort(), 'Orden de migraciones');
assert(!/^\\/m.test(sql), 'La query no puede contener metacomandos de psql');
assert.equal((sql.match(/^BEGIN;/gm) || []).length, 1, 'Un BEGIN');
assert.equal((sql.match(/^ROLLBACK;/gm) || []).length, 1, 'Un ROLLBACK');
assert(!/^\s*COMMIT\s*;/im.test(sql), 'Nunca COMMIT');
if (mode === 'structural') {
  assert(!sql.includes('DO $scenarios$') && !sql.includes('insert into auth.users'), 'Sin escenarios ni creación de usuarios');
  assert(!sql.includes('ALTER TABLE auth.users') && !sql.includes('alter sequence %s'), 'Sin hooks de Auth ni cambios a secuencias');
} else {
  assert(sql.includes('DO $scenarios$') && sql.includes('DO $realtime$'), 'Escenarios con destino Realtime sustituido');
  assert(sql.includes('CREATE OR REPLACE FUNCTION private.push_dispatch'), 'Push sustituido antes de fixtures');
  assert(sql.includes('La base contiene usuarios: abortado'), 'Nunca usar datos reales en escenarios');
}
sql = sql.replace(/\n/g, '\r\n');
const summary = { mode, migrations: included.length, bytes: Buffer.byteLength(sql), sha256: crypto.createHash('sha256').update(sql).digest('hex'), executed: false };
if (check) console.log(JSON.stringify(summary));
else if (output) {
  const destination = path.resolve(output);
  assert(!fs.existsSync(destination), 'El archivo de salida ya existe; elegí uno nuevo para conservarlo');
  fs.writeFileSync(destination, sql, {encoding:'utf8', flag:'wx'});
  console.log(JSON.stringify({...summary, output:destination}));
} else process.stdout.write(sql);
