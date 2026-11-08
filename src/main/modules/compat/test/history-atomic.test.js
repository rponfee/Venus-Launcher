'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const history = require('../history');

test('failed finalization can undo placed mod files after saving the history index', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'venus-compat-atomic-'));
  try {
    await fs.mkdir(path.join(root, 'mods'));
    await fs.writeFile(path.join(root, 'mods', 'old.jar'), 'old');
    const batch = history.createBatch(root, 'update');
    const storedAs = await history.stash(batch, 'mods', 'old.jar');
    await fs.writeFile(path.join(root, 'mods', 'new.jar'), 'new');
    const entry = {
      folder: 'mods',
      old: { file: 'old.jar', storedAs, disabled: false },
      new: { file: 'new.jar', disabled: false },
      placed: true,
    };
    batch.index.entries.push(entry);
    await history.saveBatch(batch);
    assert.equal(entry.placed, true);
    const saved = JSON.parse(await fs.readFile(path.join(batch.dir, 'index.json'), 'utf8'));
    assert.equal(saved.entries[0].placed, undefined);
    assert.equal(await history.undoEntries(batch, batch.index.entries), true);
    assert.equal(await fs.readFile(path.join(root, 'mods', 'old.jar'), 'utf8'), 'old');
    await assert.rejects(fs.stat(path.join(root, 'mods', 'new.jar')), { code: 'ENOENT' });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
