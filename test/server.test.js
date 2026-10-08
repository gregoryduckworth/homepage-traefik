const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer, createRouteStore } = require('../src/server');
const { createConfigStore } = require('../src/config');

function jsonResponse(body) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body };
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
    const fetchImpl = async () => {
      if (failWith) throw failWith;
      return jsonResponse(traefikRouters);
    };
    const checkRoutes = async routes => new Map(routes.map(route => [route.id, { reachable: true, statusCode: 200 }]));
    store = createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl, checkRoutes });
    traefikRouters = [{ name: 'app@docker', rule: 'Host(`app.test`)', status: 'enabled' }];
    await store.refresh();
    server = createServer({ store, config, title: 'My lab' });
    await new Promise(resolve => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.close();
    await fs.rm(configDir, { recursive: true, force: true });
  });

  function putGroups(body, contentType = 'application/json') {
    return fetch(`${base}/api/groups`, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('serves normalized routes as JSON', async () => {
    const res = await fetch(`${base}/api/routes`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.title, 'My lab');
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

  it('serves the dashboard page', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
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
