// Planes de clan: lógica pura, tabla de planes y fondos incluidos contra la migración 0044, y el modo de ejemplo con una orden falsa.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as plan from '../../../features/communities/plan.js';
import * as looks from '../../../features/communities/looks.js';
import { PRESETS, findPreset, presetsFor } from '../../../features/communities/presets.js';
import { FAKE_PLAN_TABLE, createFakePlans } from '../../../features/communities/fake-plans.js';
import { createFakeGroups } from '../../../features/communities/fake.js';

const require = createRequire(import.meta.url);
const MIGRATION = fs.readFileSync(new URL('../../../../../../supabase/migrations/0044_clanes_planes.sql', import.meta.url), 'utf8');
const CSS = fs.readFileSync(new URL('../../../../styles/features/communityplans.css', import.meta.url), 'utf8');
const NOW = Date.parse('2026-11-05T12:00:00Z');
const iso = (days) => new Date(NOW + days * 86400000).toISOString();
const UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const backend = (scenario = 'demo') => createFakeGroups(scenario, { signedIn: () => true, userId: () => 'fake-me', onAuth: () => () => {} });

const raw = (id, over = {}) => ({
  plan: { id, name: id, priceUsd: 2, periodDays: 30, endsAt: id === 'free' ? null : iso(20), limits: { media: 50, backdrops: 2, stages: 1, animated: false, members: 500, channels: 50, roles: 15, priority: false } },
  isOwner: true, usage: { media: 12, pending: 1, backdrops: 1, stages: 0, members: 30, channels: 4, roles: 2 }, hiddenMedia: 0, periods: [], plans: [], ...over,
});

