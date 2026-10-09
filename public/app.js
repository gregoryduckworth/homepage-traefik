import { newestOnly, putJson } from './api.js';
import { watchChanges } from './changes.js';
import { createDetails } from './details.js';
import { createDragAndDrop } from './drag.js';
import { $, el, closeOnBackdrop, iconButton, plural, INFO_ICON, RENAME_ICON, DELETE_ICON, UP_ICON, DOWN_ICON } from './dom.js';
import { createGroups, groupOf, withGroupMoved, withGroupShifted, withRouteMoved } from './groups.js';
import { addressOf, byName, displayName, isHidden, sectionsFor, statusOf } from './routes.js';
import './theme-toggle.js';

const REFRESH_MS = 30000;
const REPO_URL = 'https://github.com/gregoryduckworth/homepage-traefik';

const els = {
  title: $('title'),
  summary: $('summary'),
  filter: $('filter'),
  notice: $('notice'),
  strip: $('strip'),
  routes: $('routes'),
  empty: $('empty'),
  newGroup: $('new-group'),
  groupDialog: $('group-dialog'),
  groupForm: $('group-form'),
  groupName: $('group-name'),
  groupError: $('group-error'),
  groupSubmit: $('group-submit'),
  ungroupZone: $('ungroup-zone'),
  hiddenToggle: $('hidden-toggle'),
  footer: $('footer'),
  version: $('version'),
};

closeOnBackdrop(els.groupDialog);

// Everything from the server but the groups, which `groups` keeps.
let data = { routes: [], error: null, configError: null, updatedAt: null };
const groups = createGroups({
  put: async list => (await putJson('api/groups', { groups: list })).groups,
  onChange: render,
  reload: load,
});
// Re-rendering mid-drag would detach the dragged element, so renders wait for the drop.
let renderPending = false;
// Hidden routes are left off the page, the strip and the summary until someone chooses to show them.
let showHidden = false;

// The routes the strip and the summary count: every route that isn't hidden.
function watchedRoutes() {
  return data.routes.filter(route => !isHidden(route));
}

// Icon addresses that didn't load. Every update rebuilds the tiles, so without this each one would request a broken
// icon again before falling back to the next. A changed icon has a new address, and a reload tries them all afresh.
const brokenIcons = new Set();

