// Retiro de Comunidades (6.1): sin ruta, menú ni integraciones. Sin DOM, cuentas ni red: lee el código y recorre sus imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { normalizeNav, navLayout } from '../../navcustom/logic.js';

const JS = new URL('../../../', import.meta.url);
const I18N = new URL('../../../../i18n/', import.meta.url);
const read = (relative) => fs.readFileSync(new URL(relative, JS), 'utf8');
const exists = (relative, base = JS) => fs.existsSync(new URL(relative, base));

// NAV, PAGES y STARTUP de app.js evaluados sin cargar nada (cada import() queda anotado).
function appConfig() {
  const source = read('app.js');
  const declaration = (name) => {
    const found = source.match(new RegExp('const ' + name + ' = [\\s\\S]*?^(?:\\];|\\};)', 'm'));
    assert.ok(found, name);
    return found[0];
  };
  const loaded = [];
  const config = vm.runInNewContext(
    ['NAV', 'PAGES', 'STARTUP'].map(declaration).join('\n').replace(/\bimport\(/g, 'load(') + '\n;({NAV,PAGES,STARTUP})',
    { load: async (name) => { loaded.push(name); return {}; } },
  );
  return { source, config, loaded };
}

// Archivos que alcanza una página siguiendo sus imports relativos (estáticos y dinámicos con texto fijo). El panel de
// Administración (pages/admin*) no se recorre: es una página aparte, solo para administradores, con sus propias pruebas.
function importGraph(entry) {
  const seen = new Set();
  const missing = [];
  const walk = (url) => {
    if (seen.has(url.href) || /\/pages\/admin(\/|\.js$)/.test(url.pathname)) return;
    seen.add(url.href);
    if (!fs.existsSync(url)) return missing.push(url.pathname);
    // Sin las líneas de comentario (algunas muestran imports de ejemplo)
    const code = fs.readFileSync(url, 'utf8').split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
    for (const m of code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)) walk(new URL(m[1], url));
  };
  walk(new URL(entry, JS));
  return { files: [...seen].map((href) => new URL(href).pathname), missing };
}

test('Comunidades no tiene ruta, entrada en el menú ni arranque propio', async () => {
  const { source, config, loaded } = appConfig();
  assert.equal(config.NAV.some((item) => item.id === 'communities'), false);
  assert.equal('communities' in config.PAGES, false);
  await Promise.all(config.STARTUP.map((load) => load()));
  assert.equal(loaded.some((name) => /communit/i.test(name)), false);
  // Una ruta vieja (#/communities, venus:// o un acceso guardado) cae en el Inicio: el router solo abre lo que está en PAGES.
  assert.match(source, /hasOwnProperty\.call\(PAGES, name\) \? name : 'home'/);
  for (const id of ['home', 'voice', 'messages', 'multiplayer', 'servers']) assert.equal(typeof config.PAGES[id], 'function', id);
});

test('una preferencia de menú guardada con communities se ignora sin romper el resto', () => {
  const { config } = appConfig();
  const ids = config.NAV.map((item) => item.id).filter(Boolean);
  const prefs = normalizeNav({ order: ['communities', 'messages', 'voice'], pinned: ['communities', 'voice'], hidden: ['communities', 'servers'], iconPack: 'pixel' }, ids);
  assert.deepEqual(prefs.order, ['messages', 'voice']);
  assert.deepEqual(prefs.pinned, ['voice']);
  assert.deepEqual(prefs.hidden, ['servers']);
  assert.equal(prefs.iconPack, 'pixel');
  const layout = navLayout(config.NAV, prefs).map((item) => item.id).filter(Boolean);
  assert.equal(layout.includes('communities'), false);
  assert.ok(layout.includes('voice') && layout.includes('messages') && !layout.includes('servers'));
});

test('Voice Chat, Mensajes, Inicio y el menú cargan sin código de Comunidades', () => {
  for (const entry of ['pages/voice.js', 'pages/messages.js', 'pages/home.js', 'app.js', 'features/navcustom.js', 'features/whatsnew.js', 'features/plans.js']) {
    const { files, missing } = importGraph(entry);
    assert.deepEqual(missing, [], `${entry} importa archivos que no existen`);
    assert.deepEqual(files.filter((f) => /\/communities(\/|\.js$)|communityplans/.test(f)), [], `${entry} todavía llega a Comunidades`);
  }
  assert.doesNotMatch(read('voice/ui-room.js'), /attachStage|communities\//);
  assert.doesNotMatch(read('features/plans.js'), /communityplans|communityId|plan\.clan/);
});

test('los archivos de la página de Comunidades ya no existen', () => {
  const gone = [
    'pages/communities.js', 'pages/communities/view.js', 'pages/communities/chat.js', 'pages/communities/looks-view.js',
    'pages/communities/plan.js', 'pages/communities/test', 'features/communities/looks.js', 'features/communities/report.js',
  ];
  for (const rel of gone) assert.equal(exists(rel), false, rel);
  assert.equal(exists('../../../scripts/gen-clan-scenes.js'), false);
});

test('las novedades no anuncian Comunidades ni llevan a su página', () => {
  assert.doesNotMatch(read('features/whatsnew.js'), /navigate\('communities/);
  for (const lang of ['es', 'en']) {
    const texts = vm.runInNewContext(fs.readFileSync(new URL(lang + '/whatsnew.js', I18N), 'utf8').replace('export default', 'module.exports ='), { module: { exports: {} } });
    // El único texto que las nombra es el aviso de que se retiraron (pantalla "Lo que cambió" de la 6.1).
    assert.match(String(texts.v61changes_b1), /retir/i, `${lang}/whatsnew.v61changes_b1`);
    for (const [key, text] of Object.entries(texts)) {
      if (key === 'v61changes_b1') continue;
      assert.doesNotMatch(String(text), /\b(comunidades|communities)\b/i, `${lang}/whatsnew.${key}`);
    }
  }
});

test('el cliente de pagos ya no ofrece ni cobra planes de clan', async () => {
  const require = createRequire(import.meta.url);
  const { normalizeCatalog, createBillingClient } = require('../../../../../main/modules/billing/client.js');
  const catalog = normalizeCatalog({ plans: [{ id: 'go', name: 'Go' }], clans: [{ id: 'clan_go', name: 'Clanes Go', prices: {} }] });
  assert.equal('clans' in catalog, false);
  assert.deepEqual(catalog.plans.map((p) => p.id), ['go']);
  const sent = [];
  const client = createBillingClient({
    t: (key) => key,
    fetch: async () => { sent.push('fetch'); return { ok: true, status: 200, json: async () => ({}) }; },
    cloudConfig: async () => ({ configured: true, url: 'https://x.invalid', anonKey: 'anon' }),
    accessToken: async () => 'token',
    openExternal: async () => {},
  });
  await assert.rejects(client.checkout({ plan: 'clan_go', provider: 'paypal', community: '00000000-0000-4000-8000-000000000000' }), { code: 'unknownPlan' });
  assert.deepEqual(sent, [], 'no llega a pedir el pago');
});
