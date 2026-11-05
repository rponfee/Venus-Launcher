// Contratos de retirada con DOM mínimo y servicios falsos. No usa cuentas ni red.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { harness, flush } from '../../clans/test/renderer-harness.js';
import { normalizeNav, navLayout } from '../../navcustom/logic.js';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

test('rutas, menú y arranque ignoran las funciones retiradas y conservan Comunidades y Mundos', async () => {
  const source = read('../../../app.js');
  const declaration = name => {
    const found = source.match(new RegExp('const ' + name + ' = [\\s\\S]*?^(?:\\];|\\};)', 'm'));
    assert.ok(found, name);
    return found[0];
  };
  const loaded = [];
  const config = vm.runInNewContext(
    ['NAV', 'PAGES', 'STARTUP'].map(declaration).join('\n').replace(/\bimport\(/g, 'load(') + '\n;({NAV,PAGES,STARTUP})',
    { load: async name => { loaded.push(name); return {}; } },
  );
  for (const id of ['clans', 'extensions', 'seeds']) {
    assert.equal(config.NAV.some(item => item.id === id), false);
    assert.equal(id in config.PAGES, false);
  }
  for (const id of ['communities', 'worlds', 'voice', 'clips']) assert.equal(typeof config.PAGES[id], 'function');
  await Promise.all(config.STARTUP.map(load => load()));
  assert.equal(loaded.some(name => /\/(clans|extensions|streamer)\.js$/.test(name)), false);
  const prefs = normalizeNav({ order: ['clans', 'communities', 'seeds'], pinned: ['extensions', 'communities'], hidden: ['seeds'] }, config.NAV.map(item => item.id).filter(Boolean));
  const ids = navLayout(config.NAV, prefs).map(item => item.id).filter(Boolean);
  assert.ok(ids.includes('communities') && ids.includes('worlds'));
  assert.equal(ids.some(id => ['clans', 'extensions', 'seeds'].includes(id)), false);
  assert.doesNotMatch(read('../../../pages/home.js'), /import\(['"][^'"]*features\/extensions\.js['"]\)/);
});

test('Acerca de abre la web oficial mediante app.openExternal', async () => {
  const source = read('../../../pages/settings/general.js');
  const declaration = source.match(/const LINKS = \[[\s\S]*?^\];/m)?.[0];
  const expression = source.split(/\r?\n/).find(line => line.includes('LINKS.map('))?.trim().replace(/,$/, '');
  assert.ok(declaration && expression);
  const urls = [];
  const buttons = vm.runInNewContext(declaration + '\n' + expression, {
    h: (tag, props, ...children) => ({ tag, props, children }), icon: name => name, t: key => key,
    api: { app: { openExternal: async url => urls.push(url) } },
  });
  const button = buttons.find(button => button.props.title === 'https://venuslauncher.fun/');
  assert.ok(button);
  assert.ok(button.children.includes('settings.link_website'));
  await button.props.onclick();
  assert.deepEqual(urls, ['https://venuslauncher.fun/']);
});

function adminRig() {
  const ui = harness(), calls = [];
  const group = { id: 'fixture-community', name: 'Comunidad de prueba', memberCount: 1, isPublic: true, createdAt: '2026-11-04', owner: { username: 'owner' } };
  const b = { rpc: async (name, args) => {
    calls.push([name, args]);
    if (name === 'admin_groups') return [group];
    if (name === 'admin_group_detail') return { ...group, members: [{ userId: 'member', username: 'member', role: 'member' }], channels: [{ name: 'general', kind: 'text' }] };
    if (name === 'admin_group_reports') return [
      { id: 'old-clan', kind: 'clan', status: 'open', snapshot: { name: 'Clan archivado' } },
      { id: 'community-report', kind: 'community', status: 'open', snapshot: { name: 'Comunidad de prueba' } },
      { id: 'message-report', kind: 'message', status: 'open', snapshot: { body: 'Mensaje de prueba' } },
    ];
    return { ok: true };
  } };
  const { render } = ui.load(new URL('../../../pages/admin/clans.js', import.meta.url), {
    groupsBackend: async () => b, ensureCss() {}, debounce: fn => fn, promptDialog: async () => 'Motivo de prueba',
    modal: ({ body }) => { ui.deps.mount(ui.root, ...ui.root.children, body); return { close() {} }; },
  }, ['render']);
  const button = label => ui.nodes.find(node => node.isConnected && node.tag === 'button' && node.children.includes('clans.' + label));
  return { ui, calls, render, button };
}

test('administración mantiene listar, ver y moderar comunidades sin acciones de clanes', async () => {
  const r = adminRig();
  await r.render(r.ui.root); await flush();
  assert.equal(r.calls[0][0], 'admin_groups');
  assert.equal(r.calls[0][1].p_kind, 'community');
  assert.equal(r.button('adminTab_clan'), undefined);
  assert.ok(r.button('adminTab_community'));
  await r.button('view').fire('click'); await flush();
  await r.button('adminRemove').fire('click'); await flush();
  await r.button('adminDissolve').fire('click'); await flush();
  const actions = r.calls.filter(([name]) => ['admin_groups', 'admin_group_detail', 'admin_group_remove', 'admin_group_dissolve'].includes(name));
  assert.ok(actions.some(([name]) => name === 'admin_group_remove'));
  assert.ok(actions.some(([name]) => name === 'admin_group_dissolve'));
  assert.ok(actions.every(([, args]) => args.p_kind === 'community'));
  assert.equal(r.ui.errors.length, 0);
});

test('administración conserva denuncias de comunidades y mensajes sin ofrecer acciones sobre clanes', async () => {
  const r = adminRig();
  await r.render(r.ui.root); await flush();
  await r.button('adminTab_reports').fire('click'); await flush();
  const closeButtons = r.ui.nodes.filter(node => node.isConnected && node.tag === 'button' && node.children.includes('clans.adminReportClose'));
  assert.equal(closeButtons.length, 2);
  await closeButtons[0].fire('click'); await flush();
  await r.button('adminReportRemove').fire('click'); await flush();
  const actions = r.calls.filter(([name]) => name === 'admin_group_report_close').map(([,args]) => args);
  assert.ok(actions.some(args => args.p_id === 'community-report' && args.p_remove === false));
  assert.ok(actions.some(args => args.p_id === 'message-report' && args.p_remove === true));
  assert.equal(actions.some(args => args.p_id === 'old-clan'), false);
  assert.equal(r.ui.errors.length, 0);
});

test('Ajustes y novedades no anuncian ni reactivan las funciones retiradas', () => {
  const general = read('../../../pages/settings/general.js');
  assert.doesNotMatch(general, /features\/streamer|settings\.streamer/);
  assert.doesNotMatch(read('../../../features/clipstudio/obs-panel.js'), /obsStreamerRule|streamerWhileLive/);
  assert.doesNotMatch(read('../../../features/serverremote/remote.js'), /privacy.*streamer|isStreamer/);
  assert.doesNotMatch(read('../../../features/whatsnew.js'), /navigate\('(seeds|extensions|clans)'\)/);
  assert.doesNotMatch(read('../../../pages/compete/rankings.js'), /clanSharingCard/);
  for (const lang of ['es', 'en']) {
    const texts = vm.runInNewContext(read('../../../../i18n/' + lang + '/whatsnew.js').replace('export default', 'module.exports ='), { module: { exports: {} } });
    assert.match(texts.v45clips_b3, /OBS/);
    assert.doesNotMatch(texts.v45clips_b3, /streamer/i, 'el recorrido no anuncia un automatismo retirado');
  }
});
