const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs/promises');
const net = require('node:net');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { createServer, shutDown } = require('../src/server');
const { createRouteStore } = require('../src/routeStore');
const { createConfigStore } = require('../src/config');
const { createEvents } = require('../src/events');
const { createHistory } = require('../src/history');

function jsonResponse(body) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body };
}

// Answers Traefik's HTTP routers endpoint with `routers` and its TCP routers endpoint with `tcp`.
function routersResponse(url, routers, tcp = []) {
  return jsonResponse(url.pathname === '/api/tcp/routers' ? tcp : routers);
}

describe('server', () => {
  let server;
  let store;
  let base;
  let traefikRouters;
  let failWith;
  let configDir;

  before(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homepage-server-'));
    const config = createConfigStore({ file: path.join(configDir, 'homepage.json') });
    const fetchImpl = async url => {
      if (failWith) throw failWith;
      return routersResponse(url, traefikRouters);
    };
    const checkRoutes = async routes => new Map(routes.map(route => [route.id, { reachable: true, statusCode: 200 }]));
    store = createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl, checkRoutes });
    traefikRouters = [{ name: 'app@docker', rule: 'Host(`app.test`)', status: 'enabled' }];
    await store.refresh();
    const icons = { get: id => (id === 'app@docker' ? { type: 'image/svg+xml', body: Buffer.from('<svg></svg>'), hash: 'abc123' } : null) };
    server = createServer({ store, config, title: 'My lab', version: '1.2.3', icons, check: store.checkRoute });
    await new Promise(resolve => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.close();
    await fs.rm(configDir, { recursive: true, force: true });
  });

  function putGroups(body, contentType = 'application/json', headers = {}) {
    return fetch(`${base}/api/groups`, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': contentType },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('serves normalized routes as JSON', async () => {
    const res = await fetch(`${base}/api/routes`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.title, 'My lab');
    assert.equal(body.version, '1.2.3');
    assert.equal(body.error, null);
    assert.equal(body.routes[0].url, 'http://app.test');
  });

  it('includes route health once it has been checked', async () => {
    const before = await (await fetch(`${base}/api/routes`)).json();
    assert.equal(before.routes[0].health, null);
    await store.refreshHealth();
    const after = await (await fetch(`${base}/api/routes`)).json();
    assert.equal(after.routes[0].health.reachable, true);
    assert.equal(after.routes[0].health.statusCode, 200);
  });

  it('keeps the last good routes and reports the error when Traefik is unreachable', async () => {
    failWith = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    await store.refresh();
    failWith = null;
    const body = await (await fetch(`${base}/api/routes`)).json();
    assert.equal(body.routes.length, 1);
    assert.match(body.error, /Can't reach the Traefik API at http:\/\/traefik:8080 \(ECONNREFUSED\)/);
  });

  it('reports a timeout distinctly', async () => {
    failWith = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    await store.refresh();
    failWith = null;
    const body = await (await fetch(`${base}/api/routes`)).json();
    assert.match(body.error, /didn't respond in time/);
  });

  it('saves groups and returns them with the routes', async () => {
    const saved = await putGroups({ groups: [{ name: 'Apps', routes: ['app@docker'] }] });
    assert.equal(saved.status, 200);
    const body = await (await fetch(`${base}/api/routes`)).json();
    assert.deepEqual(body.groups, [{ name: 'Apps', routes: ['app@docker'] }]);
  });

  it('gives the version of the groups with the routes, and with each save of them', async () => {
    const saved = await (await putGroups({ groups: [{ name: 'Apps', routes: ['app@docker'] }] })).json();
    const body = await (await fetch(`${base}/api/routes`)).json();
    assert.equal(typeof saved.groupsVersion, 'string');
    assert.equal(body.groupsVersion, saved.groupsVersion);
  });

  it('saves groups when If-Match names their current version', async () => {
    const { groupsVersion } = await (await putGroups({ groups: [{ name: 'Apps' }] })).json();
    const res = await putGroups({ groups: [{ name: 'Tools' }] }, 'application/json', { 'If-Match': `"stale", "${groupsVersion}"` });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).groups, [{ name: 'Tools', routes: [] }]);
  });

  it('refuses groups changed elsewhere since the version in If-Match, replying with them as they are now', async () => {
    const { groupsVersion: before } = await (await putGroups({ groups: [{ name: 'Media' }] })).json();
    const now = await (await putGroups({ groups: [{ name: 'Media', routes: ['app@docker'] }] })).json();
    const res = await putGroups({ groups: [{ name: 'Media' }, { name: 'Tools' }] }, 'application/json', { 'If-Match': `"${before}"` });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /changed somewhere else/);
    assert.deepEqual([body.groups, body.groupsVersion], [now.groups, now.groupsVersion]);
    assert.deepEqual((await (await fetch(`${base}/api/routes`)).json()).groups, now.groups);
  });

  it('never matches a weak tag in If-Match, and always matches *', async () => {
    const { groupsVersion } = await (await putGroups({ groups: [{ name: 'Media' }] })).json();
    const weak = await putGroups({ groups: [] }, 'application/json', { 'If-Match': `W/"${groupsVersion}"` });
    assert.equal(weak.status, 409);
    const any = await putGroups({ groups: [] }, 'application/json', { 'If-Match': '*' });
    assert.equal(any.status, 200);
  });

  it('keeps the version of the groups when a route is renamed', async () => {
    const { groupsVersion } = await (await putGroups({ groups: [{ name: 'Apps', routes: ['app@docker'] }] })).json();
    await putRoute('app@docker', { name: 'My app' });
    assert.equal((await (await fetch(`${base}/api/routes`)).json()).groupsVersion, groupsVersion);
    await putRoute('app@docker', { name: '' });
  });

  it('rejects invalid groups with a reason', async () => {
    const res = await putGroups({ groups: [{ name: 'Apps' }, { name: 'apps' }] });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /already a group called "apps"/);
  });

  it('rejects a body that is not JSON', async () => {
    const res = await putGroups('{ nope');
    assert.equal(res.status, 400);
  });

  it('only accepts JSON request bodies', async () => {
    const res = await putGroups('groups=1', 'application/x-www-form-urlencoded');
    assert.equal(res.status, 415);
    assert.equal((await res.json()).error, 'Send the request body as application/json');
  });

  it('rejects request bodies over 64 KB', async () => {
    const res = await putGroups({ groups: [{ name: 'Big', routes: ['x'.repeat(70 * 1024)] }] });
    assert.equal(res.status, 413);
  });

  it('only allows PUT on the groups endpoint', async () => {
    const res = await fetch(`${base}/api/groups`, { method: 'POST' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'PUT');
  });

  function putRoute(id, body) {
    return fetch(`${base}/api/routes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('saves the name and icon of a route and returns them with the route', async () => {
    const saved = await putRoute('app@docker', { name: 'My app', icon: 'https://cdn.test/app.png' });
    assert.deepEqual(await saved.json(), { custom: { name: 'My app', icon: 'https://cdn.test/app.png' } });
    const body = await (await fetch(`${base}/api/routes`)).json();
    assert.deepEqual(body.routes[0].custom, { name: 'My app', icon: 'https://cdn.test/app.png' });
  });

  it('rejects an invalid route icon with a reason', async () => {
    const res = await putRoute('app@docker', { icon: 'not a url' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /must be the http:\/\/ or https:\/\/ address/);
  });

  it('links each route to the icon found for it, versioned by its hash', async () => {
    const body = await (await fetch(`${base}/api/routes`)).json();
    assert.equal(body.routes[0].icon, 'api/icons/app%40docker?v=abc123');
  });

  it('serves a found icon with headers that keep it from running script', async () => {
    const res = await fetch(`${base}/api/icons/app%40docker?v=abc123`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/svg+xml');
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await res.text(), '<svg></svg>');
  });

  it('returns 404 for a route with no icon', async () => {
    const res = await fetch(`${base}/api/icons/other%40docker`);
    assert.equal(res.status, 404);
  });

  function postCheck(id, contentType = 'application/json') {
    return fetch(`${base}/api/check/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': contentType }, body: '{}' });
  }

  it('checks a route when asked and replies with its health', async () => {
    const res = await postCheck('app@docker');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).health.statusCode, 200);
  });

  it('returns 404 when asked to check a route it does not know', async () => {
    const res = await postCheck('other@docker');
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /no route by that name/);
  });

  it('only checks a route when asked with application/json, which other sites cannot send', async () => {
    const res = await postCheck('app@docker', 'text/plain');
    assert.equal(res.status, 415);
    assert.equal((await res.json()).error, 'Send the request body as application/json');
  });

  it('only allows POST on the check endpoint', async () => {
    const res = await fetch(`${base}/api/check/app%40docker`);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  });

  it('serves the dashboard page', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });

  it('serves the bundled font with a font type', async () => {
    const res = await fetch(`${base}/fonts/atkinson-hyperlegible-latin-400-normal.woff2`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'font/woff2');
  });

  it('stops other sites framing the page and browsers guessing types', async () => {
    for (const url of ['/', '/api/routes', '/missing']) {
      const res = await fetch(`${base}${url}`);
      assert.match(res.headers.get('content-security-policy'), /; frame-ancestors 'self'$/, url);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', url);
    }
  });

  it('lets the page load only its own files and http or https images', async () => {
    const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
    assert.match(csp, /^default-src 'self'; img-src 'self' http: https:; object-src 'none'; base-uri 'none'; /);
  });

  it('has no inline script, which the page CSP would block', async () => {
    const html = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  });

  it('answers an unchanged page file with 304 so the browser uses its copy', async () => {
    const first = await fetch(`${base}/app.js`);
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    const etag = first.headers.get('etag');
    assert.ok(etag);
    const again = await fetch(`${base}/app.js`, { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), '');
    const stale = await fetch(`${base}/app.js`, { headers: { 'If-None-Match': 'W/"other"' } });
    assert.equal(stale.status, 200);
  });

  it('lets browsers keep the fonts without asking', async () => {
    const res = await fetch(`${base}/fonts/atkinson-hyperlegible-latin-400-normal.woff2`);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=604800');
  });

  it('does not serve files outside the public directory', async () => {
    const res = await fetch(`${base}/%2e%2e/package.json`);
    assert.equal(res.status, 404);
  });

  it('returns 404 for malformed URL encoding instead of crashing', async () => {
    const res = await fetch(`${base}/%E0%A4%A`);
    assert.equal(res.status, 404);
  });
});

