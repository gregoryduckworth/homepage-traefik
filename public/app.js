const LINE_COLOURS = ['#0a6cb4', '#00875a', '#c77700', '#a8327f', '#5a4fcf', '#0e7c86'];
const REFRESH_MS = 30000;

const els = {
  title: document.getElementById('title'),
  summary: document.getElementById('summary'),
  filter: document.getElementById('filter'),
  notice: document.getElementById('notice'),
  lines: document.getElementById('lines'),
  empty: document.getElementById('empty'),
  lineTemplate: document.getElementById('line-template'),
  stationTemplate: document.getElementById('station-template'),
};

let data = { routes: [], error: null, updatedAt: null };

function lineKey(route) {
  return route.entryPoints.length ? route.entryPoints.join(' + ') : 'default';
}

function matches(route, query) {
  if (!query) return true;
  return [route.host, route.path, route.service, route.name, route.rule]
    .some(value => value && value.toLowerCase().includes(query));
}

function renderStation(route) {
  const node = els.stationTemplate.content.firstElementChild.cloneNode(true);
  const link = node.querySelector('.host');
  node.dataset.status = route.status;

  if (route.url) {
    link.href = route.url;
    link.textContent = route.host;
    if (route.path) {
      const path = document.createElement('span');
      path.className = 'path';
      path.textContent = route.path;
      link.append(path);
    }
  } else {
    link.removeAttribute('target');
    link.textContent = route.name;
    link.title = route.rule;
  }

  node.querySelector('.service').textContent = route.service ? `Service ${route.service}` : route.rule;
  if (route.status === 'disabled') node.querySelector('.state').textContent = 'Disabled';
  if (route.status === 'warning') node.querySelector('.state').textContent = 'Check the Traefik dashboard: this route has warnings';
  return node;
}

function render() {
  const query = els.filter.value.trim().toLowerCase();
  const visible = data.routes.filter(route => matches(route, query));

  // Colours are assigned from the unfiltered list so a line keeps its colour while filtering.
  const totals = new Map();
  for (const route of data.routes) totals.set(lineKey(route), (totals.get(lineKey(route)) || 0) + 1);
  const keys = [...totals.keys()].sort((a, b) => totals.get(b) - totals.get(a) || a.localeCompare(b));

  const groups = new Map(keys.map(key => [key, []]));
  for (const route of visible) groups.get(lineKey(route)).push(route);

  const sections = keys.flatMap((key, index) => {
    const routes = groups.get(key);
    if (!routes.length) return [];
    const section = els.lineTemplate.content.firstElementChild.cloneNode(true);
    section.style.setProperty('--line', LINE_COLOURS[index % LINE_COLOURS.length]);
    section.querySelector('.line-name').textContent = key;
    section.querySelector('.stations').append(...routes.map(renderStation));
    return [section];
  });
  els.lines.replaceChildren(...sections);

  if (data.error) {
    els.notice.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = data.routes.length ? 'Showing the last routes we could load' : 'No routes loaded';
    els.notice.append(heading, document.createTextNode(data.error));
  }
  els.notice.hidden = !data.error;

  const count = data.routes.length;
  if (!data.updatedAt && !data.error) {
    els.summary.textContent = 'Looking up routes…';
  } else if (data.updatedAt) {
    const time = new Date(data.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    els.summary.textContent = `${count} ${count === 1 ? 'route' : 'routes'}, updated at ${time}`;
  } else {
    els.summary.textContent = 'Waiting for Traefik';
  }

  els.empty.hidden = true;
  if (data.updatedAt && !count) {
    els.empty.textContent = 'Traefik has no routes yet. Add a router with a Host rule, for example a traefik.http.routers.<name>.rule label on a container, and it will show up here.';
    els.empty.hidden = false;
  } else if (count && !visible.length) {
    els.empty.textContent = `Nothing matches “${els.filter.value.trim()}”. Clear the filter to see every route.`;
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

els.filter.addEventListener('input', render);
load();
setInterval(load, REFRESH_MS);
// Lines draw in once on first load; later refreshes shouldn't replay it.
setTimeout(() => document.body.classList.add('drawn'), 1000);
