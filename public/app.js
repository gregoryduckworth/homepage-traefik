const REFRESH_MS = 30000;
const RECONNECT_MS = 5000;
const CERT_ERROR = 'Certificate error';
const FAILURE_LABELS = {
  TIMEOUT: 'Timed out',
  ENOTFOUND: 'DNS failed',
  EAI_AGAIN: 'DNS failed',
  ECONNREFUSED: 'Refused',
  ECONNRESET: 'Reset',
  EHOSTUNREACH: 'Unreachable',
  ENETUNREACH: 'Unreachable',
  DEPTH_ZERO_SELF_SIGNED_CERT: CERT_ERROR,
  SELF_SIGNED_CERT_IN_CHAIN: CERT_ERROR,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: CERT_ERROR,
  UNABLE_TO_GET_ISSUER_CERT: CERT_ERROR,
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: CERT_ERROR,
  CERT_HAS_EXPIRED: CERT_ERROR,
  CERT_NOT_YET_VALID: CERT_ERROR,
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
  detailsGroup: $('details-group'),
  newGroup: $('new-group'),
  groupDialog: $('group-dialog'),
  groupForm: $('group-form'),
  groupName: $('group-name'),
  groupError: $('group-error'),
  groupSubmit: $('group-submit'),
  ungroupZone: $('ungroup-zone'),
  routeDialog: $('route-dialog'),
  routeForm: $('route-form'),
  routeName: $('route-name'),
  routeIcon: $('route-icon'),
  routeError: $('route-error'),
  routeSubmit: $('route-submit'),
};

const INFO_ICON = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd"/></svg>';
const RENAME_ICON = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>';
const DELETE_ICON = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>';
const UP_ICON = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z" clip-rule="evenodd"/></svg>';
const DOWN_ICON = '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>';
const DRAG_TYPE = 'application/x-homepage-route';
const GROUP_DRAG_TYPE = 'application/x-homepage-group';

// Backdrop clicks also target the dialog, as do clicks in its children's margins, so close only when outside its box.
function closeOnBackdrop(dialog) {
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    const inside = event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom;
    if (!inside) dialog.close();
  });
}
closeOnBackdrop(els.details);
closeOnBackdrop(els.groupDialog);
closeOnBackdrop(els.routeDialog);

let data = { routes: [], groups: [], error: null, configError: null, updatedAt: null };
let saveError = null;
let saving = 0;
// Bumped on every change made on this page, so a poll that started before the change can't undo it.
let groupEdits = 0;
// The groups the server last reported, which the page falls back to when a save fails.
let confirmedGroups = [];
// The id of the route or the name of the group being dragged. Re-rendering mid-drag would detach the dragged
// element, so renders wait for the drop.
let dragId = null;
let dragGroup = null;
let renderPending = false;

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
  return [route.custom?.name, route.host, route.path, route.service, route.name, route.rule]
    .some(value => value && value.toLowerCase().includes(query));
}

function failureLabel({ error, phase }) {
  if (FAILURE_LABELS[error]) return FAILURE_LABELS[error];
  return phase === 'tls' || error?.startsWith('ERR_SSL') ? 'TLS error' : 'Down';
}

// Traefik's router status wins over the probe: a disabled router can't be up.
function statusOf(route) {
  if (route.status === 'disabled') return { kind: 'off', label: 'Disabled' };
  if (route.status === 'warning') return { kind: 'warn', label: 'Warning' };
  if (!route.url) return { kind: 'off', label: 'No link' };
  if (!route.health) return { kind: 'checking', label: 'Checking' };
  if (!route.health.reachable) return { kind: 'down', label: failureLabel(route.health) };
  if (route.health.statusCode >= 500) return { kind: 'down', label: `HTTP ${route.health.statusCode}` };
  // Traefik's own 404: the check didn't reach the route, though the route may still work in a browser.
  if (route.health.unrouted) return { kind: 'warn', label: 'No router' };
  return { kind: 'up', label: 'Up' };
}

// A name set on the page wins over the router name, which reads better than the hostname.
function displayName(route) {
  return route.custom?.name || route.name;
}

function addressOf(route) {
  return route.url ? `${route.host}${route.path}` : null;
}

function byName(a, b) {
  return displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base', numeric: true });
}

