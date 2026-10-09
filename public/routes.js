// What the page says about routes and how it lists them, worked out from the routes alone.

const FAILURE_LABELS = {
  TIMEOUT: 'Timed out',
  ENOTFOUND: 'DNS failed',
  EAI_AGAIN: 'DNS failed',
  ECONNREFUSED: 'Refused',
  ECONNRESET: 'Reset',
  EHOSTUNREACH: 'Unreachable',
  ENETUNREACH: 'Unreachable',
};

export function groupKey(route) {
  return route.entryPoints.length ? route.entryPoints.join(' + ') : 'default';
}

export function matches(route, query) {
  if (!query) return true;
  return [route.custom?.name, route.host, route.path, route.service, route.name, route.rule]
    .some(value => value && value.toLowerCase().includes(query));
}

// The server says which errors are certificate errors, since it's the one that knows Node's codes for them.
function failureLabel({ error, phase, certificateError }) {
  if (certificateError) return 'Certificate error';
  if (FAILURE_LABELS[error]) return FAILURE_LABELS[error];
  return phase === 'tls' || error?.startsWith('ERR_SSL') ? 'TLS error' : 'Down';
}

// Traefik's router status wins over the probe: a disabled router can't be up.
export function statusOf(route) {
  if (route.status === 'disabled') return { kind: 'off', label: 'Disabled' };
  if (route.status === 'warning') return { kind: 'warn', label: 'Warning' };
  if (route.protocol === 'tcp') return { kind: 'off', label: 'TCP' };
  if (!route.url) return { kind: 'off', label: 'No link' };
  if (!route.health) return { kind: 'checking', label: 'Checking' };
  if (!route.health.reachable) return { kind: 'down', label: failureLabel(route.health) };
  if (route.health.statusCode >= 500) return { kind: 'down', label: `HTTP ${route.health.statusCode}` };
  // Traefik's own 404: the check didn't reach the route, though the route may still work in a browser.
  if (route.health.unrouted) return { kind: 'warn', label: 'No router' };
  return { kind: 'up', label: 'Up' };
}

// A name set on the page wins over the router name, which reads better than the hostname.
export function displayName(route) {
  return route.custom?.name || route.name;
}

export function isHidden(route) {
  return Boolean(route.custom?.hidden);
}

// A TCP route has no link, but its HostSNI hostname is still the address people know it by.
export function addressOf(route) {
  if (route.protocol === 'tcp') return route.host;
  return route.url ? `${route.host}${route.port ? `:${route.port}` : ''}${route.path}` : null;
}

export function byName(a, b) {
  return displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base', numeric: true });
}

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function healthText(route) {
  const health = route.health;
  if (route.status === 'disabled') return 'Not checked while the router is disabled';
  if (route.protocol === 'tcp') return 'Not checked: TCP routes have no web address to request';
  if (!route.url) return 'Not checked: the rule has no Host to request';
  if (!health) return 'Waiting for the first check';
  if (!health.reachable) return `${health.detail || 'The request failed.'} (${health.error})`;
  if (health.unrouted) return health.detail;
  return `HTTP ${health.statusCode} in ${health.latencyMs} ms`;
}

function attemptText(health) {
  if (!health?.method) return null;
  return health.attempts > 1 ? 'HEAD, then retried with GET' : health.method;
}

function tlsText(route) {
  if (!route.tls) return 'No';
  if (route.passthrough) return 'Passed through to the service';
  return route.certResolver ? `Yes, certificates from ${route.certResolver}` : 'Yes';
}

export function detailRows(route) {
  const status = statusOf(route);
  return [
    ['Status', status.kind === 'checking' ? 'Checking' : status.label],
    ['Health check', healthText(route)],
    ['Checked with', attemptText(route.health)],
    ['Checked address', route.health?.address],
    ['Last checked', route.health?.checkedAt && timeOf(route.health.checkedAt)],
    ['Traefik status', route.status],
    ['Address', addressOf(route)],
    ['Router', route.id],
    ['Rule', route.rule, 'code'],
    ['Service', route.service],
    ['Entry points', route.entryPoints.join(', ')],
    ['Middlewares', route.middlewares.length ? route.middlewares.join(', ') : 'None'],
    ['Protocol', route.protocol === 'tcp' ? 'TCP' : 'HTTP'],
    ['TLS', tlsText(route)],
    ['Priority', route.priority],
  ].filter(([, value]) => value != null && value !== '');
}

// What the page lists, in order: each custom group, then the routes in no group by entry point, the biggest first. A
// route is shown unless it's hidden, while hidden routes aren't shown, or doesn't match `query`. Routes in a custom
// group that Traefik isn't serving right now are left out, and come back when it serves them again. While
// searching, custom groups with no matches are left out too. Each section's `hidden` counts the routes in it that
// are hidden and not shown. `shown` is every route shown, by name.
export function sectionsFor(routes, groups, { query = '', showHidden = false } = {}) {
  const shown = routes.filter(route => (showHidden || !isHidden(route)) && matches(route, query)).sort(byName);
  const byId = new Map(shown.map(route => [route.id, route]));
  const assigned = new Set(groups.flatMap(group => group.routes));

  const custom = groups
    .map(group => ({
      title: group.name,
      group,
      routes: group.routes.map(id => byId.get(id)).filter(Boolean),
      hidden: showHidden ? 0 : routes.filter(route => isHidden(route) && group.routes.includes(route.id)).length,
    }))
    .filter(section => section.routes.length || !query);

  const byKey = new Map();
  for (const route of shown) {
    if (assigned.has(route.id)) continue;
    const key = groupKey(route);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(route);
  }
  const entryPoints = [...byKey]
    .sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b))
    .map(([key, list]) => ({ title: key, group: null, routes: list, hidden: 0 }));

  return { shown, sections: [...custom, ...entryPoints] };
}