describe('server events', () => {
  let server;
  let events;
  let base;
  let configDir;

  before(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homepage-events-'));
    const config = createConfigStore({ file: path.join(configDir, 'homepage.json') });
    const store = createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl: async () => jsonResponse([]) });
    events = createEvents({ delayMs: 10 });
    server = createServer({ store, config, title: 'My lab', events });
    await new Promise(resolve => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    events.close();
    server.close();
    await fs.rm(configDir, { recursive: true, force: true });
  });

  async function nextMessage(reader) {
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('data:')) text += decoder.decode((await reader.read()).value);
    return text;
  }

  it('tells open pages when groups are saved', async () => {
    const res = await fetch(`${base}/api/events`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body.getReader();
    const saved = await fetch(`${base}/api/groups`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groups: [{ name: 'Apps' }] }),
    });
    assert.equal(saved.status, 200);
    assert.match(await nextMessage(reader), /data: change/);
    await reader.cancel();
  });
});

describe('server health settings', () => {
  let dir;
  let server;
  let store;
  let checked;
  let base;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'homepage-health-'));
    const config = createConfigStore({ file: path.join(dir, 'homepage.json') });
    checked = [];
    const checkRoutes = async targets => {
      checked.push(...targets.map(target => target.url));
      return new Map(targets.map(target => [target.id, { reachable: true, statusCode: 200, checkedAt: new Date().toISOString() }]));
    };
    const fetchImpl = async url => routersResponse(url, [{ name: 'app@docker', rule: 'Host(`app.test`)', status: 'enabled' }]);
    store = createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl, checkRoutes, routeSettings: async () => (await config.read()).routes });
    server = createServer({ store, config, title: 'Lab', check: store.checkRoute });
    await new Promise(resolve => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    await store.refresh();
    await store.refreshHealth();
  });

  after(async () => {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const putRoute = body => fetch(`${base}/api/routes/app%40docker`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const routes = async () => (await (await fetch(`${base}/api/routes`)).json()).routes;

  async function until(condition) {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(condition());
  }

  it('checks the new health path straight away, without showing the old result meanwhile', async () => {
    const res = await putRoute({ health: { path: '/api/health', expect: [200] } });
    assert.deepEqual(await res.json(), { custom: { health: { path: '/api/health', expect: [200] } } });
    await until(() => checked.includes('http://app.test/api/health'));
    const [route] = await routes();
    assert.deepEqual([route.health.url, route.health.expect], ['http://app.test/api/health', [200]]);
    assert.deepEqual(route.custom.health, { path: '/api/health', expect: [200] });
  });

  it('shows no health for a route whose check is turned off, and refuses to check it', async () => {
    const before = checked.length;
    await putRoute({ health: { check: false } });
    const [route] = await routes();
    assert.equal(route.health, null);
    const res = await fetch(`${base}/api/check/app%40docker`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 404);
    assert.equal(checked.length, before);
  });

  it('does not check again when a save leaves the health settings as they were', async () => {
    await putRoute({ health: null });
    await until(() => checked.at(-1) === 'http://app.test');
    const before = checked.length;
    await putRoute({ name: 'App' });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(checked.length, before);
  });
});

describe('server checks', () => {
  it('runs one check of a route at a time, answering every request with it', async () => {
    let calls = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const check = async id => {
      calls++;
      await gate;
      return { id, health: { reachable: true, statusCode: 200, checkedAt: `check ${calls}` } };
    };
    const config = { read: async () => ({ groups: [], routes: {}, error: null }) };
    const store = createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl: async () => jsonResponse([]) });
    const server = createServer({ store, config, title: 'Lab', check });
    await new Promise(resolve => server.listen(0, resolve));
    // The server's own listener runs first and reaches the check without waiting on anything, so once this one has
    // seen a request, that request has asked for its check.
    let received = 0;
    server.on('request', () => received++);
    const post = () => fetch(`http://127.0.0.1:${server.address().port}/api/check/app%40docker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then(res => res.json());
    try {
      const both = Promise.all([post(), post()]);
      while (received < 2) await new Promise(resolve => setTimeout(resolve, 5));
      release();
      const [first, second] = await both;
      assert.equal(calls, 1);
      assert.deepEqual(first, second);
      await post();
      assert.equal(calls, 2);
    } finally {
      server.close();
    }
  });
});

describe('version', () => {
  it('is null when the server is not running from the image', async () => {
    const config = { read: async () => ({ groups: [], routes: {}, error: null }) };
    const store = createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl: async () => jsonResponse([]) });
    const server = createServer({ store, config, title: 'Lab' });
    await new Promise(resolve => server.listen(0, resolve));
    try {
      const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/routes`)).json();
      assert.equal(body.version, null);
    } finally {
      server.close();
    }
  });
});

