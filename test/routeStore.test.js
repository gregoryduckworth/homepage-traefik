const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createRouteStore } = require('../src/routeStore');

function jsonResponse(body) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body };
}

// Answers Traefik's HTTP routers endpoint with `routers` and its TCP routers endpoint with `tcp`.
function routersResponse(url, routers, tcp = []) {
  return jsonResponse(url.pathname === '/api/tcp/routers' ? tcp : routers);
}

describe('createRouteStore entry point ports', () => {
  it('puts the configured port in route URLs', async () => {
    const fetchImpl = async url => routersResponse(url, [{ name: 'app@docker', rule: 'Host(`app.test`)', entryPoints: ['websecure'], tls: {} }]);
    const store = createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl, entryPointPorts: new Map([['websecure', 8443]]) });
    await store.refresh();
    assert.equal(store.state.routes[0].url, 'https://app.test:8443');
  });
});

describe('createRouteStore TCP routers', () => {
  it('lists TCP routers beside HTTP ones and never checks them', async () => {
    const fetchImpl = async url => routersResponse(url, [{ name: 'app@docker', rule: 'Host(`app.test`)' }], [{ name: 'db@docker', rule: 'HostSNI(`db.test`)' }]);
    const checked = [];
    const checkRoutes = async routes => {
      checked.push(...routes.map(route => route.id));
      return new Map();
    };
    const store = createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl, checkRoutes });
    await store.refresh();
    await store.refreshHealth();
    assert.deepEqual(store.state.routes.map(route => route.id), ['app@docker', 'tcp:db@docker']);
    assert.deepEqual(checked, ['app@docker']);
  });
});

describe('createRouteStore health checks', () => {
  const HOUR = 60 * 60 * 1000;
  let clock;
  let checked;
  let routers;

  function makeStore(options = {}) {
    const fetchImpl = async url => routersResponse(url, routers);
    const checkRoutes = async routes => {
      checked.push(routes.map(route => route.id));
      return new Map(routes.map(route => [route.id, { reachable: true, statusCode: 200, checkedAt: new Date(clock).toISOString() }]));
    };
    return createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl, checkRoutes, healthIntervalMs: HOUR, now: () => clock, ...options });
  }

  beforeEach(() => {
    clock = Date.parse('2026-01-01T00:00:00Z');
    checked = [];
    routers = [
      { name: 'a@docker', rule: 'Host(`a.test`)', status: 'enabled' },
      { name: 'b@docker', rule: 'Host(`b.test`)', status: 'enabled' },
    ];
  });

  it('checks each route at most once per interval however often Traefik is polled', async () => {
    const store = makeStore();
    for (const minutes of [0, 1, 30, 59]) {
      clock = Date.parse('2026-01-01T00:00:00Z') + minutes * 60 * 1000;
      await store.refresh();
      await store.refreshHealth();
    }
    assert.deepEqual(checked, [['a@docker', 'b@docker']]);
  });

  it('checks routes again once the interval has passed', async () => {
    const store = makeStore();
    await store.refresh();
    await store.refreshHealth();
    clock += HOUR;
    assert.equal(await store.refreshHealth(), true);
    assert.deepEqual(checked, [['a@docker', 'b@docker'], ['a@docker', 'b@docker']]);
  });

  it('checks a new route straight away without checking the others again', async () => {
    const store = makeStore();
    await store.refresh();
    await store.refreshHealth();
    routers.push({ name: 'c@docker', rule: 'Host(`c.test`)', status: 'enabled' });
    await store.refresh();
    await store.refreshHealth();
    assert.deepEqual(checked, [['a@docker', 'b@docker'], ['c@docker']]);
  });

  it('checks a route again when its URL changes', async () => {
    const store = makeStore();
    await store.refresh();
    await store.refreshHealth();
    routers[0].rule = 'Host(`a.test`) && PathPrefix(`/app`)';
    await store.refresh();
    await store.refreshHealth();
    assert.deepEqual(checked, [['a@docker', 'b@docker'], ['a@docker']]);
  });

  it('has no results until the first check', async () => {
    const store = makeStore();
    await store.refresh();
    assert.equal(store.getRoutesWithHealth()[0].health, null);
    await store.refreshHealth();
    assert.equal(store.getRoutesWithHealth()[0].health.statusCode, 200);
  });

  it('forgets routes Traefik no longer serves, so one that comes back is checked afresh', async () => {
    const store = makeStore();
    await store.refresh();
    await store.refreshHealth();
    const b = routers.pop();
    await store.refresh();
    assert.equal(await store.refreshHealth(), true);
    routers.push(b);
    await store.refresh();
    await store.refreshHealth();
    assert.deepEqual(checked, [['a@docker', 'b@docker'], ['b@docker']]);
  });

  it('checks nothing while Traefik has not answered yet', async () => {
    const store = makeStore({ fetchImpl: async () => { throw new Error('down'); } });
    await store.refresh();
    assert.equal(await store.refreshHealth(), false);
    assert.deepEqual(checked, []);
  });

  it('reports whether the routes or the error changed', async () => {
    const store = makeStore();
    assert.equal(await store.refresh(), true);
    assert.equal(await store.refresh(), false);
    routers = routers.slice(1);
    assert.equal(await store.refresh(), true);
    const failing = makeStore({ fetchImpl: async () => { throw new Error('down'); } });
    assert.equal(await failing.refresh(), true);
    assert.equal(await failing.refresh(), false);
  });

  it('checks a route when asked, even though it is not due', async () => {
    const store = makeStore();
    await store.refresh();
    await store.refreshHealth();
    clock += 60 * 1000;
    const route = await store.checkRoute('a@docker');
    assert.deepEqual(checked, [['a@docker', 'b@docker'], ['a@docker']]);
    assert.equal(route.health.checkedAt, new Date(clock).toISOString());
    assert.equal(store.getRoutesWithHealth()[0].health.checkedAt, new Date(clock).toISOString());
  });

  it('has nothing to check when asked for a route it does not know or one that is disabled', async () => {
    routers.push({ name: 'off@docker', rule: 'Host(`off.test`)', status: 'disabled' });
    const store = makeStore();
    await store.refresh();
    assert.equal(await store.checkRoute('missing@docker'), null);
    assert.equal(await store.checkRoute('off@docker'), null);
    assert.deepEqual(checked, []);
  });

  it('keeps the newer result when an older check finishes after it', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const checkRoutes = async routes => {
      const checkedAt = new Date(clock).toISOString();
      if (!checked.length) {
        checked.push('slow');
        await gate;
      }
      return new Map(routes.map(route => [route.id, { reachable: true, statusCode: 200, checkedAt }]));
    };
    const store = makeStore({ checkRoutes });
    await store.refresh();
    const slow = store.refreshHealth();
    clock += 60 * 1000;
    await store.checkRoute('a@docker');
    release();
    await slow;
    const [a, b] = store.getRoutesWithHealth();
    assert.equal(a.health.checkedAt, new Date(clock).toISOString());
    assert.equal(b.health.checkedAt, '2026-01-01T00:00:00.000Z');
  });

  it('reports no change when no route was due', async () => {
    const store = makeStore();
    await store.refresh();
    await store.refreshHealth();
    assert.equal(await store.refreshHealth(), false);
  });
});
