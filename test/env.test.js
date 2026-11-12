const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readSettings, readSeconds, readPort, readFlag, readFrameAncestors, readTraefikApi } = require('../src/env');

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

describe('readFlag', () => {
  const cases = [
    ['is false when unset', {}, false, false],
    ['is false when empty', { READ_ONLY: ' ' }, false, false],
    ['warns about a value that is neither and treats it as true, so a typo never leaves the page open', { READ_ONLY: 'ture' }, true, true],
  ];
  for (const [name, env, expected, warns] of cases) {
    it(name, t => {
      t.mock.method(console, 'warn', () => {});
      assert.equal(readFlag(env, 'READ_ONLY'), expected);
      assert.equal(console.warn.mock.callCount(), warns ? 1 : 0);
    });
  }

  it('accepts each way of saying yes or no, in any case and with spaces around it', () => {
    for (const value of ['true', '1', 'yes', ' On ', 'TRUE']) assert.equal(readFlag({ READ_ONLY: value }, 'READ_ONLY'), true, value);
    for (const value of ['false', '0', 'no', 'off', 'False ']) assert.equal(readFlag({ READ_ONLY: value }, 'READ_ONLY'), false, value);
  });
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

describe('readTraefikApi', () => {
  // Stands in for the filesystem: only /run/secrets/traefik exists.
  const readFile = file => {
    if (file === '/run/secrets/traefik') return 'from-file\n';
    throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
  };
  const admin = password => ({ username: 'admin', password });
  const cases = [
    ['sends no credentials when none are set', {}, { traefikUrl: 'http://traefik:8080', traefikAuth: null }],
    ['takes them out of the URL', { TRAEFIK_API_URL: 'http://admin:s3cret@proxy:8080' }, { traefikUrl: 'http://proxy:8080', traefikAuth: admin('s3cret') }],
    ['reads them from their variables', { TRAEFIK_API_USERNAME: 'admin', TRAEFIK_API_PASSWORD: 's3cret' }, { traefikUrl: 'http://traefik:8080', traefikAuth: admin('s3cret') }],
    ['prefers the variables to the URL', { TRAEFIK_API_URL: 'http://old:old@proxy:8080', TRAEFIK_API_USERNAME: 'admin', TRAEFIK_API_PASSWORD: 's3cret' }, { traefikUrl: 'http://proxy:8080', traefikAuth: admin('s3cret') }],
    ['reads the password from a file without its line break', { TRAEFIK_API_USERNAME: 'admin', TRAEFIK_API_PASSWORD_FILE: '/run/secrets/traefik' }, { traefikUrl: 'http://traefik:8080', traefikAuth: admin('from-file') }],
    ['prefers the password file to the password variable', { TRAEFIK_API_USERNAME: 'admin', TRAEFIK_API_PASSWORD: 's3cret', TRAEFIK_API_PASSWORD_FILE: '/run/secrets/traefik' }, { traefikUrl: 'http://traefik:8080', traefikAuth: admin('from-file') }],
    ['sends no password when the password file cannot be read', { TRAEFIK_API_USERNAME: 'admin', TRAEFIK_API_PASSWORD_FILE: '/missing' }, { traefikUrl: 'http://traefik:8080', traefikAuth: admin('') }],
    ['sends nothing for a password without a username', { TRAEFIK_API_PASSWORD: 's3cret' }, { traefikUrl: 'http://traefik:8080', traefikAuth: null }],
  ];
  for (const [name, env, expected] of cases) {
    it(name, t => {
      t.mock.method(console, 'warn', () => {});
      assert.deepEqual(readTraefikApi(env, { readFile }), expected);
    });
  }

  it('warns about a password file it cannot read without showing the password', t => {
    t.mock.method(console, 'warn', () => {});
    readTraefikApi({ TRAEFIK_API_USERNAME: 'admin', TRAEFIK_API_PASSWORD: 's3cret', TRAEFIK_API_PASSWORD_FILE: '/missing' }, { readFile });
    const warnings = console.warn.mock.calls.map(call => call.arguments[0]).join('\n');
    assert.match(warnings, /Can't read TRAEFIK_API_PASSWORD_FILE=\/missing \(ENOENT\)/);
    assert.doesNotMatch(warnings, /s3cret/);
  });
});

describe('readTraefikApi with credentials in a URL it cannot parse', () => {
  it('warns that they are ignored without showing the password', t => {
    t.mock.method(console, 'warn', () => {});
    readTraefikApi({ TRAEFIK_API_URL: 'http://admin:s3/cret@traefik:8080' });
    const warnings = console.warn.mock.calls.map(call => call.arguments[0]).join('\n');
    assert.match(warnings, /TRAEFIK_API_URL=http:\/\/traefik:8080 isn't a valid http:\/\/ or https:\/\/ URL, so the username and password in it are ignored/);
    assert.doesNotMatch(warnings, /s3|cret/);
  });

  it('does not warn about a URL without credentials', t => {
    t.mock.method(console, 'warn', () => {});
    readTraefikApi({ TRAEFIK_API_URL: 'http://traefik:8080' });
    assert.equal(console.warn.mock.callCount(), 0);
  });
});

describe('readSettings', () => {
  it('uses the defaults when nothing is set', () => {
    const settings = readSettings({});
    assert.deepEqual(settings, {
      port: 3000,
      frameAncestors: "'self'",
      readOnly: false,
      traefikUrl: 'http://traefik:8080',
      traefikAuth: null,
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
      READ_ONLY: 'true',
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
      readOnly: true,
      traefikUrl: 'http://proxy:8080',
      traefikAuth: null,
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