describe('server errors', () => {
  it('answers an unexpected error with a 500 instead of leaving the request hanging', async t => {
    t.mock.method(console, 'error', () => {});
    const config = { read: async () => { throw new Error('disk on fire'); } };
    const store = createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl: async () => jsonResponse([]) });
    const server = createServer({ store, config, title: 'Lab' });
    await new Promise(resolve => server.listen(0, resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/routes`);
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: 'The homepage server hit an error' });
      assert.match(console.error.mock.calls[0].arguments[0], /GET \/api\/routes failed: disk on fire/);
    } finally {
      server.close();
    }
  });
});

describe('shutDown', () => {
  async function listening() {
    const store = createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl: async () => jsonResponse([]) });
    const config = { read: async () => ({ groups: [], routes: {}, error: null }) };
    const events = createEvents();
    const server = createServer({ store, config, title: 'Lab', events });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, events, port: server.address().port };
  }

  // Node 24's close() on its own waits for such a connection until the request times out, a minute later.
  it('closes a connection that never sent a request instead of waiting for it', { timeout: 5000 }, async () => {
    const { server, events, port } = await listening();
    const socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    const start = Date.now();
    await shutDown({ server, events, graceMs: 100 });
    assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
    socket.destroy();
  });

  it('ends open event streams', { timeout: 5000 }, async () => {
    const { server, events, port } = await listening();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`);
    const ended = res.text();
    await shutDown({ server, events, graceMs: 100 });
    assert.match(await ended, /retry: 5000/);
  });
});

