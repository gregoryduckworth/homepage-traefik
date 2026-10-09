const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer, createRouteStore, atMostEvery, readSeconds, readPort, readFrameAncestors } = require('../src/server');
const { createConfigStore } = require('../src/config');
const { createEvents } = require('../src/events');

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
    server = createServer({ store, config, title: 'My lab', icons });
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

  it('starts from saved results and waits out their interval', async () => {
    const saved = new Map([
      ['a@docker', { url: 'http://a.test', reachable: true, statusCode: 204, checkedAt: new Date(clock - HOUR / 2).toISOString() }],
      ['b@docker', { url: 'http://b.test', reachable: true, statusCode: 200, checkedAt: new Date(clock - HOUR).toISOString() }],
    ]);
    const store = makeStore({ health: saved });
    await store.refresh();
    await store.refreshHealth();
    assert.deepEqual(checked, [['b@docker']]);
    assert.equal(store.getRoutesWithHealth()[0].health.statusCode, 204);
  });

  it('forgets routes Traefik no longer serves', async () => {
    const store = makeStore();
    await store.refresh();
    await store.refreshHealth();
    routers.pop();
    await store.refresh();
    assert.equal(await store.refreshHealth(), true);
    assert.deepEqual(Object.keys(store.getHealth()), ['a@docker']);
  });

  it('keeps saved results while Traefik has not answered yet', async () => {
    const saved = new Map([['a@docker', { url: 'http://a.test', checkedAt: new Date(clock).toISOString() }]]);
    const store = makeStore({ health: saved, fetchImpl: async () => { throw new Error('down'); } });
    await store.refresh();
    assert.equal(await store.refreshHealth(), false);
    assert.deepEqual(Object.keys(store.getHealth()), ['a@docker']);
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

  it('reports nothing to save when no route was due', async () => {
    const store = makeStore();
    await store.refresh();
    await store.refreshHealth();
    assert.equal(await store.refreshHealth(), false);
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

describe('atMostEvery', () => {
  function setup() {
    let time = 0;
    let runs = 0;
    const saver = atMostEvery(1000, async () => { runs++; }, () => time);
    return { saver, runs: () => runs, advance: ms => { time += ms; } };
  }

  it('runs the first request straight away', async () => {
    const { saver, runs } = setup();
    await saver.request();
    assert.equal(runs(), 1);
  });

  it('holds back requests within the interval and runs them with the next one after it', async () => {
    const { saver, runs, advance } = setup();
    await saver.request();
    advance(500);
    await saver.request();
    await saver.request();
    assert.equal(runs(), 1);
    advance(500);
    await saver.request();
    assert.equal(runs(), 2);
  });

  it('runs a held-back request when flushed, and nothing when none is waiting', async () => {
    const { saver, runs, advance } = setup();
    await saver.request();
    await saver.flush();
    assert.equal(runs(), 1);
    advance(10);
    await saver.request();
    await saver.flush();
    assert.equal(runs(), 2);
  });
});

describe('readSeconds', () => {
  const opts = { fallback: 30, min: 5 };
  const cases = [
    ['uses the default when unset', {}, 30],
    ['uses the default when empty', { POLL: ' ' }, 30],
    ['uses the default when not a number', { POLL: 'often' }, 30],
    ['raises zero to the minimum', { POLL: '0' }, 5],
    ['raises a negative value to the minimum', { POLL: '-10' }, 5],
    ['accepts a value at or above the minimum', { POLL: '120' }, 120],
  ];
  for (const [name, env, expected] of cases) {
    it(name, t => {
      t.mock.method(console, 'warn', () => {});
      assert.equal(readSeconds(env, 'POLL', opts), expected);
    });
  }

  describe('with off', () => {
    const offOpts = { fallback: 600, min: 60, off: true };
    const offCases = [
      ['takes 0 to mean off', { SAVE: '0' }, 0],
      ['still raises other values below the minimum', { SAVE: '30' }, 60],
      ['uses the default when unset', {}, 600],
    ];
    for (const [name, env, expected] of offCases) {
      it(name, t => {
        t.mock.method(console, 'warn', () => {});
        assert.equal(readSeconds(env, 'SAVE', offOpts), expected);
      });
    }

    it('says 0 turns it off when a value is too small', t => {
      t.mock.method(console, 'warn', () => {});
      readSeconds({ SAVE: '30' }, 'SAVE', offOpts);
      assert.equal(console.warn.mock.calls[0].arguments[0], 'SAVE=30 is below the minimum, so 60 is used (0 turns it off)');
    });
  });
});

describe('readPort', () => {
  const cases = [
    ['uses the default when unset', {}, 3000],
    ['uses the default when empty', { PORT: ' ' }, 3000],
    ['uses the default when not a number', { PORT: 'http' }, 3000],
    ['uses the default for a fraction', { PORT: '80.5' }, 3000],
    ['uses the default when out of range', { PORT: '70000' }, 3000],
    ['uses the default for zero', { PORT: '0' }, 3000],
    ['accepts a port number', { PORT: '8080' }, 8080],
  ];
  for (const [name, env, expected] of cases) {
    it(name, t => {
      t.mock.method(console, 'warn', () => {});
      assert.equal(readPort(env), expected);
    });
  }
});

describe('readFrameAncestors', () => {
  const cases = [
    ['allows only the homepage when unset', {}, "'self'"],
    ['passes a list of sites through', { FRAME_ANCESTORS: " 'self' https://dash.test " }, "'self' https://dash.test"],
    ['refuses a value that would end the directive', { FRAME_ANCESTORS: "*; script-src *" }, "'self'"],
  ];
  for (const [name, env, expected] of cases) {
    it(name, t => {
      t.mock.method(console, 'warn', () => {});
      assert.equal(readFrameAncestors(env), expected);
    });
  }

  it('is used by the server', async () => {
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
