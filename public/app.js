const REFRESH_MS = 30000;
const CERT_ERROR = 'Certificate error';
const FAILURE_LABELS = {
  TIMEOUT: 'Timed out',
  ENOTFOUND: 'DNS failed',
  EAI_AGAIN: 'DNS failed',
  ECONNREFUSED: 'Refused',
  DEPTH_ZERO_SELF_SIGNED_CERT: CERT_ERROR,
  SELF_SIGNED_CERT_IN_CHAIN: CERT_ERROR,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: CERT_ERROR,
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: CERT_ERROR,
  CERT_HAS_EXPIRED: CERT_ERROR,
  ERR_TLS_CERT_ALTNAME_INVALID: CERT_ERROR,
};

const $ = id => document.getElementById(id);
const els = {
  title: $('title'),
  summary: $('summary'),
  filter: $('filter'),
  notice: $('notice'),
  strip: $('strip'),
  routes: $('routes'),
  empty: $('empty'),
  themeToggle: $('theme-toggle'),
  details: $('details'),
};

const INFO_ICON = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/></svg>';

// Clicking the backdrop (the dialog element itself, outside its content box) closes it.
els.details.addEventListener('click', event => {
  if (event.target === els.details) els.details.close();
});

let data = { routes: [], error: null, updatedAt: null };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function groupKey(route) {
  return route.entryPoints.length ? route.entryPoints.join(' + ') : 'default';
}

function matches(route, query) {
  if (!query) return true;
  return [route.host, route.path, route.service, route.name, route.rule]
    .some(value => value && value.toLowerCase().includes(query));
}

function failureLabel(code) {
  if (FAILURE_LABELS[code]) return FAILURE_LABELS[code];
  return code?.startsWith('ERR_SSL') ? 'TLS error' : 'Down';
}

// Traefik's router status wins over the probe: a disabled router can't be up.
function statusOf(route) {
  if (route.status === 'disabled') return { kind: 'off', label: 'Disabled' };
  if (route.status === 'warning') return { kind: 'warn', label: 'Warning' };
  if (!route.url) return { kind: 'off', label: 'No link' };
  if (!route.health) return { kind: 'checking', label: 'Checking' };
  if (!route.health.reachable) return { kind: 'down', label: failureLabel(route.health.error) };
  if (route.health.statusCode >= 500) return { kind: 'down', label: `HTTP ${route.health.statusCode}` };
  return { kind: 'up', label: 'Up' };
}

function displayName(route) {
  return route.url ? `${route.host}${route.path}` : route.name;
}

function renderTile(route) {
  const status = statusOf(route);
  const tile = el('div', 'tile');
  tile.dataset.kind = status.kind;
  if (route.status === 'disabled') tile.dataset.disabled = '';

  const link = el(route.url ? 'a' : 'span', 'tile-link');
  if (route.url) {
    link.href = route.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }

  const dot = el('span', 'dot');
  if (status.kind === 'checking') dot.dataset.checking = '';

  const host = el('span', 'tile-host', route.url ? route.host : route.name);
  if (route.url && route.path) host.append(el('span', 'path', route.path));
  const main = el('span', 'tile-main');
  main.append(host, el('span', 'tile-sub', route.url ? route.service || route.name : route.rule));

  const state = el('span', 'tile-state');
  if (status.kind === 'up') {
    state.append(el('span', 'visually-hidden', 'Up, '), `${route.health.latencyMs} ms`);
  } else {
    state.textContent = status.label;
  }

  link.append(dot, main, state);

  const info = el('button', 'tile-info');
  info.type = 'button';
  info.setAttribute('aria-label', `Details for ${displayName(route)}`);
  info.innerHTML = INFO_ICON;
  info.addEventListener('click', () => openDetails(route.id));

  tile.append(link, info);
  const item = el('li');
  item.append(tile);
  return item;
}

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function healthText(route) {
  const health = route.health;
  if (route.status === 'disabled') return 'Not checked while the router is disabled';
  if (!route.url) return 'Not checked: the rule has no Host to request';
  if (!health) return 'Waiting for the first check';
  if (!health.reachable) return `Failed with ${health.error}`;
  return `HTTP ${health.statusCode} in ${health.latencyMs} ms`;
}

function detailRows(route) {
  const status = statusOf(route);
  return [
    ['Status', status.kind === 'checking' ? 'Checking' : status.label],
    ['Health check', healthText(route)],
    ['Last checked', route.health?.checkedAt && timeOf(route.health.checkedAt)],
    ['Traefik status', route.status],
    ['Router', route.id],
    ['Rule', route.rule, 'code'],
    ['Service', route.service],
    ['Entry points', route.entryPoints.join(', ')],
    ['Middlewares', route.middlewares.length ? route.middlewares.join(', ') : 'None'],
    ['TLS', route.tls ? (route.certResolver ? `Yes, certificates from ${route.certResolver}` : 'Yes') : 'No'],
    ['Priority', route.priority],
  ].filter(([, value]) => value != null && value !== '');
}

