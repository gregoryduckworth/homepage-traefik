const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer, createRouteStore } = require('../src/server');

function jsonResponse(body) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body };
}

describe('server', () => {
  let server;
  let store;
  let base;
  let traefikRouters;
  let failWith;

  before(async () => {
    const fetchImpl = async () => {
      if (failWith) throw failWith;
      return jsonResponse(traefikRouters);
    };
    const checkRoutes = async routes => new Map(routes.map(route => [route.id, { reachable: true, statusCode: 200 }]));
    store = createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl, checkRoutes });
    traefikRouters = [{ name: 'app@docker', rule: 'Host(`app.test`)', status: 'enabled' }];
    await store.refresh();
    server = createServer({ store, title: 'My lab' });
    await new Promise(resolve => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

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
