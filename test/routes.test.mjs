// The page's own module, which decides what each route shows. It runs in the browser, but needs nothing from it.
// Node has to work out that it's an ES module, which the test scripts don't warn about.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addressOf, byName, detailRows, displayName, groupKey, isHidden, matches, sectionsFor, statusOf } from '../public/routes.js';

function route(fields = {}) {
  return {
    id: 'app@docker',
    name: 'app',
    protocol: 'http',
    status: 'enabled',
    host: 'app.lab',
    port: null,
    path: '',
    url: 'https://app.lab',
    rule: 'Host(`app.lab`)',
    service: 'app',
    entryPoints: ['websecure'],
    middlewares: [],
    priority: null,
    errors: [],
    tls: true,
    certResolver: null,
    health: { reachable: true, statusCode: 200, latencyMs: 12, method: 'HEAD', attempts: 1, checkedAt: '2026-10-09T10:00:00.000Z' },
    custom: null,
    ...fields,
  };
}

function down(health) {
  return route({ health: { reachable: false, statusCode: null, ...health } });
}

describe('statusOf', () => {
  const cases = [
    ['a disabled router, whatever its check says', route({ status: 'disabled' }), 'off', 'Disabled'],
    ['a router with a warning', route({ status: 'warning' }), 'warn', 'Warning'],
    ['a TCP router', route({ protocol: 'tcp', url: null, health: null }), 'off', 'TCP'],
    ['a router with no Host', route({ url: null, health: null }), 'off', 'No link'],
    ['a route not checked yet', route({ health: null }), 'checking', 'Checking'],
    ['a route that answered below 500', route(), 'up', 'Up'],
    ['a route that answered with a 5xx', route({ health: { reachable: true, statusCode: 502 } }), 'down', 'HTTP 502'],
    ['Traefik\'s own 404', route({ health: { reachable: true, statusCode: 404, unrouted: true } }), 'warn', 'No router'],
    ['a timeout', down({ error: 'TIMEOUT' }), 'down', 'Timed out'],
    ['a DNS failure', down({ error: 'ENOTFOUND' }), 'down', 'DNS failed'],
    ['a refused connection', down({ error: 'ECONNREFUSED' }), 'down', 'Refused'],
    ['an unreachable network', down({ error: 'ENETUNREACH' }), 'down', 'Unreachable'],
    ['a certificate the server called untrusted', down({ error: 'SOME_NEW_CERT_CODE', certificateError: true }), 'down', 'Certificate error'],
    ['a failed TLS handshake', down({ error: 'EPROTO', phase: 'tls' }), 'down', 'TLS error'],
    ['an OpenSSL error', down({ error: 'ERR_SSL_WRONG_VERSION_NUMBER', phase: 'response' }), 'down', 'TLS error'],
    ['any other failure', down({ error: 'EWHATEVER', phase: 'response' }), 'down', 'Down'],
  ];
  for (const [name, input, kind, label] of cases) {
    it(`labels ${name}`, () => {
      assert.deepEqual(statusOf(input), { kind, label });
    });
  }
});

describe('displayName', () => {
  it('prefers a name set on the page over the router name', () => {
    assert.equal(displayName(route({ custom: { name: 'My app' } })), 'My app');
    assert.equal(displayName(route()), 'app');
  });
});

describe('isHidden', () => {
  it('is true only when the route was hidden on the page', () => {
    assert.equal(isHidden(route({ custom: { hidden: true } })), true);
    assert.equal(isHidden(route({ custom: { name: 'My app' } })), false);
    assert.equal(isHidden(route()), false);
  });
});

describe('addressOf', () => {
  it('joins the host, a port that is not the default and the path', () => {
    assert.equal(addressOf(route({ port: 8443, path: '/admin' })), 'app.lab:8443/admin');
  });

  it('is the HostSNI hostname for a TCP route, which has no link', () => {
    assert.equal(addressOf(route({ protocol: 'tcp', host: 'db.lab', url: null })), 'db.lab');
  });

  it('is null for a route with no link', () => {
    assert.equal(addressOf(route({ url: null })), null);
  });
});

describe('groupKey', () => {
  it('names the group after the entry points, or "default" when there are none', () => {
    assert.equal(groupKey(route({ entryPoints: ['web', 'websecure'] })), 'web + websecure');
    assert.equal(groupKey(route({ entryPoints: [] })), 'default');
  });
});

describe('matches', () => {
  it('matches everything when there is no query', () => {
    assert.equal(matches(route(), ''), true);
  });

  it('matches the page name, host, path, service, router name or rule', () => {
    const subject = route({ custom: { name: 'Media server' }, path: '/jelly', service: 'svc-x', rule: 'Host(`app.lab`) && Headers(`X-Y`, `z`)' });
    for (const query of ['media', 'app.lab', '/jelly', 'svc-x', 'app', 'headers']) {
      assert.equal(matches(subject, query), true, query);
    }
    assert.equal(matches(subject, 'nothing-like-it'), false);
  });
});