function fillDetails(route) {
  const status = statusOf(route);
  $('details-dot').parentElement.dataset.kind = status.kind;
  $('details-title').textContent = displayName(route);

  const errors = $('details-errors');
  errors.replaceChildren(...route.errors.map(message => el('p', null, message)));
  errors.hidden = !route.errors.length;

  $('details-list').replaceChildren(...detailRows(route).flatMap(([term, value, format]) => {
    const dd = el('dd');
    dd.append(format === 'code' ? el('code', null, value) : String(value));
    return [el('dt', null, term), dd];
  }));

  const open = $('details-open');
  open.hidden = !route.url;
  if (route.url) {
    open.href = route.url;
    open.textContent = `Open ${displayName(route)}`;
  }
}

let detailsId = null;

function openDetails(id) {
  const route = data.routes.find(r => r.id === id);
  if (!route) return;
  detailsId = id;
  fillDetails(route);
  els.details.showModal();
}

function refreshDetails() {
  if (!els.details.open) return;
  const route = data.routes.find(r => r.id === detailsId);
  if (route) fillDetails(route);
  else els.details.close();
}

function renderStrip() {
  const segments = data.routes.map(route => {
    const status = statusOf(route);
    const segment = el('span');
    segment.dataset.kind = status.kind;
    segment.title = `${displayName(route)}: ${status.label}`;
    return segment;
  });
  els.strip.replaceChildren(...segments);
  els.strip.hidden = !segments.length;
}

function summaryText() {
  const count = data.routes.length;
  const kinds = data.routes.map(route => statusOf(route).kind);
  const up = kinds.filter(kind => kind === 'up').length;
  const problems = kinds.filter(kind => kind === 'down' || kind === 'warn').length;
  const parts = [`${up} of ${count} ${count === 1 ? 'route' : 'routes'} up`];
  if (problems) parts.push(`${problems} ${problems === 1 ? 'needs' : 'need'} attention`);
  return parts.join(', ');
}

function render() {
  const query = els.filter.value.trim().toLowerCase();
  const visible = data.routes.filter(route => matches(route, query));

  const groups = new Map();
  for (const route of visible) {
    const key = groupKey(route);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(route);
  }
  const keys = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length || a.localeCompare(b));

  els.routes.replaceChildren(...keys.map(key => {
    const routes = groups.get(key);
    const section = el('section', 'group');
    const heading = el('h2', null, `${key} `);
    heading.append(el('span', null, `(${routes.length})`));
    const list = el('ul', 'tiles');
    list.append(...routes.map(renderTile));
    section.append(heading, list);
    return section;
  }));

  if (data.error) {
    const heading = el('strong', null, data.routes.length ? 'Showing the last routes we could load' : 'No routes loaded');
    els.notice.replaceChildren(heading, document.createTextNode(data.error));
  }
  els.notice.hidden = !data.error;

  renderStrip();
  refreshDetails();

  const count = data.routes.length;
  if (!data.updatedAt && !data.error) {
    els.summary.textContent = 'Looking up routes…';
  } else if (data.updatedAt) {
    const time = new Date(data.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const summary = count ? summaryText() : 'No routes';
    els.summary.textContent = `${summary}. Updated ${time}.`;
    els.strip.setAttribute('aria-label', summary);
  } else {
    els.summary.textContent = 'Waiting for Traefik';
  }

  els.empty.hidden = true;
  if (data.updatedAt && !count) {
    els.empty.textContent = 'Traefik has no routes yet. Add a router with a Host rule, for example a traefik.http.routers.<name>.rule label on a container, and it will show up here.';
    els.empty.hidden = false;
  } else if (count && !visible.length) {
    els.empty.textContent = `Nothing matches “${els.filter.value.trim()}”. Clear the search to see every route.`;
    els.empty.hidden = false;
  }
}

async function load() {
  try {
    const res = await fetch('api/routes', { cache: 'no-store' });
    if (!res.ok) throw new Error(`The homepage server responded with HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    data = { ...data, error: `Can't reach the homepage server. ${err.message}` };
  }
  if (data.title) {
    els.title.textContent = data.title;
    document.title = data.title;
  }
  render();
}

// Storage can throw when site data is blocked; the theme choice is a convenience, so fail quietly.
function storedTheme() {
  try { return localStorage.getItem('theme'); } catch { return null; }
}

const systemDark = matchMedia('(prefers-color-scheme: dark)');

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  els.themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
}

applyTheme(storedTheme() || (systemDark.matches ? 'dark' : 'light'));
systemDark.addEventListener('change', event => {
  if (!storedTheme()) applyTheme(event.matches ? 'dark' : 'light');
});
els.themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('theme', next); } catch {}
  applyTheme(next);
});

els.filter.addEventListener('input', render);
load();
setInterval(load, REFRESH_MS);
