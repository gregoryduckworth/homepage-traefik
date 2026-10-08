// Any HTTP response means the route is reachable; the UI decides how to present the status code.
async function checkHealth(url, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const start = Date.now();
  try {
    const res = await fetchImpl(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return { reachable: true, statusCode: res.status, latencyMs: Date.now() - start, error: null };
  } catch (err) {
    const error = err.name === 'TimeoutError' ? 'TIMEOUT' : err.cause?.code || err.message;
    return { reachable: false, statusCode: null, latencyMs: null, error };
  }
}

async function checkAllRoutes(routes, opts = {}) {
  const probed = routes.filter(route => route.url && route.status !== 'disabled');
  const results = await Promise.all(probed.map(route => checkHealth(route.url, opts)));
  return new Map(probed.map((route, i) => [route.id, results[i]]));
}

module.exports = { checkHealth, checkAllRoutes };
