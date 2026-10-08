const HOST_RE = /Host\(\s*`([^`]+)`/;
const PATH_RE = /(?:PathPrefix|Path)\(\s*`([^`]+)`/;

function parseRule(rule = '') {
  const host = rule.match(HOST_RE);
  const path = rule.match(PATH_RE);
  return {
    host: host ? host[1] : null,
    path: path ? path[1] : null,
  };
}

function normalizeRouter(router) {
  const { host, path } = parseRule(router.rule);
  const tls = Boolean(router.tls);
  const [name, provider = router.provider || 'unknown'] = (router.name || 'unnamed').split('@');
  const displayPath = path && path !== '/' ? path : '';

  return {
    id: router.name || name,
    name,
    provider,
    status: router.status || 'unknown',
    rule: router.rule || '',
    service: (router.service || '').split('@')[0] || null,
    entryPoints: router.entryPoints || [],
    middlewares: router.middlewares || [],
    priority: router.priority ?? null,
    errors: router.error || [],
    tls,
    certResolver: router.tls?.certResolver || null,
    host,
    path: displayPath,
    url: host ? `${tls ? 'https' : 'http'}://${host}${displayPath}` : null,
  };
}

// Routes are deduplicated on host+path so an HTTP->HTTPS redirect pair shows once, preferring TLS.
function normalizeRouters(routers) {
  const byTarget = new Map();
  const unaddressable = [];

  for (const raw of routers) {
    if (raw.provider === 'internal' || (raw.name || '').endsWith('@internal')) continue;
    const route = normalizeRouter(raw);
    if (!route.host) {
      unaddressable.push(route);
      continue;
    }
    const key = `${route.host}${route.path}`;
    const existing = byTarget.get(key);
    if (!existing || (route.tls && !existing.tls)) byTarget.set(key, route);
  }

  const addressable = [...byTarget.values()].sort((a, b) => a.host.localeCompare(b.host) || a.path.localeCompare(b.path));
  return [...addressable, ...unaddressable.sort((a, b) => a.name.localeCompare(b.name))];
}

async function fetchRouters(baseUrl, { fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  const routers = [];
  let page = 1;
  while (page) {
    const url = new URL('/api/http/routers', baseUrl);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', '100');
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`Traefik API at ${baseUrl} responded with HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error('Traefik API returned an unexpected response (expected an array of routers)');
    routers.push(...body);
    const next = parseInt(res.headers.get('x-next-page') || '', 10);
    page = next > page ? next : 0;
  }
  return routers;
}

module.exports = { parseRule, normalizeRouter, normalizeRouters, fetchRouters };
