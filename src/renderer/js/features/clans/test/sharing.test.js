import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, deferred, flush } from './renderer-harness.js';
import { createFakeGroups } from '../fake.js';
import es from '../../../../i18n/es/clans.js';
import en from '../../../../i18n/en/clans.js';

function sharingHarness({ read = async () => ({ sharePlaytime: false }), write = async ({ p_share }) => ({ sharePlaytime: p_share }), confirm = async () => true } = {}) {
  const ui = harness(), calls = [];
  let user = 'test-user', changed = 0;
  const b = {
    signedIn: () => !!user, userId: () => user,
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'clan_me') return read();
      if (name === 'clan_share_playtime') return write(args);
      throw new Error(`RPC inesperada: ${name}`);
    },
  };
  const { clanSharingCard } = ui.load(new URL('../sharing.js', import.meta.url), { confirmDialog: confirm }, ['clanSharingCard']);
  const card = clanSharingCard({ b, onChanged: () => changed++ });
  ui.deps.mount(ui.root, card);
  const input = ui.nodes.find((n) => n.type === 'checkbox');
  return { ...ui, card, input, calls, changed: () => changed, setUser: (next) => { user = next; }, toggle: async (on) => { input.checked = on; await input.fire('change'); } };
}

test('el permiso empieza apagado, espera al servidor y leer no lo activa', async () => {
  const pending = deferred();
  const ui = sharingHarness({ read: () => pending.promise });
  assert.equal(ui.input.checked, false);
  assert.equal(ui.input.disabled, true);
  pending.resolve({ sharePlaytime: false });
  await flush();
  assert.equal(ui.input.disabled, false);
  assert.equal(ui.input.checked, false);
  assert.deepEqual(ui.calls.map((c) => c.name), ['clan_me']);
});

test('activar requiere confirmación y guarda solo el permiso del clan; apagar no pide confirmación', async () => {
  let confirms = 0;
  const ui = sharingHarness({ confirm: async () => { confirms++; return true; } });
  await flush();
  await ui.toggle(true);
  assert.equal(ui.input.checked, true);
  await ui.toggle(false);
  assert.equal(ui.input.checked, false);
  assert.equal(confirms, 1);
  assert.deepEqual(ui.calls.map((c) => c.name), ['clan_me', 'clan_share_playtime', 'clan_share_playtime']);
  assert.deepEqual(ui.calls.slice(1).map((c) => c.args.p_share), [true, false]);
  await flush();
  assert.equal(ui.changed(), 2);
});

test('cancelar la confirmación mantiene apagado el permiso sin escribir', async () => {
  const ui = sharingHarness({ confirm: async () => false });
  await flush();
  await ui.toggle(true);
  assert.equal(ui.input.checked, false);
  assert.equal(ui.input.disabled, false);
  assert.equal(ui.calls.length, 1);
});

test('una respuesta perdida exige releer y no muestra el permiso como confirmado', async () => {
  let stored = false;
  const ui = sharingHarness({ read: async () => ({ sharePlaytime: stored }), write: async () => { stored = true; throw { code: 'network' }; } });
  await flush();
  await ui.toggle(true);
  assert.equal(ui.input.checked, false);
  assert.equal(ui.input.disabled, true);
  assert.equal(ui.changed(), 0);
  const retry = ui.nodes.find((n) => n.tag === 'button');
  assert.equal(retry.hidden, false);
  await retry.fire('click');
  await flush();
  assert.equal(ui.input.checked, true);
  assert.equal(ui.input.disabled, false);
});

test('un servidor sin el contrato mantiene el interruptor inhabilitado', async () => {
  const ui = sharingHarness({ read: async () => ({ clan: null }) });
  await flush();
  assert.equal(ui.input.checked, false);
  assert.equal(ui.input.disabled, true);
  await ui.toggle(true);
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.input.checked, false);
});

test('cambiar de cuenta durante la confirmación no escribe el permiso de la cuenta nueva', async () => {
  const pending = deferred();
  const ui = sharingHarness({ confirm: () => pending.promise });
  await flush();
  const change = ui.toggle(true);
  ui.setUser('other-test-user');
  pending.resolve(true);
  await change;
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.input.checked, false);
});

test('el ejemplo conserva el permiso aparte, empieza apagado incluso sin clan y null lo apaga', async () => {
  const b = createFakeGroups('new', { signedIn: () => true, userId: () => 'fake-me', onAuth() {} });
  const initial = await b.rpc('clan_me');
  assert.equal(initial.sharePlaytime, false);
  assert.equal(initial.clan, null);
  assert.deepEqual(await b.rpc('clan_share_playtime', { p_share: true }), { sharePlaytime: true });
  assert.equal((await b.rpc('clan_me')).sharePlaytime, true);
  assert.deepEqual(await b.rpc('clan_share_playtime', { p_share: null }), { sharePlaytime: false });
});

test('las claves y variables de Clanes coinciden en español e inglés', () => {
  assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort());
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(es)) assert.deepEqual(vars(es[key]), vars(en[key]), key);
});
