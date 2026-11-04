// Protocolo venus-ext:// y registro de instaladas. node --test "src/main/modules/extensions/test/*.test.js"
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { parseUrl, respond, cspFor } = require('../server');
const { createRegistry, STORAGE_QUOTA } = require('../registry');
const { readPackage } = require('../package');
const { makeZip, goodFiles } = require('./helpers');

function ctx(over = {}) {
  return {
    servable: () => true,
    takeToken: (id, rel, token) => token === 'buena',
    read: async () => Buffer.from('contenido'),
    ...over,
  };
}
const get = (url, c = ctx()) => respond({ url, method: 'GET' }, c);

test('parseUrl rechaza todo lo que no es exacto', () => {
  assert.deepEqual(parseUrl('venus-ext://abc/x/y.js?t=1'), { id: 'abc', rel: 'x/y.js', token: '1' });
  assert.equal(parseUrl('venus-ext://abc/'), null);
  assert.equal(parseUrl('venus-ext://ab/x.js'), null);
  assert.equal(parseUrl('venus-ext://ABC/x.js'), null);
  assert.equal(parseUrl('https://abc/x.js'), null);
  assert.equal(parseUrl('venus-ext://user:pass@abc/x.js'), null);
  assert.equal(parseUrl('venus-ext://abc:99/x.js'), null);
  assert.equal(parseUrl('venus-ext://abc/..%2f..%2fx.js'), null);
  assert.equal(parseUrl('venus-ext://abc/..%5cx.js'), null);
  assert.equal(parseUrl('venus-ext://abc/a%00b.js'), null);
  assert.equal(parseUrl('venus-ext://abc/%E0%A4%A'), null);
  assert.equal(parseUrl('venus-ext://abc/con.js'), null);
  assert.equal(parseUrl('venus-ext://abc/x.js:stream'), null);
  assert.equal(parseUrl(null), null);
});

test('un documento HTML exige su ficha', async () => {
  assert.equal((await get('venus-ext://abc/index.html')).status, 403);
  assert.equal((await get('venus-ext://abc/index.html?t=mala')).status, 403);
  const ok = await get('venus-ext://abc/index.html?t=buena');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['Content-Type'], 'text/html; charset=utf-8');
});

test('los recursos llevan CSP, nosniff y su tipo', async () => {
  const js = await get('venus-ext://abc/app.js');
  assert.equal(js.status, 200);
  assert.equal(js.headers['Content-Type'], 'text/javascript; charset=utf-8');
  assert.equal(js.headers['X-Content-Type-Options'], 'nosniff');
  assert.ok(js.headers['Content-Security-Policy'].includes("connect-src 'none'"));
  assert.equal((await get('venus-ext://abc/x.exe')).status, 404);
  assert.equal((await get('venus-ext://abc/manifest.json')).status, 404);
  assert.equal((await respond({ url: 'venus-ext://abc/app.js', method: 'POST' }, ctx())).status, 405);
});

test('el script del launcher va primero en cada documento, pase lo que pase', async () => {
  const boot = '<script src="venus-ext://abc/.venus/boot.js"></script>';
  const page = async (html) => (await get('venus-ext://abc/index.html?t=buena', ctx({ read: async () => Buffer.from(html) }))).body.toString();
  assert.equal(await page('<!doctype html><title>x</title>'), `<!doctype html>${boot}<title>x</title>`);
  assert.equal(await page('<!DOCTYPE HTML><p>'), `<!DOCTYPE HTML>${boot}<p>`);
  // Un doctype con comillas o un comentario no lo pueden tragar: va antes de todo
  assert.ok((await page('<!doctype html SYSTEM ">"><script src=a.js></script>')).startsWith(boot));
  assert.ok((await page('<!-- <!doctype html> --><p>')).startsWith(boot));
  assert.ok((await page('  <!doctype html><p>')).startsWith(boot));
  assert.ok((await page('<p>')).startsWith(boot));
  // Se sirve aunque no haya archivo con ese nombre y lo manda el launcher, no el paquete
  const script = await get('venus-ext://abc/.venus/boot.js', ctx({ read: async () => Buffer.from('robado') }));
  assert.equal(script.status, 200);
  assert.ok(script.body.toString().includes('RTC'));
  // Los archivos que no son documentos salen tal cual
  const js = await get('venus-ext://abc/app.js');
  assert.equal(js.body.toString(), 'contenido');
});

