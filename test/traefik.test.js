const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseRule, parseEntryPointPorts, normalizeRouter, normalizeRouters, fetchRouters } = require('../src/traefik');

describe('parseRule', () => {
  it('extracts host and path prefix', () => {
    assert.deepEqual(parseRule('Host(`app.example.com`) && PathPrefix(`/api`)'), { host: 'app.example.com', path: '/api' });
  });

  it('uses the first host when several are listed', () => {
    assert.equal(parseRule('Host(`a.example.com`) || Host(`b.example.com`)').host, 'a.example.com');
    assert.equal(parseRule('Host(`a.example.com`, `b.example.com`)').host, 'a.example.com');
  });

  it('reads Path as well as PathPrefix', () => {
    assert.equal(parseRule('Host(`x.test`) && Path(`/exact`)').path, '/exact');
  });

  it('returns nulls for rules without a host', () => {
    assert.deepEqual(parseRule('PathPrefix(`/metrics`)'), { host: null, path: '/metrics' });
    assert.deepEqual(parseRule(undefined), { host: null, path: null });
  });

  it('does not treat HostRegexp as a linkable host', () => {
    assert.equal(parseRule('HostRegexp(`{sub:[a-z]+}.example.com`)').host, null);
  });
});

describe('normalizeRouter', () => {
  it('builds an https URL for TLS routers and strips provider suffixes', () => {
    const route = normalizeRouter({
      name: 'grafana@docker',
      provider: 'docker',
      rule: 'Host(`grafana.home.lan`)',
      service: 'grafana-svc@docker',
      entryPoints: ['websecure'],
      tls: { certResolver: 'le' },
      status: 'enabled',
    });
    assert.equal(route.id, 'grafana@docker');
    assert.equal(route.name, 'grafana');
    assert.equal(route.provider, 'docker');
    assert.equal(route.service, 'grafana-svc');
    assert.equal(route.url, 'https://grafana.home.lan');
    assert.deepEqual(route.entryPoints, ['websecure']);
    assert.equal(route.certResolver, 'le');
  });

  it('keeps middlewares, priority and Traefik errors for the details view', () => {
    const route = normalizeRouter({
      name: 'app@docker',
      rule: 'Host(`app.test`)',
      middlewares: ['auth@file', 'compress@docker'],
      priority: 42,
      error: ['the service "missing@docker" does not exist'],
      status: 'warning',
    });
    assert.deepEqual(route.middlewares, ['auth@file', 'compress@docker']);
    assert.equal(route.priority, 42);
    assert.deepEqual(route.errors, ['the service "missing@docker" does not exist']);
  });

  it('defaults the details fields when Traefik omits them', () => {
    const route = normalizeRouter({ name: 'bare@file', rule: 'Host(`bare.test`)' });
    assert.deepEqual(route.middlewares, []);
    assert.deepEqual(route.errors, []);
    assert.equal(route.priority, null);
    assert.equal(route.certResolver, null);
  });

  it('builds an http URL and keeps a non-root path', () => {
    const route = normalizeRouter({ name: 'api@file', rule: 'Host(`h.test`) && PathPrefix(`/api`)' });
    assert.equal(route.url, 'http://h.test/api');
    assert.equal(route.path, '/api');
    assert.equal(route.provider, 'file');
  });

  it('drops a root path from the URL', () => {
    assert.equal(normalizeRouter({ name: 'r', rule: 'Host(`h.test`) && PathPrefix(`/`)' }).url, 'http://h.test');
  });

  it('has no URL when the rule has no host', () => {
    const route = normalizeRouter({ name: 'metrics@file', rule: 'PathPrefix(`/metrics`)' });
    assert.equal(route.url, null);
    assert.equal(route.status, 'unknown');
  });
});

describe('parseEntryPointPorts', () => {
  it('reads entry point names and ports, ignoring spaces and empty entries', () => {
    const { ports, invalid } = parseEntryPointPorts(' websecure:8443, web : 8080,, ');
    assert.deepEqual([...ports], [['websecure', 8443], ['web', 8080]]);
    assert.deepEqual(invalid, []);
  });

  it('reports entries without a valid port', () => {
    const { ports, invalid } = parseEntryPointPorts('websecure=8443,web:0,api:70000,admin:x,lan:9000');
    assert.deepEqual([...ports], [['lan', 9000]]);
    assert.deepEqual(invalid, ['websecure=8443', 'web:0', 'api:70000', 'admin:x']);
  });

  it('is empty when the setting is unset', () => {
    assert.equal(parseEntryPointPorts(undefined).ports.size, 0);
  });
});

