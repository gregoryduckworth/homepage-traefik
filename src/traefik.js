const HOST_RE = /Host\(\s*`([^`]+)`/;
const PATH_RE = /(?:PathPrefix|Path)\(\s*`([^`]+)`/;
const HOST_SNI_RE = /HostSNI\(\s*`([^`]+)`/;

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

// The fields HTTP and TCP routes share.
function baseRoute(router) {
  const [name, provider = router.provider || 'unknown'] = (router.name || 'unnamed').split('@');
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
    tls: Boolean(router.tls),
    certResolver: router.tls?.certResolver || null,
  };
}

// `ports` maps entry point names to the port browsers reach them on, from parseEntryPointPorts.
function normalizeRouter(router, { ports = new Map() } = {}) {
  const route = baseRoute(router);
  const { host, path } = parseRule(router.rule);
  const displayPath = path && path !== '/' ? path : '';
  const port = host ? portOf(route.entryPoints, ports, route.tls) : null;
  return {
    ...route,
    protocol: 'http',
    host,
    port,
    path: displayPath,
    url: host ? `${route.tls ? 'https' : 'http'}://${host}${port ? `:${port}` : ''}${displayPath}` : null,
  };
}

// A TCP router has no web address to link to or check, so it's listed by name with its HostSNI hostname, if any.
// Its id is prefixed so it can't clash with an HTTP router of the same name in the groups file.
function normalizeTcpRouter(router) {
  const route = baseRoute(router);
  const sni = (router.rule || '').match(HOST_SNI_RE)?.[1];
  return {
    ...route,
    id: `tcp:${route.id}`,
    protocol: 'tcp',
    passthrough: Boolean(router.tls?.passthrough),
    host: sni && sni !== '*' ? sni : null,
    port: null,
    path: '',
    url: null,
  };
}

function isInternal(router) {
  return router.provider === 'internal' || (router.name || '').endsWith('@internal');
}

// Routes are deduplicated on host+path so an HTTP->HTTPS redirect pair shows once, preferring TLS. TCP routes come
// last, after the HTTP routes without a link. `ports` is as for normalizeRouter.
function normalizeRouters(routers, { ports, tcpRouters = [] } = {}) {
  const byTarget = new Map();
  const unaddressable = [];

  for (const raw of routers) {
    if (isInternal(raw)) continue;
    const route = normalizeRouter(raw, { ports });
    if (!route.host) {
      unaddressable.push(route);
      continue;
    }
    const key = `${route.host}${route.path}`;
    const existing = byTarget.get(key);
    if (!existing || (route.tls && !existing.tls)) byTarget.set(key, route);
  }

  const addressable = [...byTarget.values()].sort((a, b) => a.host.localeCompare(b.host) || a.path.localeCompare(b.path));
  const tcp = tcpRouters.filter(raw => !isInternal(raw)).map(normalizeTcpRouter);
  const byName = (a, b) => a.name.localeCompare(b.name);
  return [...addressable, ...unaddressable.sort(byName), ...tcp.sort(byName)];
}

// `protocol` is http or tcp, the two kinds of router this page lists.
async function fetchRouters(baseUrl, { fetchImpl = fetch, timeoutMs = 5000, protocol = 'http' } = {}) {
  const routers = [];
  let page = 1;
  while (page) {
    const url = new URL(`/api/${protocol}/routers`, baseUrl);
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

module.exports = { parseRule, parseEntryPointPorts, normalizeRouter, normalizeTcpRouter, normalizeRouters, fetchRouters };