test('una extensión apagada no sirve nada', async () => {
  const c = ctx({ servable: () => false });
  assert.equal((await get('venus-ext://abc/app.js', c)).status, 404);
  assert.equal((await get('venus-ext://abc/index.html?t=buena', c)).status, 404);
});

test('la CSP cierra red, inline y marcos', () => {
  const csp = cspFor('abc');
  for (const part of ["default-src 'none'", 'script-src venus-ext://abc', 'style-src venus-ext://abc', 'img-src venus-ext://abc', "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'", "base-uri 'none'", "require-trusted-types-for 'script'", "trusted-types 'none'", 'sandbox allow-scripts']) {
    assert.ok(csp.includes(part), part);
  }
  assert.ok(!csp.includes('unsafe'));
  assert.ok(!csp.includes('allow-same-origin'));
  assert.ok(!/https?:/.test(csp));
});

function withRegistry(fn, opts = {}) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-reg-'));
    try {
      await fn(createRegistry({ dir, launcherVersion: '3.4.0', ...opts }), dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
const pkg = (over) => readPackage(makeZip(goodFiles(over)));

test(
  'instalar deja la extensión apagada y exige aceptar todos los permisos',
  withRegistry(async (reg) => {
    await assert.rejects(reg.install(pkg({ permissions: ['storage', 'notify'] }), { accepted: ['storage'] }), { code: 'permissions_required' });
    const view = await reg.install(pkg({ permissions: ['storage', 'notify'] }), { accepted: ['storage', 'notify'] });
    assert.equal(view.enabled, false);
    assert.equal(reg.servable('mi-extension'), false);
    await reg.setEnabled('mi-extension', true);
    assert.equal(reg.servable('mi-extension'), true);
  }),
);

test(
  'versión mínima del launcher',
  withRegistry(async (reg) => {
    await assert.rejects(reg.install(pkg({ minLauncherVersion: '9.0.0' }), { accepted: ['storage'] }), { code: 'launcher_too_old' });
  }),
);

test(
  'actualizar con más permisos obliga a aceptar de nuevo',
  withRegistry(async (reg) => {
    await reg.install(pkg({ permissions: ['storage'] }), { accepted: ['storage'] });
    await reg.setEnabled('mi-extension', true);
    const next = pkg({ version: '1.1.0', permissions: ['storage', 'action.launchInstance'] });
    const cmp = await reg.compare(next);
    assert.deepEqual(cmp.addedPermissions, ['action.launchInstance']);
    await assert.rejects(reg.install(next, { accepted: ['storage'] }), { code: 'permissions_required' });
    const view = await reg.install(next, { accepted: ['storage', 'action.launchInstance'] });
    assert.equal(view.version, '1.1.0');
    assert.equal(view.enabled, true);
    // Una actualización con menos permisos los pierde
    const less = await reg.install(pkg({ version: '1.2.0', permissions: [] }), { accepted: [] });
    assert.deepEqual(less.permissions, []);
  }),
);

test(
  'lista de bloqueadas: apaga, no deja prender y sobrevive al reinicio',
  withRegistry(async (reg, dir) => {
    const p = pkg();
    await reg.install(p, { accepted: ['storage'] });
    await reg.setEnabled('mi-extension', true);
    assert.deepEqual(await reg.applyBlocklist({ ids: [], hashes: [p.sha256] }), ['mi-extension']);
    assert.equal(reg.servable('mi-extension'), false);
    await assert.rejects(reg.setEnabled('mi-extension', true), { code: 'blocked' });
    const again = createRegistry({ dir, launcherVersion: '3.4.0' });
    await again.load();
    assert.equal(again.servable('mi-extension'), false);
    assert.equal((await again.list()).items[0].blocked, true);
    await assert.rejects(again.install(p, { accepted: ['storage'] }), { code: 'blocked' });
    // Por id también, y datos raros en la lista no rompen nada
    await again.applyBlocklist({ ids: ['mi-extension', 7, '../x'], hashes: 'no' });
    assert.equal((await again.list()).items[0].blocked, true);
  }),
);

test(
  'modo seguro: no se sirve nada aunque esté prendida',
  withRegistry(async (reg) => {
    await reg.install(pkg(), { accepted: ['storage'] });
    await reg.setEnabled('mi-extension', true);
    await reg.setSafeMode(true);
    assert.equal(reg.servable('mi-extension'), false);
    await reg.setSafeMode(false);
    assert.equal(reg.servable('mi-extension'), true);
  }),
);

test(
  'modo seguro por la línea de comandos manda sobre todo',
  withRegistry(
    async (reg) => {
      await reg.install(pkg(), { accepted: ['storage'] });
      await reg.setEnabled('mi-extension', true);
      await reg.setSafeMode(false);
      assert.equal(reg.servable('mi-extension'), false);
      assert.equal((await reg.list()).safeMode, true);
    },
    { forceSafeMode: true },
  ),
);

test(
  'desinstalar borra archivos y datos',
  withRegistry(async (reg, dir) => {
    await reg.install(pkg(), { accepted: ['storage'] });
    await reg.setEnabled('mi-extension', true);
    await reg.storageSet('mi-extension', 'k', 1);
    assert.ok(fs.existsSync(path.join(dir, 'mi-extension', 'storage.json')));
    await reg.uninstall('mi-extension');
    assert.equal(fs.existsSync(path.join(dir, 'mi-extension')), false);
    assert.deepEqual((await reg.list()).items, []);
  }),
);

test(
  'almacenamiento: permiso, claves y cupo de 1 MB por extensión',
  withRegistry(async (reg) => {
    await reg.install(pkg({ permissions: [] }), { accepted: [] });
    await reg.setEnabled('mi-extension', true);
    await assert.rejects(reg.storageSet('mi-extension', 'k', 1), { code: 'permission_denied' });
    await reg.install(pkg({ permissions: ['storage'] }), { accepted: ['storage'] });
    await reg.storageSet('mi-extension', 'k', { a: [1, 'dos'] });
    assert.deepEqual(await reg.storageGet('mi-extension', 'k'), { a: [1, 'dos'] });
    assert.equal(await reg.storageGet('mi-extension', 'nada'), null);
    assert.deepEqual(await reg.storageKeys('mi-extension'), ['k']);
    for (const key of ['__proto__', 'constructor', '../x', '', 'x'.repeat(65), 7]) await assert.rejects(reg.storageSet('mi-extension', key, 1), { code: 'bad_request' });
    await assert.rejects(reg.storageSet('mi-extension', 'grande', 'x'.repeat(STORAGE_QUOTA)), { code: 'quota_exceeded' });
    assert.equal(await reg.storageGet('mi-extension', 'grande'), null);
    assert.equal(await reg.storageRemove('mi-extension', 'k'), true);
    assert.equal(await reg.storageRemove('mi-extension', 'k'), false);
    await reg.setEnabled('mi-extension', false);
    await assert.rejects(reg.storageGet('mi-extension', 'k'), { code: 'permission_denied' });
  }),
);

test(
  'read solo devuelve archivos del paquete de esa extensión',
  withRegistry(async (reg, dir) => {
    await reg.install(pkg(), { accepted: ['storage'] });
    assert.equal((await reg.read('mi-extension', 'app.js')).toString(), 'console.log(1);');
    assert.equal(await reg.read('mi-extension', '../registry.json'), null);
    assert.equal(await reg.read('mi-extension', '..\\registry.json'), null);
    assert.equal(await reg.read('mi-extension', 'no-existe.js'), null);
    await assert.rejects(reg.read('../x', 'app.js'));
    assert.ok(fs.existsSync(path.join(dir, 'registry.json')));
  }),
);
