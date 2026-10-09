const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readSettings, readSeconds, readPort, readFrameAncestors } = require('../src/env');

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
});

describe('readSettings', () => {
  it('uses the defaults when nothing is set', () => {
    const settings = readSettings({});
    assert.deepEqual(settings, {
      port: 3000,
      frameAncestors: "'self'",
      traefikUrl: 'http://traefik:8080',
      pollSeconds: 30,
      healthSeconds: 60,
      title: 'Routes',
      version: null,
      entryPointPorts: new Map(),
      configFile: path.resolve('config/homepage.json'),
      healthOptions: { timeoutMs: 10000, address: undefined },
    });
  });

  it('reads each setting from its variable', () => {
    const settings = readSettings({
      PORT: '8080',
      FRAME_ANCESTORS: 'https://dash.test',
      TRAEFIK_API_URL: 'http://proxy:8080',
      POLL_INTERVAL_SECONDS: '15',
      HEALTHCHECK_INTERVAL_SECONDS: '120',
      HOMEPAGE_TITLE: 'My lab',
      HOMEPAGE_VERSION: '1.2.3',
      ENTRYPOINT_PORTS: 'websecure:8443',
      CONFIG_FILE: '/data/homepage.json',
      HEALTHCHECK_TIMEOUT_SECONDS: '3',
      HEALTHCHECK_ADDRESS: 'traefik',
    });
    assert.deepEqual(settings, {
      port: 8080,
      frameAncestors: 'https://dash.test',
      traefikUrl: 'http://proxy:8080',
      pollSeconds: 15,
      healthSeconds: 120,
      title: 'My lab',
      version: '1.2.3',
      entryPointPorts: new Map([['websecure', 8443]]),
      configFile: '/data/homepage.json',
      healthOptions: { timeoutMs: 3000, address: 'traefik' },
    });
  });

  it('warns about entry point ports it cannot read and keeps the rest', t => {
    t.mock.method(console, 'warn', () => {});
    const { entryPointPorts } = readSettings({ ENTRYPOINT_PORTS: 'websecure:8443, web' });
    assert.deepEqual(entryPointPorts, new Map([['websecure', 8443]]));
    assert.match(console.warn.mock.calls[0].arguments[0], /Ignoring web in ENTRYPOINT_PORTS/);
  });
});
