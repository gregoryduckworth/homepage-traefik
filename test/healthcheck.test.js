const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { checkHealth, checkAllRoutes } = require('../src/healthcheck');

describe('checkHealth', () => {
  it('reports a reachable route with its status code and latency', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, method: init.method });
      return { status: 204 };
    };
    const result = await checkHealth('http://app.test', { fetchImpl });
    assert.equal(result.reachable, true);
    assert.equal(result.statusCode, 204);
    assert.equal(typeof result.latencyMs, 'number');
    assert.deepEqual(calls, [{ url: 'http://app.test', method: 'HEAD' }]);
  });

  it('reports an unreachable route when the request fails', async () => {
    const fetchImpl = async () => { throw new Error('fetch failed'); };
    assert.deepEqual(await checkHealth('http://down.test', { fetchImpl }), { reachable: false, statusCode: null, latencyMs: null });
  });
});

describe('checkAllRoutes', () => {
  it('checks only routes with a URL and keys results by route id', async () => {
    const fetchImpl = async url => {
      if (url === 'http://down.test') throw new Error('nope');
      return { status: 200 };
    };
    const results = await checkAllRoutes([
      { id: 'up@docker', url: 'http://up.test' },
      { id: 'down@docker', url: 'http://down.test' },
      { id: 'metrics@file', url: null },
    ], { fetchImpl });
    assert.deepEqual([...results.keys()], ['up@docker', 'down@docker']);
    assert.equal(results.get('up@docker').reachable, true);
    assert.equal(results.get('down@docker').reachable, false);
  });
});