// An icon set on the page, else the one the server found on the site, else the name's first letter; an image that
// doesn't load falls through to the next. The status dot sits on its corner.
function renderIcon(route, dot) {
  const box = el('span', 'tile-icon');
  const letter = el('span', 'tile-letter', [...displayName(route)][0]?.toUpperCase() || '?');
  letter.setAttribute('aria-hidden', 'true');
  const sources = [route.custom?.icon, route.icon].filter(src => src && !brokenIcons.has(src));
  if (sources.length) {
    const img = el('img');
    img.alt = '';
    img.draggable = false;
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => {
      brokenIcons.add(sources.shift());
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
  if (isHidden(route)) tile.dataset.hidden = '';
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
  const name = el('span', 'tile-name', displayName(route));
  if (isHidden(route)) name.append(el('span', 'visually-hidden', ' (hidden)'));
  main.append(name, el('span', 'tile-sub', addressOf(route) || route.rule));

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
  info.addEventListener('click', () => details.open(route.id));

  tile.append(link, info);
  const item = el('li');
  item.dataset.route = route.id;
  item.draggable = true;
  item.addEventListener('dragstart', event => drag.startDrag(event, item));
  item.addEventListener('dragend', drag.endDrag);
  item.append(tile);
  return item;
}

function renderStrip() {
  const segments = watchedRoutes().sort(byName).map(route => {
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
  const watched = watchedRoutes();
  const count = watched.length;
  const hidden = data.routes.length - count;
  const kinds = watched.map(route => statusOf(route).kind);
  const up = kinds.filter(kind => kind === 'up').length;
  const problems = kinds.filter(kind => kind === 'down' || kind === 'warn').length;
  const parts = [`${up} of ${plural(count, 'route')} up`];
  if (problems) parts.push(`${plural(problems, 'needs', 'need')} attention`);
  if (hidden) parts.push(`${hidden} hidden`);
  return parts.join(', ');
}

// Custom groups get buttons to move, rename and delete them, and can be dragged by their heading; entry point
// groups are where ungrouped routes land. A section is as sectionsFor lists it.
function renderSection({ title, routes, group, hidden: hiddenCount }) {
  const section = el('section', 'group');
  const head = el('div', 'group-head');
  const heading = el('h2', null, `${title} `);
  heading.append(el('span', null, `(${routes.length})`));
  head.append(heading);
  section.append(head);

  if (group) {
    section.dataset.group = group.name;
    head.draggable = true;
    head.addEventListener('dragstart', event => drag.startGroupDrag(event, section));
    head.addEventListener('dragend', drag.endDrag);
    if (groups.list.length > 1) {
      const index = groups.list.indexOf(group);
      const up = iconButton(UP_ICON, `Move ${group.name} up`, () => shiftGroup(group.name, -1));
      const down = iconButton(DOWN_ICON, `Move ${group.name} down`, () => shiftGroup(group.name, 1));
      up.dataset.move = down.dataset.move = '';
      up.disabled = index === 0;
      down.disabled = index === groups.list.length - 1;
      head.append(up, down);
    }
    head.append(
      iconButton(RENAME_ICON, `Rename ${group.name}`, () => openGroupDialog(group.name)),
      iconButton(DELETE_ICON, `Delete ${group.name}`, () => deleteGroup(group.name)),
    );
  }
  if (group && !routes.length) {
    section.append(el('p', 'group-empty', hiddenCount
      ? `Every route in this group is hidden. Select “Show ${plural(hiddenCount, 'hidden route')}” to see ${hiddenCount === 1 ? 'it' : 'them'}.`
      : 'Drag routes here, or choose this group in a route’s details.'));
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
  if (groups.error) notices.push(['Your group change wasn’t saved', groups.error]);
  if (details.hideError) notices.push(['The route wasn’t hidden or shown', details.hideError]);
  els.notice.replaceChildren(...notices.map(([heading, text]) => {
    const item = el('p');
    item.append(el('strong', null, heading), text);
    return item;
  }));
  els.notice.hidden = !notices.length;
}

function render() {
  if (drag.isDragging()) {
    renderPending = true;
    return;
  }
  renderPending = false;
  const query = els.filter.value.trim().toLowerCase();
  const hiddenCount = data.routes.filter(isHidden).length;
  // Once nothing is hidden, the next route hidden should leave the page rather than stay on it dimmed.
  if (!hiddenCount) showHidden = false;
  const { shown: visible, sections } = sectionsFor(data.routes, groups.list, { query, showHidden });

  // Rebuilding the list drops focus, so put it back on the button with the same label.
  const focused = els.routes.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
  els.routes.replaceChildren(...sections.map(renderSection));
  if (focused) [...els.routes.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === focused)?.focus();

  renderNotice();

  renderStrip();
  details.refresh();

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

  els.hiddenToggle.hidden = !hiddenCount;
  els.hiddenToggle.textContent = showHidden
    ? 'Stop showing hidden routes'
    : `Show ${plural(hiddenCount, 'hidden route')}`;

  els.empty.hidden = true;
  if (data.updatedAt && !count) {
    els.empty.textContent = 'Traefik has no routes yet. Add a router with a Host rule, for example a traefik.http.routers.<name>.rule label on a container, and it will show up here.';
    els.empty.hidden = false;
  } else if (count && !visible.length && !query) {
    els.empty.textContent = 'Every route is hidden. Select “Show hidden routes” below to see them.';
    els.empty.hidden = false;
  } else if (count && !visible.length) {
    els.empty.textContent = `Nothing matches “${els.filter.value.trim()}”. Clear the search to see every route.`;
    els.empty.hidden = false;
  }
}

function moveRoute(id, target, beforeId) {
  if (id === beforeId) return;
  groups.save(withRouteMoved(groups.list, id, target, beforeId));
}

function moveGroup(name, beforeName) {
  groups.save(withGroupMoved(groups.list, name, beforeName));
}

// Moves a group one place up or down. Rendering keeps focus on the pressed button, unless the group reached the
// top or bottom and the button is now disabled; then focus goes to the group's other arrow.
function shiftGroup(name, step) {
  groups.save(withGroupShifted(groups.list, name, step));
  if (els.routes.contains(document.activeElement)) return;
  const section = [...els.routes.querySelectorAll('.group[data-group]')].find(s => s.dataset.group === name);
  section?.querySelector('[data-move]:enabled')?.focus();
}

function deleteGroup(name) {
  const group = groups.list.find(g => g.name === name);
  if (group.routes.length && !confirm(`Delete the “${name}” group? Its routes go back to their entry point groups.`)) return;
  groups.save(groups.list.filter(g => g !== group));
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
  const taken = groups.list.find(group => group.name.toLowerCase() === name.toLowerCase() && group.name !== renamingGroup);
  if (!name || taken) {
    event.preventDefault();
    els.groupError.textContent = taken ? `There’s already a group called “${taken.name}”.` : 'Enter a name for the group.';
    els.groupError.hidden = false;
    return;
  }
  groups.save(renamingGroup
    ? groups.list.map(group => (group.name === renamingGroup ? { ...group, name } : group))
    : [...groups.list, { name, routes: [] }]);
});

els.newGroup.addEventListener('click', () => openGroupDialog());

els.hiddenToggle.addEventListener('click', () => {
  showHidden = !showHidden;
  render();
});
$('group-cancel').addEventListener('click', () => els.groupDialog.close());
const details = createDetails({
  routeOf: id => data.routes.find(route => route.id === id),
  groups: () => groups.list,
  moveRoute,
  showingHidden: () => showHidden,
  render,
  load,
});

const drag = createDragAndDrop({
  routes: els.routes,
  ungroupZone: els.ungroupZone,
  groups: () => groups.list,
  groupOf: id => groupOf(groups.list, id),
  moveRoute,
  moveGroup,
  onEnd: () => { if (renderPending) render(); },
});

// Loads can overlap, say a poll and the reload after saving a route, so only the newest to finish is used, whether
// it worked or not.
const fetchRoutes = newestOnly(async () => {
  const res = await fetch('api/routes', { cache: 'no-store' });
  if (!res.ok) throw new Error(`The homepage server responded with HTTP ${res.status}`);
  return res.json();
});

async function load() {
  const applyGroups = groups.startLoad();
  const outcome = await fetchRoutes();
  if (!outcome) return;
  if (outcome.error) {
    data = { ...data, error: `Can't reach the homepage server. ${outcome.error.message}` };
  } else {
    const { groups: loaded, ...rest } = outcome.value;
    applyGroups(loaded || []);
    data = rest;
  }
  if (data.title) {
    els.title.textContent = data.title;
    document.title = data.title;
  }
  if (data.version) showVersion(data.version);
  render();
}

// The image's version, as tagged on Docker. A release links to its notes; a build of main, to the repository.
function showVersion(version) {
  const release = /^\d+\.\d+\.\d+$/.test(version);
  els.version.textContent = version;
  els.version.href = release ? `${REPO_URL}/releases/tag/v${version}` : REPO_URL;
  els.footer.hidden = false;
}

els.filter.addEventListener('input', render);

// "/" jumps to the search box, as on many sites, unless someone is typing somewhere or a dialog is open.
document.addEventListener('keydown', event => {
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented) return;
  const target = event.target;
  if (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
  if (document.querySelector('dialog[open]')) return;
  event.preventDefault();
  els.filter.focus();
  els.filter.select();
});
load();
watchChanges(load);
setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