// An icon set on the page, else the one the server found on the site, else the name's first letter; an image that
// doesn't load falls through to the next. The status dot sits on its corner.
function renderIcon(route, dot) {
  const box = el('span', 'tile-icon');
  const letter = el('span', 'tile-letter', [...displayName(route)][0]?.toUpperCase() || '?');
  letter.setAttribute('aria-hidden', 'true');
  const sources = [route.custom?.icon, route.icon].filter(Boolean);
  if (sources.length) {
    const img = el('img');
    img.alt = '';
    img.draggable = false;
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      sources.shift();
      if (sources.length) img.src = sources[0];
      else img.replaceWith(letter);
    });
    img.src = sources[0];
    box.append(img);
  } else {
    box.append(letter);
  }
  box.append(dot);
  return box;
}

function renderTile(route) {
  const status = statusOf(route);
  const tile = el('div', 'tile');
  tile.dataset.kind = status.kind;
  if (route.status === 'disabled') tile.dataset.disabled = '';

  const link = el(route.url ? 'a' : 'span', 'tile-link');
  if (route.url) {
    link.draggable = false;
    link.href = route.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }

  const dot = el('span', 'dot');
  if (status.kind === 'checking') dot.dataset.checking = '';

  const main = el('span', 'tile-main');
  main.append(el('span', 'tile-name', displayName(route)), el('span', 'tile-sub', addressOf(route) || route.rule));

  const state = el('span', 'tile-state');
  if (status.kind === 'up') {
    state.append(el('span', 'visually-hidden', 'Up, '), `${route.health.latencyMs} ms`);
  } else {
    state.textContent = status.label;
  }

  link.append(renderIcon(route, dot), main, state);

  const info = el('button', 'tile-info');
  info.type = 'button';
  info.setAttribute('aria-label', `Details for ${displayName(route)}`);
  info.innerHTML = INFO_ICON;
  info.addEventListener('click', () => openDetails(route.id));

  tile.append(link, info);
  const item = el('li');
  item.dataset.route = route.id;
  item.draggable = true;
  item.addEventListener('dragstart', event => startDrag(event, item));
  item.addEventListener('dragend', endDrag);
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
  if (!health.reachable) return `${health.detail || 'The request failed.'} (${health.error})`;
  if (health.unrouted) return health.detail;
  return `HTTP ${health.statusCode} in ${health.latencyMs} ms`;
}

function attemptText(health) {
  if (!health?.method) return null;
  return health.attempts > 1 ? 'HEAD, then retried with GET' : health.method;
}