describe('byName', () => {
  it('sorts by the displayed name, ignoring case and counting numbers as numbers', () => {
    const names = ['node10', 'Beta', 'node2', 'alpha'].map(name => route({ name }));
    assert.deepEqual(names.sort(byName).map(displayName), ['alpha', 'Beta', 'node2', 'node10']);
  });
});

describe('detailRows', () => {
  const rows = input => Object.fromEntries(detailRows(input).map(([term, value]) => [term, value]));

  it('describes a healthy route', () => {
    const details = rows(route({ certResolver: 'le', middlewares: ['auth'] }));
    assert.equal(details.Status, 'Up');
    assert.equal(details['Health check'], 'HTTP 200 in 12 ms');
    assert.equal(details['Checked with'], 'HEAD');
    assert.equal(details.TLS, 'Yes, certificates from le');
    assert.equal(details.Middlewares, 'auth');
    assert.equal(typeof details['Last checked'], 'string');
  });

  it('explains a failed check with its error code', () => {
    const details = rows(down({ error: 'ECONNREFUSED', detail: 'Nothing is listening.', method: 'GET', attempts: 2 }));
    assert.equal(details['Health check'], 'Nothing is listening. (ECONNREFUSED)');
    assert.equal(details['Checked with'], 'HEAD, then retried with GET');
  });

  it('says why a route is not checked, and leaves out what it does not have', () => {
    const details = rows(route({ protocol: 'tcp', url: null, health: null, tls: true, passthrough: true, service: null }));
    assert.equal(details['Health check'], 'Not checked: TCP routes have no web address to request');
    assert.equal(details.TLS, 'Passed through to the service');
    assert.equal(details.Protocol, 'TCP');
    assert.equal('Service' in details, false);
    assert.equal('Checked with' in details, false);
  });

  it('shows the rule as code', () => {
    const rule = detailRows(route()).find(([term]) => term === 'Rule');
    assert.deepEqual(rule, ['Rule', 'Host(`app.lab`)', 'code']);
  });
});

describe('sectionsFor', () => {
  const jellyfin = route({ id: 'jellyfin', name: 'jellyfin', host: 'jellyfin.lab', entryPoints: ['web'] });
  const sonarr = route({ id: 'sonarr', name: 'sonarr', host: 'sonarr.lab', entryPoints: ['web'] });
  const grafana = route({ id: 'grafana', name: 'grafana', host: 'grafana.lab', entryPoints: ['websecure'] });
  const radarr = route({ id: 'radarr', name: 'radarr', host: 'radarr.lab', entryPoints: ['web'], custom: { hidden: true } });
  const routes = [sonarr, grafana, jellyfin, radarr];
  const titles = ({ sections }) => sections.map(section => section.title);

  it('lists custom groups first, then the other routes by entry point, the biggest first', () => {
    const groups = [{ name: 'Monitoring', routes: ['grafana'] }];
    assert.deepEqual(titles(sectionsFor(routes, groups)), ['Monitoring', 'web']);
  });

  it('lists entry point groups of the same size by name', () => {
    assert.deepEqual(titles(sectionsFor([grafana, jellyfin], [])), ['web', 'websecure']);
  });

  it('keeps a custom group\'s routes in the group\'s order', () => {
    const groups = [{ name: 'Media', routes: ['sonarr', 'jellyfin'] }];
    assert.deepEqual(sectionsFor(routes, groups).sections[0].routes, [sonarr, jellyfin]);
  });

  it('lists entry point groups by name', () => {
    assert.deepEqual(sectionsFor(routes, []).sections[0].routes, [jellyfin, sonarr]);
  });

  it('leaves out routes in a group that Traefik is not serving', () => {
    const groups = [{ name: 'Media', routes: ['plex', 'jellyfin'] }];
    assert.deepEqual(sectionsFor(routes, groups).sections[0].routes, [jellyfin]);
  });

  it('leaves out hidden routes, counting them against their group', () => {
    const groups = [{ name: 'Media', routes: ['radarr'] }];
    assert.deepEqual(sectionsFor(routes, groups).sections[0], { title: 'Media', group: groups[0], routes: [], hidden: 1 });
  });

  it('lists hidden routes while they are shown', () => {
    const groups = [{ name: 'Media', routes: ['radarr'] }];
    assert.deepEqual(sectionsFor(routes, groups, { showHidden: true }).sections[0].routes, [radarr]);
  });

  it('keeps an empty custom group when not searching', () => {
    assert.deepEqual(titles(sectionsFor(routes, [{ name: 'Empty', routes: [] }])), ['Empty', 'web', 'websecure']);
  });

  it('leaves out custom groups with no match while searching', () => {
    const groups = [{ name: 'Media', routes: ['jellyfin'] }, { name: 'Monitoring', routes: ['grafana'] }];
    assert.deepEqual(titles(sectionsFor(routes, groups, { query: 'graf' })), ['Monitoring']);
  });

  it('gives every route shown, by name', () => {
    assert.deepEqual(sectionsFor(routes, [], { query: 'arr' }).shown, [sonarr]);
  });
});
