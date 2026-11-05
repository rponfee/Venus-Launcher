// Contratos de retirada con DOM mínimo y servicios falsos. No usa cuentas ni red.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { harness, flush } from '../../communities/test/renderer-harness.js';
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
  for (const id of ['clans', 'extensions', 'seeds', 'compete', 'tools']) {
    assert.equal(config.NAV.some(item => item.id === id), false);
    assert.equal(id in config.PAGES, false);
  }
  for (const id of ['communities', 'worlds', 'voice', 'clips']) assert.equal(typeof config.PAGES[id], 'function');
  await Promise.all(config.STARTUP.map(load => load()));
  assert.equal(loaded.some(name => /\/(clans|extensions|streamer|compete|tools)\.js$/.test(name)), false);
  const prefs = normalizeNav({ order: ['clans', 'communities', 'seeds', 'compete'], pinned: ['extensions', 'communities', 'tools'], hidden: ['seeds'] }, config.NAV.map(item => item.id).filter(Boolean));
  const ids = navLayout(config.NAV, prefs).map(item => item.id).filter(Boolean);
  assert.ok(ids.includes('communities') && ids.includes('worlds'));
  assert.equal(ids.some(id => ['clans', 'extensions', 'seeds', 'compete', 'tools'].includes(id)), false);
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
  const { render } = ui.load(new URL('../../../pages/admin/communities.js', import.meta.url), {
    groupsBackend: async () => b, ensureCss() {}, debounce: fn => fn, promptDialog: async () => 'Motivo de prueba', mediaImage: () => ui.deps.h('media'),
    modal: ({ body }) => { ui.deps.mount(ui.root, ...ui.root.children, body); return { close() {} }; },
  }, ['render']);
  const button = label => ui.nodes.find(node => node.isConnected && node.tag === 'button' && node.children.includes('communities.' + label));
  return { ui, calls, render, button };
}

test('administración mantiene listar, ver y moderar comunidades sin acciones de clanes', async () => {
  const r = adminRig();
  await r.render(r.ui.root); await flush();
  // La pestaña abre en la cola de GIFs; las comunidades están a un clic.
  assert.equal(r.calls[0][0], 'admin_community_media_queue');
  await r.button('adminTab_community').fire('click'); await flush();
  assert.equal(r.calls[1][0], 'admin_groups');
  assert.equal(r.calls[1][1].p_kind, 'community');
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
  const closeButtons = r.ui.nodes.filter(node => node.isConnected && node.tag === 'button' && node.children.includes('communities.adminReportClose'));
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
  assert.doesNotMatch(read('../../../features/serverremote/remote.js'), /privacy.*streamer|isStreamer/);
  assert.doesNotMatch(read('../../../features/whatsnew.js'), /navigate\('(seeds|extensions|clans|compete|tools)'\)/);
  for (const lang of ['es', 'en']) {
    const texts = vm.runInNewContext(read('../../../../i18n/' + lang + '/whatsnew.js').replace('export default', 'module.exports ='), { module: { exports: {} } });
    for (const [key, text] of Object.entries(texts)) {
      assert.doesNotMatch(String(text), /\b(OBS|streamer|extension(?:es)?|semillas?|seed viewer|Competir|Compete|toolbox|caja de herramientas)\b/i, `${lang}/whatsnew.${key} anuncia una función retirada`);
    }
  }
});

test('los archivos de las funciones retiradas de la 4.6 ya no existen', () => {
  const gone = [
    'pages/compete.js', 'pages/compete', 'features/compete.js', 'pages/admin/events.js',
    'pages/seeds.js', 'pages/seeds',
    'pages/extensions.js', 'pages/extensions', 'features/extensions.js', 'features/extensions', 'pages/admin/extensions.js',
    'features/streamer.js', 'features/streamer', 'features/clipstudio/obs-panel.js',
    'pages/tools.js', 'pages/tools', 'features/tools.js', 'features/tools',
  ];
  for (const rel of gone) assert.equal(fs.existsSync(new URL('../../../' + rel, import.meta.url)), false, rel);
  for (const ns of ['compete', 'seeds', 'extensions', 'tools']) {
    for (const lang of ['es', 'en', 'de', 'ja']) assert.equal(fs.existsSync(new URL('../../../../i18n/' + lang + '/' + ns + '.js', import.meta.url)), false, `${lang}/${ns}.js`);
  }
  assert.match(read('../../../../index.html'), /frame-src 'none'/);
});

test('el cuidado del juego (descansos, resumen, versión nueva y descargas programadas) sigue en features/playcare', () => {
  const startup = read('../../playcare.js');
  for (const part of ['mcnews', 'breaks', 'recap', 'schedule']) assert.match(startup, new RegExp('./playcare/' + part + '\\.js'));
  assert.doesNotMatch(startup, /registerPage/);
  assert.match(read('../../../app.js'), /features\/playcare\.js/);
});
