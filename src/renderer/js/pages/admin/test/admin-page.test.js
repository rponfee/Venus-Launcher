'use strict';
// Página del panel (admin.js) con un DOM mínimo y pestañas falsas: dar o quitar acceso (ctx.onTeamChanged) descarta
// Equipo y el Registro guardados para que al volver se dibujen con el equipo nuevo; la pestaña activa no se toca.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ui, turn } = require('../../../features/clipstudio/test/ui-harness');

const LOGIC = ['TAB_GROUPS', 'TAB_ORDER', 'nextTab'];
const TAB_IDS = ['overview', 'support', 'users', 'payments', 'reports', 'gallery', 'reviews', 'stickers', 'plans', 'integrations', 'team', 'audit'];

function loadPage(deps) {
  const file = path.join(__dirname, '../../admin.js');
  const source = fs.readFileSync(file, 'utf8').replace(/^import .*;\r?$/gm, '').replace(/^export default /m, 'const page = ');
  return vm.runInNewContext(source + '\n;page;', { console, ...deps }, { filename: file });
}

function loadLogic() {
  const file = path.join(__dirname, '../team-logic.js');
  const source = fs.readFileSync(file, 'utf8').replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
  return vm.runInNewContext(source + '\n;({' + LOGIC.join(',') + '});', { T: (k) => k }, { filename: file });
}

async function rig() {
  const dom = ui();
  // El DOM mínimo no trae remove(): se agrega acá para los paneles que admin.js descarta.
  const h = (tag, props, ...children) => {
    const node = dom.deps.h(tag, props, ...children);
    node.remove = () => {
      const parent = node.parent;
      if (parent) parent.children.splice(parent.children.indexOf(node), 1);
      node.parent = null;
    };
    return node;
  };
  const renders = {};
  const destroyed = [];
  const refreshed = [];
  let ctx = null;
  const tab = (id) => ({
    render(el, c) {
      ctx = c;
      renders[id] = (renders[id] || 0) + 1;
      return { refresh: () => refreshed.push(id), destroy: () => destroyed.push(id), openUser() {} };
    },
  });
  const tabs = {};
  for (const id of TAB_IDS) tabs[`${id}Tab`] = tab(id);
  const page = loadPage({
    ...dom.deps,
    ...loadLogic(),
    ...tabs,
    h,
    T: (k) => k,
    api: { invoke: async () => ({ isAdmin: true, userId: 'me', email: 'me@example.test' }) },
    navigate() {},
    call: async () => ({ plans: [] }),
    useFakeRpc() {},
    currentPlans: (x) => x,
    fetchTeam: async () => ({ admins: [], staff: [] }),
    history: { replaceState() {} },
  });
  const root = h('div');
  root.attached = true;
  await page.render(root, ['team']);
  await turn();
  const panel = (id) => root.querySelectorAll('.adm-panel').find((el) => el.id === `adm-panel-${id}`) || null;
  const select = (id) => root.querySelectorAll('button').find((b) => b.dataset?.tab === id).onclick();
  return { root, renders, destroyed, refreshed, panel, select, ctx: () => ctx };
}

test('dar o quitar acceso desde la ficha descarta Equipo y el Registro y al volver se dibujan de nuevo', async () => {
  const r = await rig();
  r.select('audit');
  r.select('users');
  assert.deepEqual([r.renders.team, r.renders.audit, r.renders.users], [1, 1, 1]);
  r.ctx().onTeamChanged();
  assert.deepEqual(r.refreshed, ['users']);
  assert.deepEqual(r.destroyed.sort(), ['audit', 'team']);
  assert.equal(r.panel('team'), null);
  assert.equal(r.panel('audit'), null);
  assert.ok(r.panel('users'), 'Usuarios queda');
  r.select('team');
  r.select('audit');
  assert.deepEqual([r.renders.team, r.renders.audit, r.renders.users], [2, 2, 1]);
});

test('un cambio hecho desde Equipo no descarta Equipo (se recarga solo) pero sí el Registro', async () => {
  const r = await rig();
  r.select('audit');
  r.select('team');
  r.ctx().onTeamChanged();
  assert.deepEqual(r.destroyed, ['audit']);
  assert.ok(r.panel('team'));
  assert.equal(r.panel('team').hidden, false);
  assert.equal(r.panel('audit'), null);
  r.select('audit');
  assert.deepEqual([r.renders.team, r.renders.audit], [1, 2]);
});