describe('read-only', () => {
  let server;
  let base;
  let configDir;
  let file;
  const saved = { groups: [{ name: 'Apps', routes: ['app@docker'] }], routes: { 'app@docker': { name: 'App' } } };

  before(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'homepage-read-only-'));
    file = path.join(configDir, 'homepage.json');
    await fs.writeFile(file, JSON.stringify(saved));
    const fetchImpl = async url => routersResponse(url, [{ name: 'app@docker', rule: 'Host(`app.test`)', status: 'enabled' }]);
    const checkRoutes = async routes => new Map(routes.map(route => [route.id, { reachable: true, statusCode: 200 }]));
    const store = createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl, checkRoutes });
    await store.refresh();
    const config = createConfigStore({ file });
    server = createServer({ store, config, title: 'Lab', check: store.checkRoute, readOnly: true });
    await new Promise(resolve => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.close();
    await fs.rm(configDir, { recursive: true, force: true });
  });

  function put(pathname, body) {
    return fetch(`${base}${pathname}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  it('tells the page it is read-only, with the saved groups and routes', async () => {
    const body = await (await fetch(`${base}/api/routes`)).json();
    assert.equal(body.readOnly, true);
    assert.deepEqual(body.groups, saved.groups);
    assert.deepEqual(body.routes[0].custom, { name: 'App' });
  });

  it('refuses to change the groups or a route with a 403, and leaves the config file alone', async () => {
    for (const [pathname, body] of [['/api/groups', { groups: [] }], ['/api/routes/app%40docker', { hidden: true }]]) {
      const res = await put(pathname, body);
      assert.equal(res.status, 403, pathname);
      assert.match((await res.json()).error, /read-only/);
    }
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), saved);
  });

  it('still answers other methods on those endpoints with a 405', async () => {
    const res = await fetch(`${base}/api/groups`, { method: 'POST' });
    assert.equal(res.status, 405);
  });

  it('still checks a route when asked, since that saves nothing', async () => {
    const res = await fetch(`${base}/api/check/app%40docker`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).health.statusCode, 200);
  });

  it('is off unless asked for', async () => {
    const config = { read: async () => ({ groups: [], routes: {}, error: null }) };
    const other = createServer({ store: createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl: async () => jsonResponse([]) }), config, title: 'Lab' });
    await new Promise(resolve => other.listen(0, resolve));
    try {
      const body = await (await fetch(`http://127.0.0.1:${other.address().port}/api/routes`)).json();
      assert.equal(body.readOnly, false);
    } finally {
      other.close();
    }
  });
});

