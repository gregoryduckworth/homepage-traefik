const GROUP_COLOURS = ['#3b82f6', '#10b981', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6'];
const REFRESH_MS = 30000;

const $ = id => document.getElementById(id);
const els = {
  title: $('title'),
  summary: $('summary'),
  filter: $('filter'),
  notice: $('notice'),
  routes: $('routes'),
  empty: $('empty'),
  stats: $('stats'),
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

// Traefik's router status wins over the probe: a disabled router can't be healthy.
function statusOf(route) {
  if (route.status === 'disabled') return { kind: 'disabled', label: 'Disabled' };
  if (route.status === 'warning') return { kind: 'warning', label: 'Warning' };
  if (!route.url) return { kind: 'unknown', label: 'No host' };
  if (!route.health) return { kind: 'checking', label: 'Checking' };
  if (!route.health.reachable) return { kind: 'unhealthy', label: 'Down' };
  if (route.health.statusCode >= 500) return { kind: 'unhealthy', label: `HTTP ${route.health.statusCode}` };
  return { kind: 'healthy', label: 'Up' };
}

function renderRoute(route) {
  const status = statusOf(route);
  const item = el('li');
  const card = el('article', 'route-card');
  card.dataset.status = route.status;

  const info = el('div', 'route-info');
  const host = el(route.url ? 'a' : 'span', 'route-host');
  if (route.url) {
    host.href = route.url;
    host.target = '_blank';
    host.rel = 'noopener noreferrer';
    host.textContent = route.host;
    if (route.path) host.append(el('span', 'route-path', route.path));
  } else {
    host.textContent = route.name;
    host.title = route.rule;
  }

  const meta = el('div', 'route-meta');
  if (route.service) meta.append(el('span', 'tag', route.service));
  meta.append(el('span', 'tag', route.provider));
  if (route.tls) meta.append(el('span', 'tag', 'TLS'));
  if (!route.url) meta.append(el('span', 'tag', route.rule));
  info.append(host, meta);

  const statusWrap = el('div', 'route-status');
  if (status.kind === 'healthy' && route.health.latencyMs != null) {
    statusWrap.append(el('span', 'latency', `${route.health.latencyMs} ms`));
  }
  const badge = el('span', `status-badge status-${status.kind}`);
  badge.append(el('span', 'dot'), document.createTextNode(status.label));
  if (status.kind === 'warning') badge.title = 'This router has warnings in the Traefik dashboard';
  statusWrap.append(badge);

  card.append(info, statusWrap);
  item.append(card);
  return item;
}

function renderStats() {
  const counts = { healthy: 0, unhealthy: 0, unknown: 0 };
  for (const route of data.routes) {
    const kind = statusOf(route).kind;
    if (kind === 'healthy') counts.healthy++;
    else if (kind === 'unhealthy' || kind === 'warning') counts.unhealthy++;
    else counts.unknown++;
  }
  $('stat-total').textContent = data.routes.length;
  $('stat-healthy').textContent = counts.healthy;
  $('stat-unhealthy').textContent = counts.unhealthy;
  $('stat-unknown').textContent = counts.unknown;
  els.stats.hidden = !data.routes.length;
}

function render() {
  const query = els.filter.value.trim().toLowerCase();
  const visible = data.routes.filter(route => matches(route, query));

  // Colours come from the unfiltered list so a group keeps its colour while filtering.
  const totals = new Map();
  for (const route of data.routes) totals.set(groupKey(route), (totals.get(groupKey(route)) || 0) + 1);
  const keys = [...totals.keys()].sort((a, b) => totals.get(b) - totals.get(a) || a.localeCompare(b));

  const groups = new Map(keys.map(key => [key, []]));
  for (const route of visible) groups.get(groupKey(route)).push(route);

  const sections = keys.flatMap((key, index) => {
    const routes = groups.get(key);
    if (!routes.length) return [];
    const section = el('section', 'route-group');
    const header = el('div', 'group-header');
    const badge = el('h2', 'group-badge', key);
    badge.style.background = GROUP_COLOURS[index % GROUP_COLOURS.length];
    header.append(badge, el('span', 'group-count', `${routes.length} ${routes.length === 1 ? 'route' : 'routes'}`));
    const list = el('ul', 'route-list');
    list.append(...routes.map(renderRoute));
    section.append(header, list);
    return [section];
  });
  els.routes.replaceChildren(...sections);

  if (data.error) {
    const heading = el('strong', null, data.routes.length ? 'Showing the last routes we could load' : 'No routes loaded');
    els.notice.replaceChildren(heading, document.createTextNode(data.error));
  }
  els.notice.hidden = !data.error;

  renderStats();

  const count = data.routes.length;
  if (!data.updatedAt && !data.error) {
    els.summary.textContent = 'Looking up routes…';
  } else if (data.updatedAt) {
    const time = new Date(data.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    els.summary.textContent = `${count} ${count === 1 ? 'route' : 'routes'} · updated ${time}`;
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

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  els.themeToggle.setAttribute('aria-pressed', String(theme === 'dark'));
}

const storedTheme = localStorage.getItem('theme');
applyTheme(storedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
els.themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
});

els.filter.addEventListener('input', render);
load();
setInterval(load, REFRESH_MS);
// Cards fade in on first load only; later refreshes shouldn't replay it.
setTimeout(() => document.body.classList.add('drawn'), 1000);