function detailRows(route) {
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

  const current = groupOf(route.id);
  els.detailsGroup.replaceChildren(new Option('None', ''), ...data.groups.map(group => new Option(group.name, group.name)));
  els.detailsGroup.value = current ? current.name : '';
  els.detailsGroup.parentElement.hidden = !data.groups.length;

  const open = $('details-open');
  open.hidden = !route.url;
  if (route.url) {
    open.href = route.url;
    open.textContent = `Open ${addressOf(route)}`;
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
  const segments = [...data.routes].sort(byName).map(route => {
    const status = statusOf(route);
    const segment = el('span');
    segment.dataset.kind = status.kind;
    const reason = (status.kind === 'down' || route.health?.unrouted) && route.health?.detail;
    segment.title = `${displayName(route)}: ${reason || status.label}`;
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

function groupOf(id) {
  return data.groups.find(group => group.routes.includes(id));
}

function iconButton(icon, label, onClick) {
  const button = el('button', 'group-tool');
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = icon;
  button.addEventListener('click', onClick);
  return button;
}

// Custom groups get buttons to move, rename and delete them, and can be dragged by their heading; entry point
// groups are where ungrouped routes land.
function renderSection(title, routes, group) {
  const section = el('section', 'group');
  const head = el('div', 'group-head');
  const heading = el('h2', null, `${title} `);
  heading.append(el('span', null, `(${routes.length})`));
  head.append(heading);
  section.append(head);

  if (group) {
    section.dataset.group = group.name;
    head.draggable = true;
    head.addEventListener('dragstart', event => startGroupDrag(event, section));
    head.addEventListener('dragend', endDrag);
    if (data.groups.length > 1) {
      const index = data.groups.indexOf(group);
      const up = iconButton(UP_ICON, `Move ${group.name} up`, () => shiftGroup(group.name, -1));
      const down = iconButton(DOWN_ICON, `Move ${group.name} down`, () => shiftGroup(group.name, 1));
      up.dataset.move = down.dataset.move = '';
      up.disabled = index === 0;
      down.disabled = index === data.groups.length - 1;
      head.append(up, down);
    }
    head.append(
      iconButton(RENAME_ICON, `Rename ${group.name}`, () => openGroupDialog(group.name)),
      iconButton(DELETE_ICON, `Delete ${group.name}`, () => deleteGroup(group.name)),
    );
  }
  if (group && !routes.length) {
    section.append(el('p', 'group-empty', 'Drag routes here, or choose this group in a route’s details.'));
  } else {
    const list = el('ul', 'tiles');
    list.append(...routes.map(renderTile));
    section.append(list);
  }
  return section;
}

function renderNotice() {
  const notices = [];
  if (data.error) notices.push([data.routes.length ? 'Showing the last routes we could load' : 'No routes loaded', data.error]);
  if (data.configError) notices.push(['Groups couldn’t be loaded from the config file', data.configError]);
  if (saveError) notices.push(['Your group change wasn’t saved', saveError]);
  els.notice.replaceChildren(...notices.map(([heading, text]) => {
    const item = el('p');
    item.append(el('strong', null, heading), text);
    return item;
  }));
  els.notice.hidden = !notices.length;
}

function render() {
  if (dragId || dragGroup) {
    renderPending = true;
    return;
  }
  renderPending = false;
  const query = els.filter.value.trim().toLowerCase();
  const visible = data.routes.filter(route => matches(route, query)).sort(byName);
  const byId = new Map(visible.map(route => [route.id, route]));
  const assigned = new Set(data.groups.flatMap(group => group.routes));

  // Configured routes that Traefik isn't serving right now stay in the file and reappear when they come back.
  const custom = data.groups
    .map(group => ({ group, routes: group.routes.map(id => byId.get(id)).filter(Boolean) }))
    .filter(({ routes }) => routes.length || !query);

  const groups = new Map();
  for (const route of visible) {
    if (assigned.has(route.id)) continue;
    const key = groupKey(route);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(route);
  }
  const keys = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length || a.localeCompare(b));

  // Rebuilding the list drops focus, so put it back on the button with the same label.
  const focused = els.routes.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
  els.routes.replaceChildren(
    ...custom.map(({ group, routes }) => renderSection(group.name, routes, group)),
    ...keys.map(key => renderSection(key, groups.get(key))),
  );
  if (focused) [...els.routes.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === focused)?.focus();

  renderNotice();

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

// Resolves to the server's reply, or throws with the reason it gives for refusing the change.
async function putJson(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const reply = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(reply.error || `The homepage server responded with HTTP ${res.status}`);
  return reply;
}

// Saving is optimistic: the page shows the change at once. If the server refuses it, the page goes back to the
// groups the server last confirmed and reloads them, which stays correct even when several saves were in flight.
async function saveGroups(groups) {
  if (JSON.stringify(groups) === JSON.stringify(data.groups)) return;
  data.groups = groups;
  saveError = null;
  saving++;
  groupEdits++;
  render();
  let failed = false;
  try {
    const body = await putJson('api/groups', { groups });
    confirmedGroups = body.groups;
    // A later save still in flight holds newer groups than this response. Once none is, the server has every
    // change made on the page, including any whose own save failed, so an earlier error no longer applies.
    if (saving === 1) {
      data.groups = body.groups;
      saveError = null;
    }
  } catch (err) {
    failed = true;
    saveError = err.message;
  } finally {
    saving--;
  }
  // A save still in flight settles the groups itself when it finishes.
  if (failed && !saving) {
    data.groups = confirmedGroups;
    await load();
  } else {
    render();
  }
}

function moveRoute(id, target, beforeId) {
  if (id === beforeId) return;
  const groups = data.groups.map(group => ({ ...group, routes: group.routes.filter(routeId => routeId !== id) }));
  const group = groups.find(g => g.name === target);
  if (group) {
    const index = beforeId ? group.routes.indexOf(beforeId) : -1;
    group.routes.splice(index < 0 ? group.routes.length : index, 0, id);
  }
  saveGroups(groups);
}

// Puts a group in front of another one, or last when there's no other one.
function moveGroup(name, beforeName) {
  const group = data.groups.find(g => g.name === name);
  if (!group || name === beforeName) return;
  const groups = data.groups.filter(g => g !== group);
  const index = beforeName ? groups.findIndex(g => g.name === beforeName) : -1;
  groups.splice(index < 0 ? groups.length : index, 0, group);
  saveGroups(groups);
}

// Moves a group one place up or down. Rendering keeps focus on the pressed button, unless the group reached the
// top or bottom and the button is now disabled; then focus goes to the group's other arrow.
function shiftGroup(name, step) {
  const index = data.groups.findIndex(g => g.name === name);
  const target = index + step;
  if (index < 0 || target < 0 || target >= data.groups.length) return;
  moveGroup(name, data.groups[step < 0 ? target : target + 1]?.name ?? null);
  if (els.routes.contains(document.activeElement)) return;
  const section = [...els.routes.querySelectorAll('.group[data-group]')].find(s => s.dataset.group === name);
  section?.querySelector('[data-move]:enabled')?.focus();
}

function deleteGroup(name) {
  const group = data.groups.find(g => g.name === name);
  if (group.routes.length && !confirm(`Delete the “${name}” group? Its routes go back to their entry point groups.`)) return;
  saveGroups(data.groups.filter(g => g !== group));
}

let renamingGroup = null;

function openGroupDialog(name = null) {
  renamingGroup = name;
  $('group-dialog-title').textContent = name ? 'Rename group' : 'New group';
  els.groupSubmit.textContent = name ? 'Rename group' : 'Create group';
  els.groupName.value = name || '';
  els.groupError.hidden = true;
  els.groupDialog.showModal();
}

els.groupForm.addEventListener('submit', event => {
  const name = els.groupName.value.trim();
  const taken = data.groups.find(group => group.name.toLowerCase() === name.toLowerCase() && group.name !== renamingGroup);
  if (!name || taken) {
    event.preventDefault();
    els.groupError.textContent = taken ? `There’s already a group called “${taken.name}”.` : 'Enter a name for the group.';
    els.groupError.hidden = false;
    return;
  }
  saveGroups(renamingGroup
    ? data.groups.map(group => (group.name === renamingGroup ? { ...group, name } : group))
    : [...data.groups, { name, routes: [] }]);
});

els.newGroup.addEventListener('click', () => openGroupDialog());

// Names and icons are saved one route at a time, and the dialog stays open until the server has the change.
let editingRoute = null;

function openRouteDialog() {
  const route = data.routes.find(r => r.id === detailsId);
  if (!route) return;
  editingRoute = route.id;
  els.routeName.value = route.custom?.name || '';
  els.routeName.placeholder = route.name;
  els.routeIcon.value = route.custom?.icon || '';
  els.routeIcon.placeholder = route.icon ? 'The site’s own icon' : 'https://…';
  els.routeError.hidden = true;
  els.routeSubmit.disabled = false;
  els.routeDialog.showModal();
}

els.routeForm.addEventListener('submit', async event => {
  event.preventDefault();
  const id = editingRoute;
  els.routeSubmit.disabled = true;
  try {
    const body = await putJson(`api/routes/${encodeURIComponent(id)}`, { name: els.routeName.value, icon: els.routeIcon.value });
    const route = data.routes.find(r => r.id === id);
    if (route) route.custom = body.custom;
    els.routeDialog.close();
    render();
    load();
  } catch (err) {
    els.routeError.textContent = err.message;
    els.routeError.hidden = false;
    els.routeSubmit.disabled = false;
  }
});

$('details-edit').addEventListener('click', openRouteDialog);
$('route-cancel').addEventListener('click', () => els.routeDialog.close());
$('group-cancel').addEventListener('click', () => els.groupDialog.close());
els.detailsGroup.addEventListener('change', () => moveRoute(detailsId, els.detailsGroup.value || null));

// Drag and drop: a tile dropped on a custom group joins it (before the tile it lands on), and one dropped on
// an entry point group or the ungroup zone leaves its group. A custom group dragged by its heading and dropped
// on another custom group goes above or below it, depending on which half of it the pointer is over.
let dropHint = { section: null, tile: null, place: null };

function showDropHint(section, tile, place = null) {
  if (dropHint.section === section && dropHint.tile === tile && dropHint.place === place) return;
  dropHint.section?.removeAttribute('data-drop');
  dropHint.section?.removeAttribute('data-drop-place');
  dropHint.tile?.removeAttribute('data-drop-before');
  if (place) section?.setAttribute('data-drop-place', place);
  else section?.setAttribute('data-drop', '');
  tile?.setAttribute('data-drop-before', '');
  dropHint = { section, tile, place };
}

function startDrag(event, item) {
  dragId = item.dataset.route;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(DRAG_TYPE, dragId);
  // Style the source after the browser has captured it as the drag image.
  requestAnimationFrame(() => {
    item.dataset.dragging = '';
    els.ungroupZone.hidden = !groupOf(dragId);
  });
}

function startGroupDrag(event, section) {
  dragGroup = section.dataset.group;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(GROUP_DRAG_TYPE, dragGroup);
  requestAnimationFrame(() => {
    section.dataset.dragging = '';
  });
}

function endDrag() {
  if (!dragId && !dragGroup) return;
  dragId = null;
  dragGroup = null;
  showDropHint(null, null);
  els.ungroupZone.hidden = true;
  els.routes.querySelector('[data-dragging]')?.removeAttribute('data-dragging');
  if (renderPending) render();
}

function dropTarget(event) {
  if (!dragId) return null;
  if (els.ungroupZone.contains(event.target)) return { section: els.ungroupZone, group: null, tile: null };
  const section = event.target.closest('.group');
  if (!section) return null;
  const group = section.dataset.group ?? null;
  const tile = group != null ? event.target.closest('[data-route]') : null;
  return { section, group, tile };
}

// Where a dragged group would land: `before` is the group it would go in front of, or null for last. Dropping it
// next to where it already is changes nothing, so that gets no insertion bar.
function groupDropTarget(event) {
  if (!dragGroup) return null;
  const section = event.target.closest('.group[data-group]');
  const index = data.groups.findIndex(g => g.name === section?.dataset.group);
  if (index < 0) return null;
  const box = section.getBoundingClientRect();
  const place = event.clientY > box.top + box.height / 2 ? 'after' : 'before';
  const before = data.groups[place === 'after' ? index + 1 : index]?.name ?? null;
  const next = data.groups[data.groups.findIndex(g => g.name === dragGroup) + 1]?.name ?? null;
  const unchanged = before === dragGroup || before === next;
  return { section: unchanged ? null : section, place, before };
}

els.routes.addEventListener('dragover', event => {
  if (!dragGroup) return;
  const target = groupDropTarget(event);
  showDropHint(target?.section, null, target?.section && target.place);
  if (!target) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
});
els.routes.addEventListener('drop', event => {
  const target = groupDropTarget(event);
  if (!target) return;
  event.preventDefault();
  const name = dragGroup;
  endDrag();
  moveGroup(name, target.before);
});

for (const zone of [els.routes, els.ungroupZone]) {
  zone.addEventListener('dragover', event => {
    if (dragGroup) return;
    const target = dropTarget(event);
    // No insertion bar on the tile being dragged: dropping it there leaves it where it is.
    showDropHint(target?.section, target?.tile?.dataset.route === dragId ? null : target?.tile);
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });
  zone.addEventListener('dragleave', event => {
    if (!zone.contains(event.relatedTarget)) showDropHint(null, null);
  });
  zone.addEventListener('drop', event => {
    const target = dropTarget(event);
    if (!target) return;
    event.preventDefault();
    const id = dragId;
    endDrag();
    moveRoute(id, target.group, target.tile?.dataset.route);
  });
}

// Loads can overlap, say a poll and the reload after saving a route, so only the newest response is used.
let loadsStarted = 0;
let loadApplied = 0;

async function load() {
  const edits = groupEdits;
  const seq = ++loadsStarted;
  try {
    const res = await fetch('api/routes', { cache: 'no-store' });
    if (!res.ok) throw new Error(`The homepage server responded with HTTP ${res.status}`);
    const body = await res.json();
    if (seq < loadApplied) return;
    loadApplied = seq;
    // Keep this page's groups if it changed them while the request was out: the response may predate the change.
    const stale = saving || edits !== groupEdits;
    if (!stale) confirmedGroups = body.groups || [];
    data = { ...body, groups: stale ? data.groups : confirmedGroups };
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

// The server says when something on the page has changed, such as a new icon or health check, so it shows up
// straight away. The poll stays as a fallback for when the messages don't get through. A tab in the background
// stops listening, which also keeps it from holding one of the browser's few connections to the server, and
// catches up as soon as it's shown again.
let changes = null;

// Changes made while the stream is down aren't sent again, so the page fetches everything once it's back. The
// browser reconnects by itself after a network error, but gives up for good when the server answers with anything
// other than an event stream, such as Traefik's 502 or 404 while the homepage container restarts. Then a new
// stream is started a little later instead.
function listen(catchUp = false) {
  if (changes || document.hidden || !window.EventSource) return;
  const source = new EventSource('api/events');
  changes = source;
  source.addEventListener('message', load);
  if (catchUp) source.addEventListener('open', load, { once: true });
  source.addEventListener('error', () => {
    if (changes !== source) return;
    if (source.readyState === EventSource.CLOSED) {
      changes = null;
      setTimeout(() => listen(true), RECONNECT_MS);
    } else {
      source.addEventListener('open', load, { once: true });
    }
  });
}

els.filter.addEventListener('input', render);
load();
listen();
setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    changes?.close();
    changes = null;
  } else {
    listen();
    load();
  }
});
