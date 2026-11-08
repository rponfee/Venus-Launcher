'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('preflight reports first install, account and missing version files without changing the instance', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venus-preflight-'));
  const paths = require('../../../core/paths');
  const instances = require('../../../core/instances');
  const accounts = require('../../../core/accounts');
  const preflight = require('../../preflight');
  const oldList = accounts.list;
  try {
    paths.setRoot(root);
    accounts.list = async () => ({ selected: null, accounts: [] });
    const inst = await instances.create({ name: 'Preflight', mcVersion: '1.20.1', loader: 'vanilla' });
    const first = await preflight.check(inst.id);
    assert.ok(first.checks.some((item) => item.code === 'firstInstall'));
    assert.ok(first.checks.some((item) => item.code === 'noAccount'));
    assert.equal((await instances.get(inst.id)).installed, false);

    accounts.list = async () => ({ selected: 'a', accounts: [{ id: 'a', type: 'offline' }] });
    await instances.update(inst.id, { installed: true, versionId: 'missing-test-version' });
    const missing = await preflight.check(inst.id);
    assert.ok(missing.checks.some((item) => item.code === 'missingVersion'));
    assert.equal((await instances.get(inst.id)).versionId, 'missing-test-version');
  } finally {
    accounts.list = oldList;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
