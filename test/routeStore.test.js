const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createRouteStore } = require('../src/routeStore');
const { createHistory } = require('../src/history');

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

  describe('with health settings', () => {
    let settings;
    let targets;
    const settingsStore = (options = {}) => makeStore({
      routeSettings: async () => settings,
      checkRoutes: async due => {
        targets.push(...due);
        return new Map(due.map(target => [target.id, { reachable: true, statusCode: 200, checkedAt: new Date(clock).toISOString() }]));
      },
      ...options,
    });

    beforeEach(() => {
      settings = {};
      targets = [];
    });

    it('checks the health path and expected codes the route\'s settings give', async () => {
      settings = { 'a@docker': { name: 'A', health: { path: '/api/health', expect: [200] } } };
      const store = settingsStore();
      await store.refresh();
      await store.refreshHealth();
      assert.deepEqual(targets, [
        { id: 'a@docker', url: 'http://a.test/api/health', expect: [200] },
        { id: 'b@docker', url: 'http://b.test', expect: null },
      ]);
      assert.deepEqual(store.getRoutesWithHealth().map(route => [route.health.url, route.health.expect]), [['http://a.test/api/health', [200]], ['http://b.test', null]]);
    });

    it('never checks a route whose check is turned off, and forgets its last result', async () => {
      const store = settingsStore();
      await store.refresh();
      await store.refreshHealth();
      settings = { 'b@docker': { health: { check: false } } };
      clock += HOUR;
      assert.equal(await store.refreshHealth(), true);
      assert.deepEqual(targets.map(target => target.id), ['a@docker', 'b@docker', 'a@docker']);
      assert.equal(store.getRoutesWithHealth()[1].health, null);
      assert.equal(await store.checkRoute('b@docker'), null);
    });

    it('checks a route again straight away when its health path or expected codes change', async () => {
      const store = settingsStore();
      await store.refresh();
      await store.refreshHealth();
      settings = { 'a@docker': { health: { path: '/health' } } };
      await store.refreshHealth();
      settings = { 'a@docker': { health: { path: '/health', expect: [204] } } };
      await store.refreshHealth();
      await store.refreshHealth();
      assert.deepEqual(targets.map(target => target.id), ['a@docker', 'b@docker', 'a@docker', 'a@docker']);
    });

    it('checks the health path when asked for one route', async () => {
      settings = { 'a@docker': { health: { path: '/health' } } };
      const store = settingsStore();
      await store.refresh();
      const route = await store.checkRoute('a@docker');
      assert.equal(route.health.url, 'http://a.test/health');
    });

    it('ignores settings inherited from Object, for a router named after one of its properties', async () => {
      routers = [{ name: 'constructor', rule: 'Host(`c.test`)' }];
      const store = settingsStore();
      await store.refresh();
      await store.refreshHealth();
      assert.deepEqual(targets, [{ id: 'constructor', url: 'http://c.test', expect: null }]);
    });
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

  it('adds each check to the history', async () => {
    const history = createHistory({ intervalMs: HOUR, now: () => clock });
    const store = makeStore({ history });
    await store.refresh();
    await store.refreshHealth();
    clock += HOUR;
    await store.checkRoute('a@docker');
    assert.equal(history.summary('a@docker').checks, 2);
  });

  it('keeps the history of a route Traefik stops serving for a moment', async () => {
    const history = createHistory({ intervalMs: HOUR, now: () => clock });
    const store = makeStore({ history });
    await store.refresh();
    await store.refreshHealth();
    routers.pop();
    await store.refresh();
    await store.refreshHealth();
    assert.equal(history.summary('b@docker').checks, 1);
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
    let started;
    const gate = new Promise(resolve => { release = resolve; });
    const slowStarted = new Promise(resolve => { started = resolve; });
    const checkRoutes = async routes => {
      const checkedAt = new Date(clock).toISOString();
      if (!checked.length) {
        checked.push('slow');
        started();
        await gate;
      }
      return new Map(routes.map(route => [route.id, { reachable: true, statusCode: 200, checkedAt }]));
    };
    const store = makeStore({ checkRoutes });
    await store.refresh();
    const slow = store.refreshHealth();
    await slowStarted;
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

describe('createRouteStore credentials', () => {
  const BASIC = `Basic ${Buffer.from('admin:s3cret').toString('base64')}`;
  const sources = [
    ['in the URL', { traefikUrl: 'http://admin:s3cret@traefik:8080' }],
    ['as auth', { traefikUrl: 'http://traefik:8080', auth: { username: 'admin', password: 's3cret' } }],
  ];
  // What Traefik does with the request: each either answers or throws as fetch would.
  const outcomes = [
    ['answers', async url => routersResponse(url, [{ name: 'app@docker', rule: 'Host(`app.test`)' }])],
    ['cannot be reached', async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }],
    ['times out', async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); }],
    ['refuses the credentials', async () => ({ ok: false, status: 401, headers: new Headers() })],
    ['answers with something unexpected', async () => jsonResponse({ message: 'nope' })],
  ];

  for (const [source, options] of sources) {
    it(`sends credentials given ${source} as basic auth to a URL without them`, async () => {
      const requests = [];
      const fetchImpl = async (url, init) => {
        requests.push({ url: url.href, authorization: init.headers.Authorization });
        return routersResponse(url, []);
      };
      await createRouteStore({ ...options, fetchImpl }).refresh();
      assert.deepEqual(requests, [
        { url: 'http://traefik:8080/api/http/routers?page=1&per_page=100', authorization: BASIC },
        { url: 'http://traefik:8080/api/tcp/routers?page=1&per_page=100', authorization: BASIC },
      ]);
    });

    for (const [outcome, fetchImpl] of outcomes) {
      it(`keeps a password given ${source} out of the error and logs when Traefik ${outcome}`, async t => {
        t.mock.method(console, 'error', () => {});
        const store = createRouteStore({ ...options, fetchImpl });
        await store.refresh();
        const logged = console.error.mock.calls.map(call => call.arguments.join(' ')).join('\n');
        assert.doesNotMatch(`${store.state.error}\n${logged}`, /s3cret/);
      });
    }
  }

  it('names the Traefik API without the credentials when they are refused', async t => {
    t.mock.method(console, 'error', () => {});
    const fetchImpl = async () => ({ ok: false, status: 401, headers: new Headers() });
    const store = createRouteStore({ traefikUrl: 'http://admin:s3cret@traefik:8080', fetchImpl });
    await store.refresh();
    assert.equal(store.state.error, 'The Traefik API at http://traefik:8080 refused the username and password (HTTP 401)');
  });
});

describe('createRouteStore refresh logging', () => {
  it('logs a failure once while it repeats, again when it changes, and once when Traefik answers', async t => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', () => {});
    let code = 'ECONNREFUSED';
    let down = true;
    const fetchImpl = async url => {
      if (down) throw Object.assign(new Error('fetch failed'), { cause: { code } });
      return routersResponse(url, [{ name: 'app@docker', rule: 'Host(`app.test`)' }]);
    };
    const store = createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl });
    const errors = () => console.error.mock.calls.map(call => call.arguments[0]);
    const logs = () => console.log.mock.calls.map(call => call.arguments[0]);

    for (let i = 0; i < 3; i++) await store.refresh();
    assert.deepEqual(errors(), [
      "Route refresh failed: Can't reach the Traefik API at http://traefik:8080 (ECONNREFUSED). Check TRAEFIK_API_URL and that the API is enabled.",
    ]);
    assert.match(store.state.error, /ECONNREFUSED/);

    code = 'ENOTFOUND';
    for (let i = 0; i < 3; i++) await store.refresh();
    assert.equal(errors().length, 2);
    assert.match(errors()[1], /ENOTFOUND/);

    down = false;
    for (let i = 0; i < 3; i++) await store.refresh();
    assert.equal(errors().length, 2);
    assert.deepEqual(logs(), ['Reading routes from http://traefik:8080 again']);
    assert.equal(store.state.error, null);
  });

  it('says nothing when Traefik answers from the start', async t => {
    t.mock.method(console, 'error', () => {});
    t.mock.method(console, 'log', () => {});
    const store = createRouteStore({ traefikUrl: 'http://traefik:8080', fetchImpl: async url => routersResponse(url, []) });
    await store.refresh();
    await store.refresh();
    assert.equal(console.error.mock.callCount(), 0);
    assert.equal(console.log.mock.callCount(), 0);
  });
});
