// Any HTTP response means the route is reachable; the UI decides how to present the status code.
async function checkHealth(url, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const start = Date.now();
  try {
    const res = await fetchImpl(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return { reachable: true, statusCode: res.status, latencyMs: Date.now() - start };
  } catch {
    return { reachable: false, statusCode: null, latencyMs: null };
  }
}

async function checkAllRoutes(routes, opts = {}) {
  const addressable = routes.filter(route => route.url);
  const results = await Promise.all(addressable.map(route => checkHealth(route.url, opts)));
  return new Map(addressable.map((route, i) => [route.id, results[i]]));
}

module.exports = { checkHealth, checkAllRoutes };
