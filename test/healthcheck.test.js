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

  it('reports an unreachable route with the underlying error code', async () => {
    const fetchImpl = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }); };
    const { checkedAt, ...result } = await checkHealth('https://lab.test', { fetchImpl });
    assert.deepEqual(result, { reachable: false, statusCode: null, latencyMs: null, error: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    assert.ok(!Number.isNaN(Date.parse(checkedAt)));
  });

  it('reports a timeout distinctly', async () => {
    const fetchImpl = async () => { throw Object.assign(new Error('aborted'), { name: 'TimeoutError' }); };
    assert.equal((await checkHealth('http://slow.test', { fetchImpl })).error, 'TIMEOUT');
  });
});

describe('checkAllRoutes', () => {
  it('skips disabled routes', async () => {
    const fetchImpl = async () => ({ status: 200 });
    const results = await checkAllRoutes([{ id: 'off@docker', url: 'http://off.test', status: 'disabled' }], { fetchImpl });
    assert.equal(results.size, 0);
  });

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
