const { describe, it, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns');
const http = require('node:http');
const net = require('node:net');
const { findIcon, iconLinks, sniffImage, parseSavedIcons, createIconStore } = require('../src/favicon');

const TIMEOUT_MS = 500;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16]);
const servers = [];

// Loopback servers stand in for routes. Each serves the paths in `files` and 404s everything else.
async function site(files) {
  const server = http.createServer((req, res) => {
    const file = files[req.url];
    if (!file) return res.writeHead(404, { 'Content-Type': 'text/html' }).end('<html>Not found</html>');
    if (file.redirect) return res.writeHead(302, { Location: file.redirect }).end();
    res.writeHead(file.status || 200, { 'Content-Type': file.type || 'application/octet-stream' }).end(file.body);
  });
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

function page(head) {
  return { type: 'text/html; charset=utf-8', body: `<!doctype html><html><head>${head}</head><body></body></html>` };
}

after(() => {
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
});

describe('iconLinks', () => {
  it('ranks SVG icons, then apple-touch-icons, then other icons largest first', () => {
    const html = `
      <link rel="icon" href="/small.png" sizes="16x16">
      <link rel="icon" href="/large.png" sizes="32x32 96x96">
      <link rel="apple-touch-icon" href="/touch.png">
      <link rel="icon" type="image/svg+xml" href="/logo.svg">
      <link rel="stylesheet" href="/app.css">`;
    assert.deepEqual(iconLinks(html, 'http://app.test/'), [
      'http://app.test/logo.svg',
      'http://app.test/touch.png',
      'http://app.test/large.png',
      'http://app.test/small.png',
    ]);
  });

  it('resolves relative links against the page and its <base>', () => {
    const html = `<base href="/web/"><link rel='shortcut icon' href='favicon.png?a=1&amp;b=2'>`;
    assert.deepEqual(iconLinks(html, 'http://app.test/start'), ['http://app.test/web/favicon.png?a=1&b=2']);
  });

  it('skips links that are not http or https', () => {
    assert.deepEqual(iconLinks('<link rel="icon" href="data:image/png;base64,AAAA">', 'http://app.test/'), []);
  });
});

describe('sniffImage', () => {
  const cases = [
    ['PNG', PNG, 'image/png'],
    ['ICO', ICO, 'image/x-icon'],
    ['GIF', Buffer.from('GIF89a......'), 'image/gif'],
    ['JPEG', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
    ['WebP', Buffer.from('RIFF\0\0\0\0WEBPVP8 '), 'image/webp'],
    ['SVG', Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml'],
    ['an HTML page that contains an SVG', Buffer.from('<html><body><svg></svg></body></html>'), null],
    ['plain text', Buffer.from('Not found'), null],
    ['an empty body', Buffer.alloc(0), null],
  ];
  for (const [what, body, type] of cases) {
    it(`identifies ${what} as ${type ?? 'not an image'}`, () => {
      assert.equal(sniffImage(body), type);
    });
  }
});

describe('findIcon', () => {
  it('uses the best icon the page links to', async () => {
    const base = await site({
      '/': page('<link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/touch.png">'),
      '/touch.png': { body: PNG },
      '/favicon.ico': { body: ICO },
    });
    const icon = await findIcon(`${base}/`, { timeoutMs: TIMEOUT_MS });
    assert.deepEqual([icon.type, icon.body], ['image/png', PNG]);
  });

  it('falls back to /favicon.ico when the page links to no icon', async () => {
    const base = await site({ '/': page('<title>App</title>'), '/favicon.ico': { body: ICO } });
    const icon = await findIcon(`${base}/`, { timeoutMs: TIMEOUT_MS });
    assert.equal(icon.type, 'image/x-icon');
  });

  it('skips a linked icon that turns out not to be an image', async () => {
    const base = await site({
      '/': page('<link rel="icon" href="/broken.png">'),
      '/broken.png': { type: 'image/png', body: '<html>Sign in</html>' },
      '/favicon.ico': { body: ICO },
    });
    const icon = await findIcon(`${base}/`, { timeoutMs: TIMEOUT_MS });
    assert.equal(icon.type, 'image/x-icon');
  });

  it('follows redirects on the same host, resolving icons against the page it lands on', async () => {
    const base = await site({
      '/': { redirect: '/web/' },
      '/web/': page('<link rel="icon" href="icon.png">'),
      '/web/icon.png': { body: PNG },
    });
    const icon = await findIcon(`${base}/`, { timeoutMs: TIMEOUT_MS });
    assert.equal(icon.type, 'image/png');
  });

  describe('redirects between named hosts', () => {
    // Every name resolves to loopback, where each site listens on its own port.
    const lookup = (hostname, options, callback) => dns.lookup('127.0.0.1', options, callback);

    // Finds the icon of a site on `from` that redirects everything to a site on `to` with an icon.
    async function iconAfterRedirect(from, to) {
      const target = (await site({ '/': page('<link rel="icon" href="/icon.png">'), '/icon.png': { body: PNG } })).replace('127.0.0.1', to);
      const start = await site({ '/': { redirect: `${target}/` }, '/favicon.ico': { redirect: `${target}/icon.png` } });
      return findIcon(`${start.replace('127.0.0.1', from)}/`, { timeoutMs: TIMEOUT_MS, lookup });
    }

    it('follows a redirect from a bare domain to its www. name', async () => {
      assert.equal((await iconAfterRedirect('app.test', 'www.app.test'))?.type, 'image/png');
    });

    it('follows a redirect from a www. name to its bare domain', async () => {
      assert.equal((await iconAfterRedirect('www.app.test', 'app.test'))?.type, 'image/png');
    });

    it('does not follow a redirect to another subdomain, such as a login page', async () => {
      assert.equal(await iconAfterRedirect('app.test', 'login.app.test'), null);
    });
  });

  it('does not follow a redirect to another host, such as a login page', async () => {
    const login = await site({ '/': page('<link rel="icon" href="/login.png">'), '/login.png': { body: PNG }, '/favicon.ico': { body: ICO } });
    const base = await site({ '/': { redirect: `${login.replace('127.0.0.1', 'localhost')}/` }, '/favicon.ico': { redirect: `${login.replace('127.0.0.1', 'localhost')}/favicon.ico` } });
    assert.equal(await findIcon(`${base}/`, { timeoutMs: TIMEOUT_MS }), null);
  });

  it('still tries /favicon.ico when the page answers with an error', async () => {
    const base = await site({ '/': { status: 401, type: 'text/html', body: 'Unauthorized' }, '/favicon.ico': { body: ICO } });
    const icon = await findIcon(`${base}/`, { timeoutMs: TIMEOUT_MS });
    assert.equal(icon.type, 'image/x-icon');
  });

  it('gives up when the route cannot be reached', async () => {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    assert.equal(await findIcon(`http://127.0.0.1:${port}/`, { timeoutMs: TIMEOUT_MS }), null);
  });

  it('connects to the given address while asking for the route by its own hostname', async () => {
    const base = await site({ '/favicon.ico': { body: ICO } });
    const { port } = new URL(base);
    const icon = await findIcon(`http://app.invalid:${port}/`, { timeoutMs: TIMEOUT_MS, address: '127.0.0.1' });
    assert.equal(icon.type, 'image/x-icon');
  });
});

describe('createIconStore', () => {
  const HOUR = 60 * 60 * 1000;
  const up = { reachable: true, statusCode: 200 };
  let clock;
  let lookups;
  let found;

  function makeStore(options = {}) {
    const find = async url => {
      lookups.push(url);
      return found;
    };
    return createIconStore({ find, now: () => clock, ...options });
  }

  function route(id, health = up, url = `http://${id}.test`) {
    return { id, url, status: 'enabled', health };
  }

  beforeEach(() => {
    clock = Date.parse('2026-01-01T00:00:00Z');
    lookups = [];
    found = { type: 'image/png', body: PNG, hash: 'abc' };
  });

  it('looks up icons for reachable routes and serves what it found', async () => {
    const store = makeStore();
    await store.refresh([route('a')]);
    assert.deepEqual(store.get('a'), found);
  });

  it('does not look up routes that are down, disabled, not routed by Traefik or have no link', async () => {
    const store = makeStore();
    await store.refresh([
      route('down', { reachable: false }),
      route('error', { reachable: true, statusCode: 502 }),
      route('unrouted', { reachable: true, statusCode: 404, unrouted: true }),
      route('unchecked', null),
      { ...route('off'), status: 'disabled' },
      { ...route('nolink'), url: null },
    ]);
    assert.deepEqual(lookups, []);
  });

  it('does not look a route up again until its icon is a day old', async () => {
    const store = makeStore();
    await store.refresh([route('a')]);
    clock += 23 * HOUR;
    await store.refresh([route('a')]);
    clock += HOUR;
    await store.refresh([route('a')]);
    assert.equal(lookups.length, 2);
  });

  it('retries a route with no icon after an hour', async () => {
    found = null;
    const store = makeStore();
    await store.refresh([route('a')]);
    clock += HOUR;
    await store.refresh([route('a')]);
    assert.equal(lookups.length, 2);
  });

  it('looks a route up again when its URL changes', async () => {
    const store = makeStore();
    await store.refresh([route('a')]);
    await store.refresh([route('a', up, 'http://a.test/app')]);
    assert.deepEqual(lookups, ['http://a.test', 'http://a.test/app']);
  });

  it('keeps the icon it had when a later lookup finds nothing', async () => {
    const store = makeStore();
    await store.refresh([route('a')]);
    const first = found;
    found = null;
    clock += 24 * HOUR;
    await store.refresh([route('a')]);
    assert.deepEqual(store.get('a'), first);
  });

  it('forgets icons of routes that are no longer listed', async () => {
    const store = makeStore();
    await store.refresh([route('a')]);
    await store.refresh([]);
    assert.equal(store.get('a'), null);
  });

  it('reuses a refresh that is still running instead of starting another', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const store = makeStore({ find: async url => { lookups.push(url); await gate; return found; } });
    const first = store.refresh([route('a')]);
    const second = store.refresh([route('a')]);
    release();
    await Promise.all([first, second]);
    assert.equal(lookups.length, 1);
  });

  it('tells onChange about a route only when its icon is a different one', async () => {
    const changed = [];
    const store = makeStore({ onChange: id => changed.push(id) });
    await store.refresh([route('a')]);
    clock += 24 * HOUR;
    await store.refresh([route('a')]);
    found = { ...found, hash: 'def' };
    clock += 24 * HOUR;
    await store.refresh([route('a')]);
    assert.deepEqual(changed, ['a', 'a']);
  });

  it('resolves a refresh to whether the icons worth saving changed', async () => {
    const store = makeStore();
    assert.equal(await store.refresh([route('a')]), true);
    assert.equal(await store.refresh([route('a')]), false);
    assert.equal(await store.refresh([]), true);
    found = null;
    assert.equal(await store.refresh([route('b')]), false);
  });

  it('serves saved icons without looking them up until they are due', async () => {
    const saved = new Map([['a', { url: 'http://a.test', checkedAt: clock - 23 * HOUR, icon: found }]]);
    const store = makeStore({ saved });
    await store.refresh([route('a')]);
    assert.deepEqual(lookups, []);
    assert.deepEqual(store.get('a'), found);
    clock += HOUR;
    await store.refresh([route('a')]);
    assert.deepEqual(lookups, ['http://a.test']);
  });

  it('saves only the routes that have an icon, and loads them back', async () => {
    const store = makeStore();
    await store.refresh([route('a')]);
    found = null;
    await store.refresh([route('a'), route('b')]);
    const saved = parseSavedIcons(store.serialize());
    assert.deepEqual([...saved.keys()], ['a']);
    const { url, checkedAt, icon } = saved.get('a');
    assert.deepEqual([url, checkedAt, icon.type, icon.body], ['http://a.test', clock, 'image/png', PNG]);
  });
});

describe('parseSavedIcons', () => {
  const entry = (data, extra = {}) => ({ url: 'http://a.test', checkedAt: '2026-01-01T00:00:00.000Z', data: data.toString('base64'), ...extra });

  it('takes the type and hash from the image rather than the file', () => {
    const icon = parseSavedIcons(JSON.stringify({ a: entry(ICO, { type: 'text/html', hash: 'x' }) })).get('a').icon;
    assert.equal(icon.type, 'image/x-icon');
    assert.match(icon.hash, /^[0-9a-f]{12}$/);
  });

  it('drops entries that are not an image or are missing fields', () => {
    const saved = parseSavedIcons(JSON.stringify({
      html: entry(Buffer.from('<html><body>login</body></html>')),
      nourl: entry(PNG, { url: null }),
      nodate: entry(PNG, { checkedAt: 'soon' }),
      nodata: { url: 'http://a.test', checkedAt: '2026-01-01T00:00:00.000Z' },
      ok: entry(PNG),
    }));
    assert.deepEqual([...saved.keys()], ['ok']);
  });

  it('loads nothing from an empty file', () => {
    assert.equal(parseSavedIcons(' \n').size, 0);
  });

  it('loads nothing from a file that is not an object', () => {
    assert.equal(parseSavedIcons('[]').size, 0);
  });
});
