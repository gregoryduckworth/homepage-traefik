const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { normalizeGroups, normalizeRouteSettings, storedHealth, createConfigStore } = require('../src/config');

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

describe('normalizeRouteSettings', () => {
  it('trims names and icons', () => {
    const settings = normalizeRouteSettings({ 'a@docker': { name: ' Jellyfin ', icon: ' https://cdn.test/jellyfin.svg ' } });
    assert.deepEqual(settings, { 'a@docker': { name: 'Jellyfin', icon: 'https://cdn.test/jellyfin.svg' } });
  });

  it('keeps only the fields that are set', () => {
    assert.deepEqual(normalizeRouteSettings({ 'a@docker': { name: 'App', icon: '' } }), { 'a@docker': { name: 'App' } });
  });

  it('keeps a hidden flag, but only when it is true', () => {
    assert.deepEqual(normalizeRouteSettings({ 'a@docker': { hidden: true }, 'b@docker': { name: 'B', hidden: false } }), {
      'a@docker': { hidden: true },
      'b@docker': { name: 'B' },
    });
  });

  it('drops entries with neither a name nor an icon', () => {
    assert.deepEqual(normalizeRouteSettings({ 'a@docker': { name: ' ' } }), {});
  });

  const invalid = [
    ['routes is a list', [], /must be an object keyed by router name/],
    ['an entry is not an object', { 'a@docker': 'App' }, /Settings for route "a@docker" must be an object/],
    ['a name is not text', { 'a@docker': { name: 1 } }, /"name" for route "a@docker" must be text/],
    ['a name is too long', { 'a@docker': { name: 'x'.repeat(61) } }, /at most 60 characters/],
    ['an icon is not a web address', { 'a@docker': { icon: 'jellyfin.svg' } }, /icon for route "a@docker" must be the http:\/\/ or https:\/\/ address/],
    ['hidden is not true or false', { 'a@docker': { hidden: 'yes' } }, /"hidden" for route "a@docker" must be true or false/],
    ['an icon uses another scheme', { 'a@docker': { icon: 'javascript:alert(1)' } }, /must be the http:\/\/ or https:\/\/ address/],
  ];
  for (const [when, input, message] of invalid) {
    it(`rejects input when ${when}`, () => {
      assert.throws(() => normalizeRouteSettings(input), { status: 400, message });
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

  it('reads route names and icons from the file', async () => {
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, JSON.stringify({ routes: { 'a@docker': { name: 'App' } } }));
    const { routes } = await createConfigStore({ file }).read();
    assert.deepEqual(routes, { 'a@docker': { name: 'App' } });
  });

  it('saves the name and icon of a route beside the groups without changing them', async () => {
    const store = createConfigStore({ file });
    await store.saveGroups([{ name: 'Media', routes: ['a@docker'] }]);
    const saved = await store.saveRoute('a@docker', { name: 'App', icon: 'https://cdn.test/app.png' });
    assert.deepEqual(saved, { name: 'App', icon: 'https://cdn.test/app.png' });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {
      groups: [{ name: 'Media', routes: ['a@docker'] }],
      routes: { 'a@docker': { name: 'App', icon: 'https://cdn.test/app.png' } },
    });
  });

  it('keeps route names and icons when groups are saved', async () => {
    const store = createConfigStore({ file });
    await store.saveRoute('a@docker', { name: 'App' });
    await store.saveGroups([{ name: 'Media' }]);
    assert.deepEqual((await store.read()).routes, { 'a@docker': { name: 'App' } });
  });

  it('removes the entry for a route when its name and icon are cleared', async () => {
    const store = createConfigStore({ file });
    await store.saveRoute('a@docker', { name: 'App' });
    assert.equal(await store.saveRoute('a@docker', { name: '', icon: '' }), null);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), {});
  });

  it('keeps the fields a save leaves out', async () => {
    const store = createConfigStore({ file });
    await store.saveRoute('a@docker', { name: 'App', icon: 'https://cdn.test/app.png' });
    assert.deepEqual(await store.saveRoute('a@docker', { hidden: true }), { name: 'App', icon: 'https://cdn.test/app.png', hidden: true });
    assert.deepEqual(await store.saveRoute('a@docker', { name: 'Renamed' }), { name: 'Renamed', icon: 'https://cdn.test/app.png', hidden: true });
    assert.deepEqual(await store.saveRoute('a@docker', { hidden: false, icon: '' }), { name: 'Renamed' });
  });

  it('refuses a hidden flag that is not true or false before saving', async () => {
    await assert.rejects(createConfigStore({ file }).saveRoute('a@docker', { hidden: 1 }), { status: 400 });
  });

  it('refuses to save route settings over a file that does not parse', async () => {
    await fs.mkdir(path.dirname(file));
    await fs.writeFile(file, 'not json');
    await assert.rejects(createConfigStore({ file }).saveRoute('a@docker', { name: 'App' }), { status: 409 });
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
