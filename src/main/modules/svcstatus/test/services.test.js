'use strict';
// Pruebas del catálogo: qué se consulta, con qué cabeceras y qué se saltea.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDefs, safeHeaders, pickIds, IDS, GROUPS } = require('../services');
const { CLOUD } = require('./helpers');

const byId = (defs) => Object.fromEntries(defs.map((d) => [d.id, d]));

test('todos los servicios tienen grupo conocido y solo HEAD o GET por https', () => {
  const defs = buildDefs({ curseforgeApiKey: 'k', cloud: CLOUD, userAgent: 'VenusLauncher/9' });
  assert.deepEqual(defs.map((d) => d.id), IDS);
  for (const d of defs) {
    assert.ok(GROUPS.includes(d.group), d.id);
    for (const r of d.requests) {
      assert.ok(['HEAD', 'GET'].includes(r.method), d.id);
      assert.match(r.url, /^https:\/\//);
      assert.equal(r.headers['User-Agent'], 'VenusLauncher/9');
    }
  }
});

test('CurseForge: clave directa o comprobación pública del servidor central', () => {
  const withKey = byId(buildDefs({ curseforgeApiKey: 'cf-secret', cloud: CLOUD }));
  assert.equal(withKey.curseforge.skip, null);
  assert.equal(withKey.curseforge.requests[0].headers['x-api-key'], 'cf-secret');
  for (const d of Object.values(withKey)) {
    if (d.id === 'curseforge') continue;
    for (const r of d.requests) assert.ok(!('x-api-key' in r.headers), `${d.id} no lleva la key de CurseForge`);
  }
  const central = byId(buildDefs({ curseforgeApiKey: '', cloud: CLOUD })).curseforge;
  assert.equal(central.skip, null);
  assert.equal(central.requests[0].method, 'GET');
  assert.equal(central.requests[0].url, CLOUD.url + '/rest/v1/rpc/curseforge_status');
  assert.equal(central.requests[0].headers['x-api-key'], undefined);
  const noKey = byId(buildDefs({ curseforgeApiKey: '', cloud: null }));
  assert.equal(noKey.curseforge.skip, 'noKey');
  assert.deepEqual(noKey.curseforge.requests, []);
  assert.equal(byId(buildDefs({ curseforgeApiKey: '   ', cloud: null })).curseforge.skip, 'noKey');
});

test('Venus: GET a /auth/v1/health con la anon key pública; sin proyecto se saltea', () => {
  const venus = byId(buildDefs({ cloud: CLOUD })).venus;
  assert.equal(venus.requests[0].url, 'https://abcdefghijklmnop.supabase.co/auth/v1/health');
  assert.equal(venus.requests[0].method, 'GET');
  assert.equal(venus.requests[0].headers.apikey, 'public-anon-key');
  assert.equal(byId(buildDefs({ cloud: { ...CLOUD, configured: false } })).venus.skip, 'notConfigured');
  assert.equal(byId(buildDefs({ cloud: null })).venus.skip, 'notConfigured');
});

test('safeHeaders: una clave nunca sale hacia otro host', () => {
  const req = { url: 'https://evil.example.com/', headers: { 'User-Agent': 'V', 'x-api-key': 'cf-secret', apikey: 'anon', Cookie: 'a=b', Authorization: 'Bearer x' }, secretHost: 'api.curseforge.com' };
  assert.deepEqual(safeHeaders(req), { 'User-Agent': 'V' });
  assert.deepEqual(safeHeaders({ ...req, url: 'https://api.curseforge.com/' }), { 'User-Agent': 'V', 'x-api-key': 'cf-secret', apikey: 'anon' });
  assert.deepEqual(safeHeaders({ url: 'https://api.modrinth.com/', headers: { 'x-api-key': 'k' } }), {});
});

test('pickIds: solo ids conocidos, en orden y sin repetir', () => {
  assert.deepEqual(pickIds(['modrinth', 'nope', 'microsoft', 'modrinth', 42, 'x'.repeat(80)]), ['microsoft', 'modrinth']);
  assert.deepEqual(pickIds(null), IDS);
  assert.deepEqual(pickIds([]), IDS);
});