describe('frame ancestors', () => {

  it('go into the page\'s Content-Security-Policy', async () => {
    const server = createServer({ store: createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl: async () => jsonResponse([]) }), config: {}, title: 't', frameAncestors: '*' });
    await new Promise(resolve => server.listen(0, resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
      assert.match(res.headers.get('content-security-policy'), /; frame-ancestors \*$/);
    } finally {
      server.close();
    }
  });
});

describe('starting on a port that is in use', () => {
  it('says so in a sentence and exits with an error', { timeout: 10000 }, async t => {
    // On every address, as the server listens: holding only 127.0.0.1 would leave it free to listen on the rest.
    const taken = net.createServer();
    await new Promise(resolve => taken.listen(0, resolve));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'homepage-port-'));
    t.after(async () => {
      taken.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    const { port } = taken.address();

    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: String(port), TRAEFIK_API_URL: 'http://127.0.0.1:1', CONFIG_FILE: path.join(dir, 'homepage.json') },
    });
    t.after(() => child.kill());
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'exit');

    assert.equal(code, 1);
    assert.equal(stderr.trim(), `Port ${port} is already in use. Stop whatever is using it, or set PORT to another port.`);
  });
});

describe('a Traefik API behind basic auth', () => {
  const outcomes = [
    ['answers', async url => routersResponse(url, [{ name: 'app@docker', rule: 'Host(`app.test`)' }])],
    ['refuses the credentials', async () => ({ ok: false, status: 401, headers: new Headers() })],
    ['times out', async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }],
  ];
  for (const [outcome, fetchImpl] of outcomes) {
    it(`keeps the password out of GET /api/routes when Traefik ${outcome}`, async t => {
      t.mock.method(console, 'error', () => {});
      const store = createRouteStore({ traefikUrl: 'http://admin:s3cret@traefik:8080', fetchImpl });
      await store.refresh();
      const config = { read: async () => ({ groups: [], routes: {}, error: null }) };
      const server = createServer({ store, config, title: 't' });
      await new Promise(resolve => server.listen(0, resolve));
      t.after(() => server.close());
      const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/routes`)).text();
      assert.doesNotMatch(body, /s3cret/);
    });
  }

  it('reads routes with the credentials from the environment and never logs the password', { timeout: 10000 }, async t => {
    const authorization = `Basic ${Buffer.from('admin:s3cret').toString('base64')}`;
    const requests = [];
    const traefik = http.createServer((req, res) => {
      requests.push(req.headers.authorization);
      res.writeHead(401).end();
    });
    await new Promise(resolve => traefik.listen(0, '127.0.0.1', resolve));
    const free = net.createServer();
    await new Promise(resolve => free.listen(0, resolve));
    const { port } = free.address();
    await new Promise(resolve => free.close(resolve));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'homepage-auth-'));
    t.after(async () => {
      traefik.close();
      await fs.rm(dir, { recursive: true, force: true });
    });

    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: { ...process.env, PORT: String(port), TRAEFIK_API_URL: `http://admin:s3cret@127.0.0.1:${traefik.address().port}`, CONFIG_FILE: path.join(dir, 'homepage.json') },
    });
    t.after(() => child.kill());
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    while (!output.includes('Route refresh failed')) await once(child.stderr, 'data');

    assert.match(output, new RegExp(`reading routes from http://127\\.0\\.0\\.1:${traefik.address().port} as admin`));
    assert.match(output, /refused the username and password \(HTTP 401\)/);
    assert.doesNotMatch(output, /s3cret/);
    assert.equal(requests[0], authorization);
  });
});

