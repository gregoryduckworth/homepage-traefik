const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { saveQuietly, readCache } = require('../src/files');

describe('saveQuietly', () => {
  it('runs one save at a time, in the order they were asked for', async () => {
    const order = [];
    let release;
    const first = new Promise(resolve => { release = resolve; });
    let calls = 0;
    const save = saveQuietly('Saving', async () => {
      const call = ++calls;
      order.push(`start ${call}`);
      if (call === 1) await first;
      order.push(`end ${call}`);
    });
    save();
    const second = save();
    release();
    await second;
    assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('logs a failure once while it keeps failing the same way', async t => {
    t.mock.method(console, 'error', () => {});
    const save = saveQuietly('Saving icons', async () => { throw new Error('read-only file system'); });
    await save();
    await save();
    assert.equal(console.error.mock.callCount(), 1);
    assert.equal(console.error.mock.calls[0].arguments[0], 'Saving icons failed: read-only file system');
  });

  it('logs the same failure again after a save has worked in between', async t => {
    t.mock.method(console, 'error', () => {});
    let fail = true;
    const save = saveQuietly('Saving icons', async () => { if (fail) throw new Error('disk full'); });
    await save();
    fail = false;
    await save();
    fail = true;
    await save();
    assert.equal(console.error.mock.callCount(), 2);
  });
});

describe('readCache', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'homepage-files-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('resolves to the parsed contents of the file', async () => {
    const file = path.join(dir, 'icons.json');
    await fs.writeFile(file, '{"a":1}');
    assert.deepEqual(await readCache(file, JSON.parse), { a: 1 });
  });

  it('resolves to null without a warning when the file does not exist', async t => {
    t.mock.method(console, 'warn', () => {});
    assert.equal(await readCache(path.join(dir, 'missing.json'), JSON.parse), null);
    assert.equal(console.warn.mock.callCount(), 0);
  });

  it('warns and resolves to null when the file does not parse', async t => {
    t.mock.method(console, 'warn', () => {});
    const file = path.join(dir, 'icons.json');
    await fs.writeFile(file, '{ nope');
    assert.equal(await readCache(file, JSON.parse), null);
    assert.match(console.warn.mock.calls[0].arguments[0], /^Ignoring .*icons\.json: /);
  });

  it('explains a directory Docker made in place of the file', async t => {
    t.mock.method(console, 'warn', () => {});
    assert.equal(await readCache(dir, JSON.parse), null);
    assert.match(console.warn.mock.calls[0].arguments[0], /is a directory, not a file, so it won't be saved\. Docker creates a directory/);
  });
});
