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
};

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

// Traefik's router status wins over the probe: a disabled router can't be up.
function statusOf(route) {
  if (route.status === 'disabled') return { kind: 'off', label: 'Disabled' };
  if (route.status === 'warning') return { kind: 'warn', label: 'Warning' };
  if (!route.url) return { kind: 'off', label: 'No link' };
  if (!route.health) return { kind: 'checking', label: 'Checking' };
  if (!route.health.reachable) return { kind: 'down', label: FAILURE_LABELS[route.health.error] || 'Down', reason: route.health.error };
  if (route.health.statusCode >= 500) return { kind: 'down', label: `HTTP ${route.health.statusCode}` };
  return { kind: 'up', label: 'Up' };
}

function displayName(route) {
  return route.url ? `${route.host}${route.path}` : route.name;
}

function renderTile(route) {
  const status = statusOf(route);
  const tile = el(route.url ? 'a' : 'div', 'tile');
  tile.dataset.kind = status.kind;
  if (route.status === 'disabled') tile.dataset.disabled = '';
  tile.title = `${route.rule}\nProvider: ${route.provider}${status.reason ? `\nHealth check failed: ${status.reason}` : ''}`;
  if (route.url) {
    tile.href = route.url;
    tile.target = '_blank';
    tile.rel = 'noopener noreferrer';
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

  tile.append(dot, main, state);
  const item = el('li');
  item.append(tile);
  return item;
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
