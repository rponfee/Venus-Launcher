import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LEVELS, XP_PER_LEVEL, PLAY_CAP, SEASON_ID, FRAME_LEVELS, FRAME_ITEMS, pointsFor, itemAt, buildRewards, planItemIds } from '../plan.js';
import { createFakePass } from '../fake.js';
import { normalizeMe, levelInfo, claimableList } from '../logic.js';

const MIGRATION = readFileSync(new URL('../../../../../../supabase/migrations/0041_venus_pass_tiempo.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const OLD_FRAMES = ['pass_s1_frame', 'pass_s1_frame_legend', 'pass_s1_free_frame', 'pass_max_frame'];

test('el pase: 380 niveles, 60 XP por nivel, 380 horas', () => {
  assert.equal(LEVELS, 380);
  assert.equal(XP_PER_LEVEL, 60);
  assert.equal(PLAY_CAP, 120);
  assert.equal((LEVELS * XP_PER_LEVEL) / 60, 380, 'un nivel por hora de juego');
});

test('los 8 marcos van en los niveles pedidos, con ids pass_frame_1..8 y estilo passN', () => {
  assert.deepEqual(FRAME_LEVELS, [25, 60, 100, 150, 200, 260, 320, 380]);
  assert.deepEqual(FRAME_ITEMS.map((f) => [f.id, f.style, f.level]), FRAME_LEVELS.map((lv, i) => [`pass_frame_${i + 1}`, `pass${i + 1}`, lv]));
  for (const f of FRAME_ITEMS) assert.equal(itemAt(f.level), f.id);
});

test('premios: uno por nivel, puntos que suben, múltiplos de 10 triples y cosméticos en niveles clave', () => {
  const rewards = buildRewards();
  assert.equal(rewards.length, 380);
  assert.deepEqual(rewards.map((r) => r.level), Array.from({ length: 380 }, (_, i) => i + 1));
  assert.equal(pointsFor(1), 10);
  assert.equal(pointsFor(9), 10);
  assert.equal(pointsFor(10), 30);
  assert.equal(pointsFor(50), 30);
  assert.equal(pointsFor(51), 12);
  assert.equal(pointsFor(360), 72);
  const points = rewards.filter((r) => r.kind === 'points');
  for (let i = 1; i < points.length; i++) {
    if (points[i].level % 10 !== 0 && points[i - 1].level % 10 !== 0) assert.ok(points[i].amount >= points[i - 1].amount, 'sin contar los hitos, los puntos no bajan');
  }
  assert.equal(points.length, 359);
  assert.equal(points.reduce((a, r) => a + r.amount, 0), 6800);
  const items = rewards.filter((r) => r.kind === 'item');
  assert.equal(items.length, 21);
  assert.equal(items.filter((r) => r.itemId.startsWith('pass_frame_')).length, 8);
  assert.equal(items.filter((r) => /title/.test(r.itemId)).length, 7);
  assert.equal(items.filter((r) => /effect/.test(r.itemId)).length, 6);
  assert.equal(new Set(items.map((r) => r.itemId)).size, 21, 'ningún cosmético se repite');
  for (const id of OLD_FRAMES) assert.ok(!planItemIds().includes(id), `no usa ${id}`);
  assert.equal(planItemIds().length, 21);
});

test('la migración 0041 lleva exactamente los premios del plan (corré scripts/gen-pass-rewards-sql.js si falla)', () => {
  const rows = [...MIGRATION.matchAll(/^ {2}\('venus-pass', (\d+), 'free', '(points|item)', (\d+|null), (null|'[a-z0-9_]+')\)/gm)]
    .map((m) => ({ level: Number(m[1]), kind: m[2], amount: m[3] === 'null' ? undefined : Number(m[3]), itemId: m[4] === 'null' ? undefined : m[4].slice(1, -1) }));
  const plan = buildRewards().map((r) => ({ level: r.level, kind: r.kind, amount: r.amount, itemId: r.itemId }));
  assert.deepEqual(rows, plan);
  for (const f of FRAME_ITEMS) assert.ok(MIGRATION.includes(`('${f.id}', 'frame', 0, false, ${f.sort}, '{"style":"${f.style}"}', 'pass')`), `inserta ${f.id}`);
  assert.ok(MIGRATION.includes(`values ('${SEASON_ID}', 'Venus Pass', '2026-01-01 12:00:00+00', '2099-12-31 23:59:59+00', true, ${LEVELS}, ${XP_PER_LEVEL}, true)`), 'la temporada permanente');
  assert.ok(MIGRATION.includes("update public.pass_seasons set active = false where id = 'temporada-1' and active;"), 'desactiva la vieja');
});

test('la migración no vende nada ni usa los marcos viejos', () => {
  const body = MIGRATION.replace(/^--.*$/gm, '');
  for (const id of OLD_FRAMES) assert.ok(!body.includes(`'${id}'`), `no menciona ${id}`);
  assert.ok(!/payments_mark_paid|payments_mark_status|create or replace function public\.payments_/i.test(body), 'no redefine funciones de pagos');
});

test('fake: los tres escenarios de las capturas', async () => {
  const demo = normalizeMe(await createFakePass('demo').rpc('pass_me'));
  assert.equal(demo.level, 74);
  assert.equal(levelInfo(demo).levelXp, 30);
  assert.equal(demo.xp.premiumMult, 1);
  assert.equal(claimableList(demo).length, 22);
  assert.equal(demo.claimable, 22);
  const premium = normalizeMe(await createFakePass('premium').rpc('pass_me'));
  assert.equal(premium.level, 180);
  assert.equal(premium.xp.premiumMult, 1.2);
  assert.equal(premium.xp.fromBonus, 1802);
  const fresh = normalizeMe(await createFakePass('new').rpc('pass_me'));
  assert.equal(fresh.level, 0);
  assert.equal(fresh.claimable, 0);
  assert.equal(fresh.rewards.length, 380);
});

test('fake: reclamar sigue las reglas del servidor', async () => {
  const fake = createFakePass('demo');
  await assert.rejects(fake.rpc('pass_claim', { p_level: 200, p_track: 'free' }), { code: 'locked' });
  await assert.rejects(fake.rpc('pass_claim', { p_level: 1, p_track: 'free' }), { code: 'already' });
  await assert.rejects(fake.rpc('pass_claim', { p_level: 999, p_track: 'free' }), { code: 'bad_reward' });
  const one = await fake.rpc('pass_claim', { p_level: 60, p_track: 'free' });
  assert.equal(one.itemId, 'pass_frame_2');
  const all = await fake.rpc('pass_claim_all');
  assert.equal(all.claimed.length, 21);
  assert.equal((await fake.rpc('pass_claim_all')).claimed.length, 0);
  assert.equal(normalizeMe(await fake.rpc('pass_me')).claimable, 0);
  // Jugar suma minutos, con el tope del día
  const play = await fake.rpc('pass_playtime', { p_minutes: 30 });
  assert.deepEqual(play, { today: 100, added: 30 });
  assert.deepEqual(await fake.rpc('pass_playtime', { p_minutes: 30 }), { today: 120, added: 20 });
});
