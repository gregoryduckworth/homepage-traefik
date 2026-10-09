const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createPoller } = require('../src/poller');

// A route store, icon store and events that record what the poller asks of them. `store` and `icons` replace parts of theirs.
function fakes({ store = {}, icons = {} } = {}) {
  const calls = { notify: 0, saveIcons: 0, iconRefreshes: [] };
  const route = { id: 'app@docker', url: 'http://app.test', health: { reachable: true, statusCode: 200 } };
  return {
    calls,
    route,
    store: {
      state: { updatedAt: '2026-01-01T00:00:00.000Z' },
      refresh: async () => false,
      refreshHealth: async () => false,
      checkRoute: async id => (id === route.id ? route : null),
      getRoutesWithHealth: () => [route],
      ...store,
    },
    icons: {
      refresh: async routes => {
        calls.iconRefreshes.push(routes);
        return false;
      },
      recheck: async () => false,
      ...icons,
    },
    events: { notify: () => { calls.notify++; } },
    saveIcons: () => { calls.saveIcons++; },
  };
}

// Icon lookups run in the background, after poll() has resolved.
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('createPoller poll', () => {
  it('tells the page when the routes changed', async () => {
    const f = fakes({ store: { refresh: async () => true } });
    await createPoller(f).poll();
    assert.equal(f.calls.notify, 1);
  });

  it('tells the page when a route\'s health changed', async () => {
    const f = fakes({ store: { refreshHealth: async () => true } });
    await createPoller(f).poll();
    assert.equal(f.calls.notify, 1);
  });

  it('does not tell the page anything when nothing changed', async () => {
    const f = fakes();
    await createPoller(f).poll();
    assert.equal(f.calls.notify, 0);
  });

  it('skips a tick while the previous poll is still running', async () => {
    const pending = [];
    const f = fakes({ store: { refresh: () => new Promise(resolve => pending.push(resolve)) } });
    const poller = createPoller(f);
    const polls = [poller.poll(), poller.poll()];
    const refreshes = pending.length;
    pending.forEach(resolve => resolve(false));
    await Promise.all(polls);
    assert.equal(refreshes, 1);
  });

  it('looks up icons for the routes with their health', async () => {
    const f = fakes();
    await createPoller(f).poll();
    await settle();
    assert.deepEqual(f.calls.iconRefreshes, [[f.route]]);
  });

  it('does not look up icons until Traefik has answered, which would forget the saved ones', async () => {
    const f = fakes({ store: { state: { updatedAt: null } } });
    await createPoller(f).poll();
    await settle();
    assert.deepEqual(f.calls.iconRefreshes, []);
  });

  it('saves the icons when one changed', async () => {
    const f = fakes({ icons: { refresh: async () => true } });
    await createPoller(f).poll();
    await settle();
    assert.equal(f.calls.saveIcons, 1);
  });

  it('logs a failed poll rather than rejecting, so the next tick still runs', async t => {
    t.mock.method(console, 'error', () => {});
    const f = fakes({ store: { refresh: async () => { throw new Error('boom'); } } });
    await createPoller(f).poll();
    assert.equal(console.error.mock.calls[0].arguments[0], 'Polling failed: boom');
  });

  it('logs a failed icon lookup', async t => {
    t.mock.method(console, 'error', () => {});
    const f = fakes({ icons: { refresh: async () => { throw new Error('no network'); } } });
    await createPoller(f).poll();
    await settle();
    assert.equal(console.error.mock.calls[0].arguments[0], 'Looking up route icons failed: no network');
  });
});

describe('createPoller check', () => {
  it('resolves to the checked route', async () => {
    const f = fakes();
    assert.equal(await createPoller(f).check('app@docker'), f.route);
  });

  it('tells the page about the new health', async () => {
    const f = fakes();
    await createPoller(f).check('app@docker');
    assert.equal(f.calls.notify, 1);
  });

  it('saves the icons when the route\'s icon changed', async () => {
    const f = fakes({ icons: { recheck: async () => true } });
    await createPoller(f).check('app@docker');
    assert.equal(f.calls.saveIcons, 1);
  });

  it('does not save the icons when the route\'s icon is the same', async () => {
    const f = fakes();
    await createPoller(f).check('app@docker');
    assert.equal(f.calls.saveIcons, 0);
  });

  it('still resolves to the route when its icon lookup fails', async t => {
    t.mock.method(console, 'error', () => {});
    const f = fakes({ icons: { recheck: async () => { throw new Error('no network'); } } });
    assert.equal(await createPoller(f).check('app@docker'), f.route);
  });

  it('logs a failed icon lookup', async t => {
    t.mock.method(console, 'error', () => {});
    const f = fakes({ icons: { recheck: async () => { throw new Error('no network'); } } });
    await createPoller(f).check('app@docker');
    assert.equal(console.error.mock.calls[0].arguments[0], 'Looking up the icon for app@docker failed: no network');
  });

  it('resolves to null, telling no one, for a route with nothing to check', async () => {
    const f = fakes();
    assert.equal(await createPoller(f).check('other@docker'), null);
    assert.equal(f.calls.notify, 0);
  });
});