describe('normalizeRouter with entry point ports', () => {
  const ports = new Map([['websecure', 8443], ['web', 80], ['lan', 8080]]);

  it('adds the entry point port to the URL', () => {
    const route = normalizeRouter({ name: 'app', rule: 'Host(`app.test`) && PathPrefix(`/ui`)', entryPoints: ['websecure'], tls: {} }, { ports });
    assert.equal(route.port, 8443);
    assert.equal(route.url, 'https://app.test:8443/ui');
  });

  it('leaves out the default port for the scheme', () => {
    const route = normalizeRouter({ name: 'app', rule: 'Host(`app.test`)', entryPoints: ['web'] }, { ports });
    assert.equal(route.port, null);
    assert.equal(route.url, 'http://app.test');
  });

  it('uses the first entry point that has a port', () => {
    const route = normalizeRouter({ name: 'app', rule: 'Host(`app.test`)', entryPoints: ['other', 'lan', 'websecure'] }, { ports });
    assert.equal(route.url, 'http://app.test:8080');
  });

  it('has no port for a route without a host', () => {
    assert.equal(normalizeRouter({ name: 'm', rule: 'PathPrefix(`/m`)', entryPoints: ['lan'] }, { ports }).port, null);
  });

  it('is passed through by normalizeRouters', () => {
    const [route] = normalizeRouters([{ name: 'app', rule: 'Host(`app.test`)', entryPoints: ['websecure'], tls: {} }], { ports });
    assert.equal(route.url, 'https://app.test:8443');
  });
});

describe('normalizeRouters', () => {
  it('filters internal routers', () => {
    const routes = normalizeRouters([
      { name: 'api@internal', provider: 'internal', rule: 'PathPrefix(`/api`)' },
      { name: 'dashboard@internal', rule: 'PathPrefix(`/`)' },
      { name: 'app@docker', provider: 'docker', rule: 'Host(`app.test`)' },
    ]);
    assert.deepEqual(routes.map(r => r.id), ['app@docker']);
  });

  it('collapses an http redirect router into its https sibling', () => {
    const routes = normalizeRouters([
      { name: 'app-http@docker', rule: 'Host(`app.test`)', entryPoints: ['web'] },
      { name: 'app@docker', rule: 'Host(`app.test`)', entryPoints: ['websecure'], tls: {} },
    ]);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].url, 'https://app.test');
  });

  it('keeps routes on the same host with different paths', () => {
    const routes = normalizeRouters([
      { name: 'b@docker', rule: 'Host(`app.test`) && PathPrefix(`/b`)' },
      { name: 'a@docker', rule: 'Host(`app.test`) && PathPrefix(`/a`)' },
    ]);
    assert.deepEqual(routes.map(r => r.url), ['http://app.test/a', 'http://app.test/b']);
  });

  it('sorts by host and puts host-less routes last', () => {
    const routes = normalizeRouters([
      { name: 'metrics@file', rule: 'PathPrefix(`/metrics`)' },
      { name: 'z@docker', rule: 'Host(`zeta.test`)' },
      { name: 'a@docker', rule: 'Host(`alpha.test`)' },
    ]);
    assert.deepEqual(routes.map(r => r.name), ['a', 'z', 'metrics']);
  });
});

function fakeResponse(body, { status = 200, nextPage } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(nextPage ? { 'X-Next-Page': String(nextPage) } : {}),
    json: async () => body,
  };
}

describe('fetchRouters', () => {
  it('requests the routers endpoint and follows pagination', async () => {
    const calls = [];
    const pages = { 1: fakeResponse([{ name: 'a' }], { nextPage: 2 }), 2: fakeResponse([{ name: 'b' }], { nextPage: 1 }) };
    const fetchImpl = async url => {
      calls.push(url.toString());
      return pages[url.searchParams.get('page')];
    };
    const routers = await fetchRouters('http://traefik:8080', { fetchImpl });
    assert.deepEqual(routers.map(r => r.name), ['a', 'b']);
    assert.deepEqual(calls, [
      'http://traefik:8080/api/http/routers?page=1&per_page=100',
      'http://traefik:8080/api/http/routers?page=2&per_page=100',
    ]);
  });

  it('throws a descriptive error on a non-2xx response', async () => {
    const fetchImpl = async () => fakeResponse(null, { status: 404 });
    await assert.rejects(fetchRouters('http://traefik:8080', { fetchImpl }), /HTTP 404/);
  });

  it('throws when the body is not an array', async () => {
    const fetchImpl = async () => fakeResponse({ message: 'nope' });
    await assert.rejects(fetchRouters('http://traefik:8080', { fetchImpl }), /unexpected response/);
  });
});