test('la tabla de planes de la migración tiene los números pedidos y la interfaz de ejemplo los repite', () => {
  const rows = [...MIGRATION.matchAll(/\('(free|go|pro|max|ultra)',\s*'([^']+)',\s*(\d),\s*([\d.]+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(true|false),\s*(\d+),\s*(\d+),\s*(\d+),\s*(true|false)\)/g)];
  assert.equal(rows.length, 5);
  const seeded = rows.map((m) => ({ id: m[1], rank: +m[3], priceUsd: +m[4], media: +m[5], pending: +m[6], backdrops: +m[7], stages: +m[8], animated: m[9] === 'true', members: +m[10], channels: +m[11], roles: +m[12], priority: m[13] === 'true' }));
  for (const s of seeded) {
    const fake = FAKE_PLAN_TABLE.find((p) => p.id === s.id);
    assert.deepEqual({ id: fake.id, rank: fake.rank, priceUsd: fake.priceUsd, media: fake.media, pending: fake.pending, backdrops: fake.backdrops, stages: fake.stages, animated: fake.animated, members: fake.members, channels: fake.channels, roles: fake.roles, priority: fake.priority }, s, s.id);
  }
  assert.deepEqual(seeded.map((s) => [s.id, s.priceUsd, s.media, s.backdrops, s.stages]), [['free', 0, 10, 0, 0], ['go', 2, 50, 2, 1], ['pro', 4, 150, 6, 4], ['max', 6, 400, 15, 10], ['ultra', 10, 1000, 40, 25]]);
});

test('los 12 fondos y escenarios incluidos: migración, lista de la interfaz y dibujo en CSS coinciden', () => {
  const seeded = [...MIGRATION.matchAll(/\('([a-z_]+)',\s*'(chat|stage)',\s*(true|false),\s*\d+\)/g)].map((m) => ({ id: m[1], scope: m[2], animated: m[3] === 'true' }));
  assert.equal(seeded.length, 12);
  assert.deepEqual(PRESETS.map((p) => ({ id: p.id, scope: p.scope, animated: p.animated })).sort((a, b) => a.id.localeCompare(b.id)), seeded.sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal(presetsFor('chat').length, 6);
  assert.equal(presetsFor('stage').length, 6);
  for (const p of PRESETS) {
    assert.ok(CSS.includes(`.cp-bd[data-preset="${p.id}"] .cp-bd-art`), `falta el dibujo de ${p.id}`);
    for (const lang of ['es', 'en']) {
      const text = fs.readFileSync(new URL(`../../../../i18n/${lang}/communityplans.js`, import.meta.url), 'utf8');
      assert.ok(text.includes(`preset_${p.id}:`), `falta el nombre de ${p.id} en ${lang}`);
    }
  }
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(CSS.replace(/\/\*[\s\S]*?\*\//g, '')), 'nada de imágenes o fuentes de internet en el CSS');
  assert.equal(findPreset('aurora', 'stage').animated, true);
  assert.equal(findPreset('aurora', 'chat'), null, 'un escenario no es un fondo de chat');
  assert.equal(findPreset('"><img src=x>'), null);
});

test('estado del plan: normalizar, vencimiento y uso', () => {
  assert.equal(plan.normalizePlanState(null), null);
  assert.equal(plan.normalizePlanState({ plan: 'x' }), null);
  const s = plan.normalizePlanState(raw('go'));
  assert.equal(s.plan.id, 'go');
  assert.equal(s.plan.rank, 1);
  assert.equal(s.isOwner, true);
  assert.equal(plan.daysLeft(iso(20), NOW), 20);
  assert.equal(plan.daysLeft(iso(-3), NOW), 0);
  assert.equal(plan.daysLeft('no es fecha', NOW), null);
  assert.equal(plan.planStatus(s, NOW), 'active');
  assert.equal(plan.planStatus(plan.normalizePlanState(raw('pro', { plan: { ...raw('pro').plan, endsAt: iso(3) } })), NOW), 'soon');
  assert.equal(plan.planStatus(plan.normalizePlanState(raw('free')), NOW), 'free');
  const rows = plan.usageRows(s);
  const media = rows.find((r) => r.key === 'media');
  assert.deepEqual([media.used, media.max, media.pct, media.full], [12, 50, 24, false]);
  assert.equal(rows.find((r) => r.key === 'stages').included, true);
  const free = plan.normalizePlanState(raw('free', { plan: { id: 'free', limits: { media: 10 } } }));
  assert.equal(plan.usageRows(free).find((r) => r.key === 'backdrops').included, false, 'gratis: 0 fondos propios');
  assert.equal(plan.hasRoom(s, 'backdrops'), true);
  assert.equal(plan.hasRoom(plan.normalizePlanState(raw('go', { usage: { backdrops: 2 } })), 'backdrops'), false);
  // Un plan o límite inventado no rompe nada.
  const odd = plan.normalizePlanState({ plan: { id: '<b>', limits: { media: -5, roles: 'x' } }, usage: { media: 'nada' }, periods: [{ plan: 'hack' }], plans: [{ id: 'nope' }] });
  assert.equal(odd.plan.id, 'free');
  assert.equal(odd.plan.limits.media, 0);
  assert.deepEqual(odd.periods, []);
  assert.deepEqual(odd.plans, []);
});

test('ofertas: precio en pesos y dólares, renovar, sumar uno menor y lo que recibe el pago', () => {
  const catalog = { clans: [
    { id: 'clan_ultra', tier: 'ultra', name: 'Clanes Ultra', priceUsd: 10, limits: { media: 1000 }, prices: { paypal: { total: 10, currency: 'USD' } } },
    { id: 'clan_go', tier: 'go', name: 'Clanes Go', priceUsd: 2, periodDays: 30, limits: { media: 50 }, prices: { mercado_pago: { total: 3000, currency: 'ARS' }, paypal: { total: 2, currency: 'USD' } } },
    { id: 'clan_pro', tier: 'pro', name: 'Clanes Pro', priceUsd: 4, limits: {}, prices: {} },
    { id: 'pass_go', tier: 'go', name: 'Pass', priceUsd: 1 },
  ] };
  const list = plan.offers(catalog, plan.normalizePlanState(raw('pro')));
  assert.deepEqual(list.map((o) => o.id), ['clan_go', 'clan_pro', 'clan_ultra'], 'ordenados y sin planes que no son de clan');
  assert.deepEqual(list.map((o) => plan.buyKind(o)), ['queue', 'renew', 'buy']);
  assert.equal(plan.mainPrice(list[0]).total, 3000, 'pesos primero');
  assert.equal(plan.mainPrice(list[2]).currency, 'USD');
  assert.equal(plan.mainPrice(list[1]), null);
  const sent = plan.checkoutPlan(list[0], UUID);
  assert.deepEqual([sent.id, sent.clan, sent.communityId, sent.periodDays], ['clan_go', true, UUID, 30]);
  assert.equal(plan.offers({ clans: 'x' }, null).length, 0);
});

test('después de pagar: un plan mayor gana, uno igual se suma al que queda y uno menor espera', () => {
  const offer = (tier, name) => ({ tier, name, rank: plan.PLAN_IDS.indexOf(tier), lower: false, periodDays: 30, limits: {}, priceUsd: 4 });
  const s = plan.normalizePlanState(raw('go', { plan: { ...raw('go').plan, endsAt: new Date(NOW + 10 * 86400000).toISOString() } }));
  const same = plan.afterPayment(s, { ...offer('go', 'Clanes Go'), rank: 1 }, NOW);
  assert.equal(Date.parse(same.plan.endsAt), NOW + 40 * 86400000, 'renovar suma 30 días a lo que queda');
  const up = plan.afterPayment(s, offer('pro', 'Clanes Pro'), NOW);
  assert.equal(up.plan.id, 'pro');
  assert.equal(up.plan.name, 'Pro');
});

test('fondos y escenarios: normalizar, elegir el del canal y avisar antes del servidor', () => {
  const ch = '11111111-1111-4111-8111-111111111111';
  const items = looks.normalizeBackdrops({ items: [
    { id: 'a', kind: 'chat', channelId: null, source: 'preset', preset: 'dunes', dim: 99, blur: -4, state: 'ok' },
    { id: 'b', kind: 'chat', channelId: ch, source: 'preset', preset: 'waves', state: 'ok' },
    { id: 'c', kind: 'chat', channelId: null, source: 'preset', preset: 'aurora' }, // un escenario como fondo de chat: no vale
    { id: 'd', kind: 'otro', source: 'preset', preset: 'dunes' },
    { id: 'e', kind: 'stage', channelId: null, source: 'media', media: { id: UUID, source: 'klipy', url: 'https://static.klipy.com/a.gif', animated: true }, state: 'hidden_plan' },
    { id: 'f', kind: 'stage', channelId: ch, source: 'media', media: { id: 'no-uuid' } },
  ] }).items;
  assert.deepEqual(items.map((i) => i.id), ['a', 'b', 'e']);
  assert.deepEqual([items[0].dim, items[0].blur], [80, 0], 'oscurecer y desenfoque quedan dentro de rango');
  assert.equal(items[1].animated, true);
  assert.equal(looks.pickBackdrop(items, 'chat', ch).id, 'b', 'el del canal gana');
  assert.equal(looks.pickBackdrop(items, 'chat', 'otro-canal').id, 'a', 'si no, el de toda la comunidad');
  assert.equal(looks.pickBackdrop(items, 'stage', null), null, 'lo oculto por el plan no se dibuja');
  assert.equal(looks.normalizeBackdrops(null).items.length, 0);
  const community = { channels: [{ id: ch, kind: 'text', name: 'general', position: 1 }, { id: 'v', kind: 'voice', name: 'sala', position: 0 }] };
  assert.deepEqual(looks.scopeRows(community, 'chat', items).map((r) => r.channelId), [null, ch]);
  assert.deepEqual(looks.scopeRows(community, 'stage', items).map((r) => r.channelId), [null, 'v']);

  const go = plan.normalizePlanState(raw('go'));
  assert.equal(looks.checkChoice(go, 'chat', null, { source: 'preset', id: 'dunes' }), null);
  assert.equal(looks.checkChoice(go, 'chat', null, { source: 'preset', id: 'waves' }), 'plan_animated');
  assert.equal(looks.checkChoice(go, 'stage', null, { source: 'preset', id: 'night_forest' }), null);
  assert.equal(looks.checkChoice(plan.normalizePlanState(raw('go', { usage: { stages: 1 } })), 'stage', null, { source: 'preset', id: 'night_forest' }), 'plan_limit');
  assert.equal(looks.checkChoice(plan.normalizePlanState(raw('go', { usage: { stages: 1 } })), 'stage', { id: 'x' }, { source: 'preset', id: 'night_forest' }), null, 'cambiar uno que ya hay no gasta cupo');
  assert.equal(looks.checkChoice(go, 'chat', null, { source: 'preset', id: 'aurora' }), 'bad_choice');
  assert.equal(looks.checkChoice(go, 'chat', null, { source: 'media', item: { id: 'x' } }), 'bad_choice');
  assert.equal(looks.checkChoice(go, 'chat', null, { source: 'media', item: { id: UUID, animated: true } }), 'plan_animated');
  assert.deepEqual(looks.setArgs('c1', 'chat', ch, { source: 'media', item: { id: UUID } }, { dim: 200, blur: 4 }),
    { p_community: 'c1', p_kind: 'chat', p_channel: ch, p_source: 'media', p_value: UUID, p_dim: 80, p_blur: 4 });
  assert.equal(looks.usableMedia([{ id: UUID, status: 'approved', path: 'a/b.png' }, { id: UUID, status: 'pending', path: 'x' }, { id: UUID, status: 'approved', hidden: true, path: 'x' }, { id: UUID, status: 'approved' }]).length, 1);
});

test('modo de ejemplo: gratis, comprar con una orden falsa, límites, ocultos y vencimiento', async () => {
  const b = backend();
  let v = await b.rpc('community_plan_get', { p_community: 'm-1' });
  assert.equal(v.plan.id, 'free');
  assert.equal(v.isOwner, true);
  assert.equal(v.plan.limits.backdrops, 0);
  await assert.rejects(b.rpc('community_backdrop_set', { p_community: 'm-1', p_kind: 'chat', p_source: 'preset', p_value: 'dunes' }), { code: 'plan_limit' });
  // La orden falsa sale del cliente de pagos de ejemplo del proceso principal y se acredita sola.
  const { createFakeBilling } = require('../../../../../main/modules/billing/fake.js');
  const events = [];
  const billing = createFakeBilling({ t: (k) => k, send: (channel, payload) => events.push({ channel, payload }), state: 'none' });
  const catalog = await billing.catalog();
  assert.equal(catalog.clans.length, 4);
  const res = await billing.checkout({ plan: 'clan_go', provider: 'paypal', community: 'm-1' });
  assert.equal(res.order.status, 'pending');
  for (let i = 0; i < 60 && !events.some((e) => e.channel === 'billing:changed'); i++) await new Promise((r) => setTimeout(r, 100));
  const changed = events.find((e) => e.channel === 'billing:changed');
  assert.deepEqual(changed.payload, { reason: 'paid', kind: 'clan', plan: 'clan_go', community: 'm-1' });
  b.fakeApplyBilling(changed.payload);
  v = await b.rpc('community_plan_get', { p_community: 'm-1' });
  assert.equal(v.plan.id, 'go');
  assert.ok(Date.parse(v.plan.endsAt) > Date.now() + 29 * 86400000);
  assert.equal((await b.rpc('community_get', { p_community: 'm-1' })).plan.id, 'go');

  // Con Go: dos fondos, un escenario, nada animado.
  await b.rpc('community_backdrop_set', { p_community: 'm-1', p_kind: 'chat', p_source: 'preset', p_value: 'dunes', p_dim: 40, p_blur: 2 });
  await b.rpc('community_backdrop_set', { p_community: 'm-1', p_kind: 'chat', p_channel: 't-2', p_source: 'preset', p_value: 'paper_dots' });
  await assert.rejects(b.rpc('community_backdrop_set', { p_community: 'm-1', p_kind: 'chat', p_channel: 't-3', p_source: 'preset', p_value: 'mesh' }), { code: 'plan_limit' });
  await assert.rejects(b.rpc('community_backdrop_set', { p_community: 'm-1', p_kind: 'stage', p_channel: 'v-1', p_source: 'preset', p_value: 'aurora' }), { code: 'plan_animated' });
  await assert.rejects(b.rpc('community_backdrop_set', { p_community: 'm-1', p_kind: 'stage', p_channel: 't-1', p_source: 'preset', p_value: 'night_forest' }), { code: 'bad_channel' });
  await b.rpc('community_backdrop_set', { p_community: 'm-1', p_kind: 'stage', p_channel: 'v-1', p_source: 'preset', p_value: 'night_forest' });
  const stage = await b.rpc('community_stage_get', { p_room: 'r-v-1' });
  assert.equal(stage.stage.preset, 'night_forest');
  assert.equal(await b.rpc('community_stage_get', { p_room: 'sala-comun' }), null);
  // La galería: una imagen aprobada sirve de fondo; una pendiente no.
  await assert.rejects(b.rpc('community_backdrop_set', { p_community: 'm-1', p_kind: 'chat', p_source: 'media', p_value: 'g-2' }), { code: 'bad_media' });
  await assert.rejects(b.rpc('community_backdrop_set', { p_community: 'm-1', p_kind: 'chat', p_source: 'media', p_value: 'g-1' }), { code: 'plan_animated' }); // g-1 es un GIF aprobado: animado
});

test('modo de ejemplo: el GIF animado pide Pro, lo que vence se oculta y un miembro no cambia nada', async () => {
  const b = backend();
  b.fakeSetPlan('m-1', 'go');
  await assert.rejects(b.rpc('community_backdrop_set', { p_community: 'm-1', p_kind: 'chat', p_source: 'media', p_value: 'g-1' }), { code: 'plan_animated' });
  b.fakeSetPlan('m-1', 'pro');
  await b.rpc('community_backdrop_set', { p_community: 'm-1', p_kind: 'chat', p_source: 'media', p_value: 'g-1' });
  await b.rpc('community_backdrop_set', { p_community: 'm-1', p_kind: 'stage', p_channel: 'v-1', p_source: 'preset', p_value: 'aurora' });
  let back = await b.rpc('community_backdrops_get', { p_community: 'm-1' });
  assert.deepEqual(back.items.map((i) => i.state), ['ok', 'ok']);
  assert.equal(back.presets.length, 12);
  // Vence: los fondos siguen guardados, pero el equipo los ve ocultos y la sala no recibe escenario.
  b.fakeSetPlan('m-1', 'free');
  back = await b.rpc('community_backdrops_get', { p_community: 'm-1' });
  assert.deepEqual(back.items.map((i) => i.state), ['hidden_plan', 'hidden_plan']);
  assert.equal((await b.rpc('community_stage_get', { p_room: 'r-v-1' })).stage, null);
  // Renovar los trae de vuelta.
  b.fakeSetPlan('m-1', 'pro');
  assert.deepEqual((await b.rpc('community_backdrops_get', { p_community: 'm-1' })).items.map((i) => i.state), ['ok', 'ok']);
  // Un miembro común de otra comunidad no cambia nada ni compra.
  await assert.rejects(b.rpc('community_backdrop_set', { p_community: 'm-2', p_kind: 'chat', p_source: 'preset', p_value: 'dunes' }), { code: 'forbidden' });
  await assert.rejects(b.rpc('community_backdrop_clear', { p_community: 'm-2', p_kind: 'chat' }), { code: 'forbidden' });
  assert.equal((await b.rpc('community_plan_get', { p_community: 'm-2' })).isOwner, false);
});

test('modo de ejemplo: el cupo de la galería sale del plan y lo que lo pasa se oculta', async () => {
  const b = backend();
  for (let i = 0; i < 7; i++) {
    const id = `00000000-0000-4000-8000-00000000000${i}`;
    await b.uploadMedia(`m-1/${id}.png`, { size: 1000, type: 'image/png' });
    await b.rpc('community_media_register', { p_id: id, p_community: 'm-1', p_name: `Foto ${i}`, p_width: 100, p_height: 100 });
    // Se aprueban a mano para no chocar con el tope de pendientes.
    await b.rpc('admin_community_media_review', { p_id: id, p_decision: 'approve' });
  }
  const state = await b.rpc('community_plan_get', { p_community: 'm-1' });
  assert.equal(state.usage.media, 10, 'ya llegó al tope gratis (3 vigentes de ejemplo + 7)');
  await assert.rejects(b.rpc('community_media_register', { p_id: '00000000-0000-4000-8000-0000000000ff', p_community: 'm-1', p_name: 'De más', p_width: 100, p_height: 100 }), { code: 'media_limit' });
  b.fakeSetPlan('m-1', 'go');
  assert.equal((await b.rpc('community_plan_get', { p_community: 'm-1' })).hiddenMedia, 0);
  const klipy = await b.rpc('community_media_add_klipy', { p_community: 'm-1', p_name: 'Gato', p_url: 'https://static.klipy.com/ii/abc/def.gif' });
  assert.deepEqual([klipy.status, klipy.source, klipy.animated], ['pending', 'klipy', true]);
  await assert.rejects(b.rpc('community_media_add_klipy', { p_community: 'm-1', p_name: 'Malo', p_url: 'https://evil.example/x.gif' }), { code: 'bad_media' });
  b.fakeSetPlan('m-1', 'free');
  const after = await b.rpc('community_plan_get', { p_community: 'm-1' });
  assert.equal(after.hiddenMedia, 1, 'con 11 elementos y cupo 10, el más nuevo queda oculto');
  const list = await b.rpc('community_media_list', { p_community: 'm-1' });
  assert.equal(list.filter((m) => m.hidden).length, 1);
  assert.equal(list.find((m) => m.hidden).id, klipy.id, 'se oculta lo más nuevo');
});

test('Administración de ejemplo: dar, quitar y editar un plan', async () => {
  const b = backend();
  let plans = await b.rpc('admin_community_plans');
  assert.equal(plans.plans.length, 5);
  await b.rpc('admin_community_plan_grant', { p_community: 'm-1', p_plan: 'ultra', p_days: 10 });
  assert.equal((await b.rpc('admin_community_plan_state', { p_community: 'm-1' })).plan.id, 'ultra');
  await assert.rejects(b.rpc('admin_community_plan_grant', { p_community: 'm-1', p_plan: 'free' }), { code: 'unknown_plan' });
  await assert.rejects(b.rpc('admin_community_plan_grant', { p_community: 'm-1', p_plan: 'go', p_days: 0 }), { code: 'bad_value' });
  const queue = await b.rpc('admin_community_media_queue', { p_status: 'pending' });
  assert.equal(queue.items[0].communityId, 'm-1', 'las comunidades Ultra pasan primero en la cola');
  assert.equal(queue.items[0].priority, true);
  await b.rpc('admin_community_plan_save', { p_id: 'go', p_patch: { media: 60 } });
  plans = await b.rpc('admin_community_plans');
  assert.equal(plans.plans.find((p) => p.id === 'go').limits.media, 60);
  await assert.rejects(b.rpc('admin_community_plan_save', { p_id: 'go', p_patch: { inventado: 1 } }), { code: 'bad_request' });
  await b.rpc('admin_community_plan_revoke', { p_community: 'm-1' });
  assert.equal((await b.rpc('community_plan_get', { p_community: 'm-1' })).plan.id, 'free');
});

test('createFakePlans suma períodos como la base: renovar, mejorar y esperar', () => {
  const c = { id: 'x', myRole: 'owner', media: [], backdrops: [], channels: [], roles: [], members: [], extra: 0, plan: { id: 'free', endsAt: null } };
  const p = createFakePlans({ communities: new Map([['x', c]]), commOf: () => c, needComm: () => c, fail: (code) => { throw new Error(code); }, iso: (ms) => new Date(ms).toISOString(), everyMedia: () => [], mediaOf: () => null, ME: {} });
  p.grant(c, 'go');
  const first = Date.parse(c.plan.endsAt);
  p.grant(c, 'go');
  assert.equal(Date.parse(c.plan.endsAt) - first, 30 * 86400000, 'renovar suma 30 días');
  p.grant(c, 'pro');
  assert.equal(c.plan.id, 'pro');
  const proEnds = Date.parse(c.plan.endsAt);
  p.grant(c, 'go');
  assert.equal(c.plan.id, 'pro', 'uno menor no le saca el lugar al mayor');
  assert.equal(Date.parse(c.plan.endsAt) - proEnds, 30 * 86400000);
});
