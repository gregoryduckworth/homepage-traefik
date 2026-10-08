const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { normalizeGroups, storedHealth, createConfigStore } = require('../src/config');

describe('normalizeGroups', () => {
  it('trims group names and defaults missing routes to an empty list', () => {
    assert.deepEqual(normalizeGroups([{ name: '  Media ' }]), [{ name: 'Media', routes: [] }]);
  });

  it('keeps groups in the order they are listed', () => {
    const groups = normalizeGroups([{ name: 'Tools' }, { name: 'Media' }, { name: 'Monitoring' }]);
    assert.deepEqual(groups.map(group => group.name), ['Tools', 'Media', 'Monitoring']);
  });

  it('keeps a route only in the first group that lists it', () => {
    const groups = normalizeGroups([
      { name: 'Media', routes: ['jellyfin@docker', 'sonarr@docker'] },
      { name: 'Tools', routes: ['sonarr@docker', 'whoami@docker'] },
    ]);
    assert.deepEqual(groups.map(group => group.routes), [['jellyfin@docker', 'sonarr@docker'], ['whoami@docker']]);
  });

  const invalid = [
    ['groups is not a list', { name: 'Media' }, /must be a list/],
    ['a group is not an object', ['Media'], /Group 1 must be an object/],
    ['a group has no name', [{ name: '   ' }], /Group 1 needs a name/],
    ['a name is too long', [{ name: 'x'.repeat(61) }], /at most 60 characters/],
    ['two groups share a name, ignoring case', [{ name: 'Media' }, { name: 'media' }], /already a group called "media"/],
    ['routes holds something other than router names', [{ name: 'Media', routes: [42] }], /must be a list of router names/],
  ];
  for (const [when, input, message] of invalid) {
    it(`rejects input when ${when}`, () => {
      assert.throws(() => normalizeGroups(input), { status: 400, message });
    });
  }
});

describe('createConfigStore', () => {
  let dir;
  let file;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'homepage-config-'));
    file = path.join(dir, 'config', 'homepage.json');
  });

  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it('has no groups and no error when the file does not exist', async () => {
    const config = await createConfigStore({ file }).read();
    assert.deepEqual([config.groups, config.error], [[], null]);
  });

  it('treats an empty file as having no groups', async () => {
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, '');
    const config = await createConfigStore({ file }).read();
    assert.deepEqual([config.groups, config.error], [[], null]);
  });

  it('explains that a directory at the file path comes from mounting a missing file', async () => {
    await fs.mkdir(file, { recursive: true });
    const config = await createConfigStore({ file }).read();
    assert.match(config.error, /is a directory, not a file\. Docker creates a directory when the file you mount doesn't exist/);
  });

  it('overwrites the file in place when its directory is not writable, as with a single-file mount', async () => {
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, '{}');
    await fs.chmod(path.dirname(file), 0o555);
    try {
      await createConfigStore({ file }).saveGroups([{ name: 'Media' }]);
    } finally {
      await fs.chmod(path.dirname(file), 0o755);
    }
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(saved.groups, [{ name: 'Media', routes: [] }]);
  });

  it('leaves the file untouched when writing fails for a reason other than permissions', async () => {
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, '{"groups":[{"name":"Media"}]}');
    await fs.mkdir(`${file}.tmp`); // Writing the temp file now fails with EISDIR.
    await assert.rejects(createConfigStore({ file }).saveGroups([{ name: 'Tools' }]), { status: 500, message: /EISDIR/ });
    assert.equal(await fs.readFile(file, 'utf8'), '{"groups":[{"name":"Media"}]}');
  });

  it('creates the file and its directory when groups are saved', async () => {
    await createConfigStore({ file }).saveGroups([{ name: 'Media', routes: ['jellyfin@docker'] }]);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(saved, { groups: [{ name: 'Media', routes: ['jellyfin@docker'] }] });
  });

  it('keeps other settings in the file when groups are saved', async () => {
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, JSON.stringify({ note: 'hand edited', groups: [] }));
    await createConfigStore({ file }).saveGroups([{ name: 'Media' }]);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(saved.note, 'hand edited');
  });

  it('picks up hand edits to the file without a restart', async () => {
    const store = createConfigStore({ file });
    await store.saveGroups([{ name: 'Media' }]);
    await fs.writeFile(file, JSON.stringify({ groups: [{ name: 'Edited by hand', routes: ['a@docker'] }] }));
    const { groups } = await store.read();
    assert.deepEqual(groups, [{ name: 'Edited by hand', routes: ['a@docker'] }]);
  });

  it('reports invalid JSON and keeps the groups it last loaded', async () => {
    const store = createConfigStore({ file });
    await store.saveGroups([{ name: 'Media' }]);
    await fs.writeFile(file, '{ "groups": [ ');
    const config = await store.read();
    assert.deepEqual(config.groups, [{ name: 'Media', routes: [] }]);
    assert.match(config.error, /homepage\.json is invalid/);
  });

  it('refuses to overwrite a file that does not parse', async () => {
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, 'not json');
    await assert.rejects(createConfigStore({ file }).saveGroups([{ name: 'Media' }]), { status: 409, message: /homepage\.json is invalid.*Fix the file/ });
  });

  it('rejects invalid groups without touching the file', async () => {
    const store = createConfigStore({ file });
    await assert.rejects(store.saveGroups([{ name: '' }]), { status: 400 });
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  });

  it('applies concurrent saves in order, so the last one wins', async () => {
    const store = createConfigStore({ file });
    await Promise.all([store.saveGroups([{ name: 'First' }]), store.saveGroups([{ name: 'Second' }])]);
    const { groups } = await store.read();
    assert.deepEqual(groups, [{ name: 'Second', routes: [] }]);
  });

  it('saves health results beside the groups without changing them', async () => {
    const store = createConfigStore({ file });
    await store.saveGroups([{ name: 'Media', routes: ['a@docker'] }]);
    const health = { 'a@docker': { url: 'http://a.test', reachable: true, checkedAt: '2026-01-01T00:00:00.000Z' } };
    assert.equal(await store.saveHealth(health), true);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(saved, { groups: [{ name: 'Media', routes: ['a@docker'] }], health });
    await store.saveGroups([{ name: 'Tools' }]);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).health, health);
  });

  it('does not save health results over a file that does not parse', async () => {
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, 'not json');
    assert.equal(await createConfigStore({ file }).saveHealth({}), false);
    assert.equal(await fs.readFile(file, 'utf8'), 'not json');
  });
});

describe('storedHealth', () => {
  it('keeps results that name a URL and when they were checked', () => {
    const result = { url: 'http://a.test', reachable: true, checkedAt: '2026-01-01T00:00:00.000Z' };
    assert.deepEqual([...storedHealth({ health: { 'a@docker': result } })], [['a@docker', result]]);
  });

  it('drops anything else', () => {
    const health = { 'a@docker': { url: 'http://a.test' }, 'b@docker': { checkedAt: '2026-01-01T00:00:00.000Z' }, 'c@docker': null };
    for (const doc of [{}, { health: [] }, { health: 'yes' }, { health }]) assert.equal(storedHealth(doc).size, 0);
  });
});
