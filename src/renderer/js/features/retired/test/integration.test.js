// Contratos de retirada con DOM mínimo y servicios falsos. No usa cuentas ni red.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeNav, navLayout } from '../../navcustom/logic.js';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

test('rutas, menú y arranque ignoran las funciones retiradas y conservan Mundos, Voice Chat y Clips', async () => {
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
  for (const id of ['worlds', 'voice', 'messages', 'clips']) assert.equal(typeof config.PAGES[id], 'function');
  await Promise.all(config.STARTUP.map(load => load()));
  assert.equal(loaded.some(name => /\/(clans|extensions|streamer|compete|tools)\.js$/.test(name)), false);
  const prefs = normalizeNav({ order: ['clans', 'communities', 'seeds', 'compete'], pinned: ['extensions', 'communities', 'tools'], hidden: ['seeds'] }, config.NAV.map(item => item.id).filter(Boolean));
  const ids = navLayout(config.NAV, prefs).map(item => item.id).filter(Boolean);
  assert.ok(ids.includes('worlds') && !ids.includes('communities'));
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
