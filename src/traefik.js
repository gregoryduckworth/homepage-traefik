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

// Reads ENTRYPOINT_PORTS, such as "websecure:8443, web:8080": the port browsers reach each entry point on, for
// entry points that aren't on 80 or 443. Returns the ports by entry point name, and the entries that couldn't be read.
function parseEntryPointPorts(text = '') {
  const ports = new Map();
  const invalid = [];
  for (const entry of text.split(',').map(part => part.trim()).filter(Boolean)) {
    const match = entry.match(/^([^:\s]+)\s*:\s*(\d+)$/);
    const port = match && Number(match[2]);
    if (port >= 1 && port <= 65535) ports.set(match[1], port);
    else invalid.push(entry);
  }
  return { ports, invalid };
}

// The port of the first of the router's entry points that has one in `ports`, or null when that's the scheme's
// default port, which the URL leaves out.
function portOf(entryPoints, ports, tls) {
  const port = entryPoints.map(name => ports.get(name)).find(Boolean);
  return port && port !== (tls ? 443 : 80) ? port : null;
}

// `ports` maps entry point names to the port browsers reach them on, from parseEntryPointPorts.
function normalizeRouter(router, { ports = new Map() } = {}) {
  const { host, path } = parseRule(router.rule);
  const tls = Boolean(router.tls);
  const [name, provider = router.provider || 'unknown'] = (router.name || 'unnamed').split('@');
  const displayPath = path && path !== '/' ? path : '';
  const entryPoints = router.entryPoints || [];
  const port = host ? portOf(entryPoints, ports, tls) : null;

  return {
    id: router.name || name,
    name,
    provider,
    status: router.status || 'unknown',
    rule: router.rule || '',
    service: (router.service || '').split('@')[0] || null,
    entryPoints,
    middlewares: router.middlewares || [],
    priority: router.priority ?? null,
    errors: router.error || [],
    tls,
    certResolver: router.tls?.certResolver || null,
    host,
    port,
    path: displayPath,
    url: host ? `${tls ? 'https' : 'http'}://${host}${port ? `:${port}` : ''}${displayPath}` : null,
  };
}

// Routes are deduplicated on host+path so an HTTP->HTTPS redirect pair shows once, preferring TLS.
function normalizeRouters(routers, options = {}) {
  const byTarget = new Map();
  const unaddressable = [];

  for (const raw of routers) {
    if (raw.provider === 'internal' || (raw.name || '').endsWith('@internal')) continue;
    const route = normalizeRouter(raw, options);
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

module.exports = { parseRule, parseEntryPointPorts, normalizeRouter, normalizeRouters, fetchRouters };
