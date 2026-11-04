#!/usr/bin/env node
'use strict';
// Revisión textual local: no conecta a PostgreSQL ni reemplaza ejecutar el harness de rollback.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const migrations = path.join(root, 'supabase', 'migrations');
const files = fs.readdirSync(migrations).filter(f => /^00(2[89]|3[0-6])_.*\.sql$/.test(f)).sort();
assert.equal(files.length, 9, 'Deben estar las nueve migraciones 0028–0036');
let functions = 0;
let tables = 0;
const byName = new Map();
for (const file of files) {
  const source = fs.readFileSync(path.join(migrations, file), 'utf8');
  assert(!/(?<!\r)\n/.test(source), file + ': conservar CRLF');
  const starts = [...source.matchAll(/create or replace function\s+(public|private)\.(\w+)\s*\(/gi)];
  for (let i = 0; i < starts.length; i++) {
    const match = starts[i];
    const body = source.slice(match.index, starts[i + 1]?.index ?? source.length);
    const open = body.indexOf('as $$');
    assert(open >= 0 && body.indexOf('$$;', open + 5) >= 0, file + ': delimitadores SQL de ' + match[2]);
    const header = body.slice(0, open);
    assert(header.includes("set search_path = ''"), file + ': search_path fijo en ' + match[2]);
    byName.set(match[1] + '.' + match[2], body.slice(0, body.indexOf('end $$;') >= 0 ? body.indexOf('end $$;') + 7 : body.indexOf('$$;') + 3));
    functions++;
  }
  tables += [...source.matchAll(/create table if not exists public\.\w+/gi)].length;
  assert(!/revoke all on public\.\w+ from anon, authenticated;/i.test(source), file + ': revocar PUBLIC también');
  if (/add constraint points_ledger_reason_check/i.test(source)) {
    const constraint = source.match(/add constraint points_ledger_reason_check\s+check\s*\(([\s\S]*?)\);/i);
    for (const reason of ['daily','achievement','referral','referred','shop','admin','mission','pass','pass_refund','gift_in','gift_out','challenge']) {
      assert(constraint && constraint[1].includes("'" + reason + "'"), file + ': conservar motivo ' + reason);
    }
  }
}
assert.equal(functions, 183, 'Actualizar el inventario del harness al agregar funciones');
assert.equal(tables, 32, 'Inventario de tablas nuevas');
for (const name of ['private.clan_shared', 'public.clan_ranking']) {
  const source = byName.get(name);
  assert(source.includes('join public.clan_prefs cp on cp.user_id = m.user_id and cp.share_playtime'), name + ': consentimiento público');
  assert(source.includes('join public.ranking_prefs p on p.user_id = m.user_id and p.share'), name + ': permiso de amigos intacto');
}
const prefs = fs.readFileSync(path.join(migrations, '0033_clanes_comunidades.sql'), 'utf8');
assert(/share_playtime boolean not null default false/.test(prefs), 'Permiso apagado por defecto');
assert(byName.get('public.clan_me').includes("'sharePlaytime'"), 'Contrato de lectura para la UI');
assert(byName.get('public.clan_share_playtime').includes('me uuid := auth.uid()'), 'Propietario del permiso');
assert(byName.get('private.sticker_can_upload').includes("hashtext('stickers-upload:' || p_user::text)"), 'Cuota de subida de stickers');
assert(byName.get('public.event_join').includes("hashtext('event-signups:' || me::text)"), 'Tope de eventos por cuenta');
assert(byName.get('private.community_add_member').includes("hashtext('community-user:' || p_user::text)"), 'Tope de comunidades por cuenta');
assert(byName.get('private.media_share_note').includes("hashtext('media-received:' || p_recipient::text)"), 'Retención por destinatario');
assert(byName.get('public.app_inbox').includes("b.addressee = o.other and b.status = 'blocked'"), 'Bloqueo en bandeja');
for (const name of ['public.gallery_mine', 'public.admin_gallery_list']) {
  assert(byName.get(name).includes('private.gallery_url_ok(m.url, m.path) then m.url end'), name + ': URL revisada al leer');
}
const harnessPath = path.join(root, 'supabase', 'tests', 'migrations-0028-0036-rollback.sql');
const harness = fs.readFileSync(harnessPath, 'utf8');
assert(!/(?<!\r)\n/.test(harness), 'CRLF en harness');
const includes = [...harness.matchAll(/^\\ir \.\.\/migrations\/(.+)\r?$/gm)].map(m => m[1]);
assert.deepEqual(includes, files, 'Orden de las nueve migraciones del harness');
assert.equal((harness.match(/^BEGIN;/gm) || []).length, 1, 'Una transacción');
assert.equal((harness.match(/^ROLLBACK;/gm) || []).length, 1, 'Rollback final');
assert(!/^\s*COMMIT\s*;/im.test(harness), 'Nunca confirmar cambios');
assert(!/^\s*\\(?:connect|c\s|!|copy\s)/im.test(harness), 'Sin comandos externos de psql');
assert(!/\b(?:net\.http_\w+|vault\.\w+)\s*\(/i.test(harness), 'No llamar a red ni Vault');
assert(harness.indexOf('CREATE OR REPLACE FUNCTION private.push_dispatch') < harness.indexOf('insert into auth.users'), 'Destino push sustituido antes de fixtures');
assert(harness.indexOf('DO $realtime$') < harness.indexOf('insert into auth.users'), 'Realtime sustituido antes de fixtures');
assert(harness.includes('alter sequence %s restart with %s'), 'Secuencias preexistentes aisladas transaccionalmente');
const cases = [...harness.matchAll(/'00(?:2[89]|3[0-6]) [^']+'/g)].length;
console.log('OK estático: ' + files.length + ' migraciones, ' + functions + ' funciones, ' + tables + ' tablas; CRLF, permisos declarados, consentimiento, motivos de puntos y orden del harness.');
console.log('Harness preparado: ' + cases + ' etiquetas de escenarios legítimos, más comprobaciones del catálogo.');
console.log('NO ejecuta SQL, NO comprueba sintaxis PostgreSQL ni demuestra resultados de RLS, concurrencia, Storage, Realtime o push.');