describe('server history', () => {
  async function serve(t, history) {
    const store = createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl: async url => routersResponse(url, [{ name: 'app@docker', rule: 'Host(`app.test`)' }]) });
    await store.refresh();
    const config = { read: async () => ({ groups: [], routes: {}, error: null }) };
    const server = createServer({ store, config, title: 'Lab', history });
    await new Promise(resolve => server.listen(0, resolve));
    t.after(() => server.close());
    return `http://127.0.0.1:${server.address().port}`;
  }

  it('serves how a route has done over the last day', async t => {
    const history = createHistory();
    history.record('app@docker', 'http://app.test', { reachable: true, statusCode: 200, latencyMs: 12, checkedAt: new Date().toISOString() });
    const base = await serve(t, history);
    const res = await fetch(`${base}/api/history/app%40docker`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).checks, 1);
  });

  it('answers with a 404 for a route Traefik isn\'t serving', async t => {
    const base = await serve(t, createHistory());
    const res = await fetch(`${base}/api/history/gone%40docker`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'There’s no route by that name');
  });
});

describe('saving route history', () => {
  // A homepage reading one route, app@docker, from a fake Traefik, with its config folder in `dir`. Its checks are
  // pinned to this machine and given a second at most; whether they pass doesn't matter, only that they're kept.
  async function startHomepage(t, dir) {
    const traefik = http.createServer((req, res) => {
      const routers = req.url.startsWith('/api/http/routers') ? [{ name: 'app@docker', rule: 'Host(`app.test`)', status: 'enabled' }] : [];
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(routers));
    });
    await new Promise(resolve => traefik.listen(0, '127.0.0.1', resolve));
    const free = net.createServer();
    await new Promise(resolve => free.listen(0, '127.0.0.1', resolve));
    const { port } = free.address();
    await new Promise(resolve => free.close(resolve));
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        TRAEFIK_API_URL: `http://127.0.0.1:${traefik.address().port}`,
        CONFIG_FILE: path.join(dir, 'homepage.json'),
        HEALTHCHECK_ADDRESS: '127.0.0.1',
        HEALTHCHECK_TIMEOUT_SECONDS: '1',
      },
      stdio: 'ignore',
    });
    t.after(() => {
      child.kill();
      traefik.close();
    });
    // The checks a route has in its history, once the homepage knows the route.
    const checks = async () => {
      for (;;) {
        const res = await fetch(`http://127.0.0.1:${port}/api/history/app%40docker`).catch(() => null);
        if (res?.ok) {
          const { checks: count } = await res.json();
          if (count) return count;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    return { child, checks };
  }

  async function tempDir(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'homepage-history-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return dir;
  }

  it('saves each route\'s history as the server stops', { timeout: 10000 }, async t => {
    const dir = await tempDir(t);
    const { child, checks } = await startHomepage(t, dir);
    await checks();
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    const saved = JSON.parse(await fs.readFile(path.join(dir, 'history.json'), 'utf8'));
    assert.deepEqual(Object.keys(saved.routes), ['app@docker']);
  });

  it('starts with the history an earlier run saved', { timeout: 10000 }, async t => {
    const dir = await tempDir(t);
    const earlier = createHistory();
    for (let i = 3; i > 0; i--) earlier.record('app@docker', 'http://app.test', { reachable: true, statusCode: 200, latencyMs: 5, checkedAt: new Date(Date.now() - i * 60000).toISOString() });
    await fs.writeFile(path.join(dir, 'history.json'), earlier.serialize());
    const { checks } = await startHomepage(t, dir);
    assert.ok(await checks() >= 3);
  });
});
