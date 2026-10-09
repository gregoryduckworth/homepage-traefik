// A route's details panel, from which it can be checked, moved to a group, hidden or shown, and given its own name
// and icon in a dialog of its own.
import { post, putJson } from './api.js';
import { $, el, closeOnBackdrop } from './dom.js';
import { groupOf } from './groups.js';
import { addressOf, detailRows, displayName, isHidden, statusOf } from './routes.js';

// `routeOf` finds a route the page lists by id, and `groups` returns the custom groups. `moveRoute` puts a route in
// a group, or in none. `showingHidden` says whether hidden routes are on the page. `render` shows a change made here
// straight away, and `load` fetches everything afresh once the server has it.
export function createDetails({ routeOf, groups, moveRoute, showingHidden, render, load }) {
  const els = {
    details: $('details'),
    group: $('details-group'),
    check: $('details-check'),
    checkError: $('details-check-error'),
    hide: $('details-hide'),
    routeDialog: $('route-dialog'),
    routeForm: $('route-form'),
    routeName: $('route-name'),
    routeIcon: $('route-icon'),
    routeError: $('route-error'),
    routeSubmit: $('route-submit'),
  };
  closeOnBackdrop(els.details);
  closeOnBackdrop(els.routeDialog);

  // The route the panel shows.
  let detailsId = null;
  // Routes being checked on request, and why the last such check failed, if it did, as { id, message }.
  const checking = new Set();
  let checkError = null;
  let hideError = null;

  function fill(route) {
    const status = statusOf(route);
    const dot = $('details-dot');
    dot.parentElement.dataset.kind = status.kind;
    dot.toggleAttribute('data-checking', status.kind === 'checking' || checking.has(route.id));
    $('details-title').textContent = displayName(route);

    const errors = $('details-errors');
    errors.replaceChildren(...route.errors.map(message => el('p', null, message)));
    errors.hidden = !route.errors.length;

    $('details-list').replaceChildren(...detailRows(route).flatMap(([term, value, format]) => {
      const dd = el('dd');
      dd.append(format === 'code' ? el('code', null, value) : String(value));
      return [el('dt', null, term), dd];
    }));

    const current = groupOf(groups(), route.id);
    els.group.replaceChildren(new Option('None', ''), ...groups().map(group => new Option(group.name, group.name)));
    els.group.value = current ? current.name : '';
    els.group.parentElement.hidden = !groups().length;

    els.hide.textContent = isHidden(route) ? 'Show route' : 'Hide route';

    // Only routes the server checks can be checked now: disabled routes and those with no web address never are.
    // While a check runs the button stays focusable, so a keyboard user isn't thrown out of the dialog, but does
    // nothing.
    const busy = checking.has(route.id);
    els.check.hidden = !route.url || route.status === 'disabled';
    els.check.textContent = busy ? 'Checking…' : 'Check now';
    els.check.setAttribute('aria-disabled', String(busy));
    const error = checkError?.id === route.id ? checkError.message : null;
    els.checkError.textContent = error;
    els.checkError.hidden = !error;

    const open = $('details-open');
    open.hidden = !route.url;
    if (route.url) {
      open.href = route.url;
      open.textContent = `Open ${addressOf(route)}`;
    }
  }

  function open(id) {
    const route = routeOf(id);
    if (!route) return;
    detailsId = id;
    if (checkError?.id !== id) checkError = null;
    fill(route);
    els.details.showModal();
  }

  // Shows the route's latest details while the panel is open, and closes it once the route is gone.
  function refresh() {
    if (!els.details.open) return;
    const route = routeOf(detailsId);
    if (route) fill(route);
    else els.details.close();
  }

  // Saves the route's name, icon or whether it's hidden, and puts what the server saved on the route.
  async function saveRoute(id, setting) {
    const body = await putJson(`api/routes/${encodeURIComponent(id)}`, setting);
    const route = routeOf(id);
    if (route) route.custom = body.custom;
  }

  els.group.addEventListener('change', () => moveRoute(detailsId, els.group.value || null));

  // Checks the route and looks up its icon straight away, rather than when they're next due. The server answers
  // once both are done, and the page then shows what they found.
  els.check.addEventListener('click', async () => {
    const id = detailsId;
    if (checking.has(id)) return;
    checking.add(id);
    checkError = null;
    refresh();
    try {
      await post(`api/check/${encodeURIComponent(id)}`);
    } catch (err) {
      checkError = { id, message: `The route wasn’t checked. ${err.message}` };
    } finally {
      checking.delete(id);
    }
    await load();
  });

  // Only "hidden" is sent, so the route keeps its name and icon. A route that's hidden while hidden routes aren't
  // shown leaves the page, so its details close too.
  els.hide.addEventListener('click', async () => {
    const id = detailsId;
    const route = routeOf(id);
    if (!route) return;
    const hidden = !isHidden(route);
    els.hide.disabled = true;
    try {
      await saveRoute(id, { hidden });
      hideError = null;
      if (hidden && !showingHidden()) els.details.close();
    } catch (err) {
      hideError = err.message;
    } finally {
      els.hide.disabled = false;
    }
    render();
    load();
  });

  // Names and icons are saved one route at a time, and the dialog stays open until the server has the change.
  let editingRoute = null;

  $('details-edit').addEventListener('click', () => {
    const route = routeOf(detailsId);
    if (!route) return;
    editingRoute = route.id;
    els.routeName.value = route.custom?.name || '';
    els.routeName.placeholder = route.name;
    els.routeIcon.value = route.custom?.icon || '';
    els.routeIcon.placeholder = route.icon ? 'The site’s own icon' : 'https://…';
    els.routeError.hidden = true;
    els.routeSubmit.disabled = false;
    els.routeDialog.showModal();
  });

  els.routeForm.addEventListener('submit', async event => {
    event.preventDefault();
    els.routeSubmit.disabled = true;
    try {
      await saveRoute(editingRoute, { name: els.routeName.value, icon: els.routeIcon.value });
      els.routeDialog.close();
      render();
      load();
    } catch (err) {
      els.routeError.textContent = err.message;
      els.routeError.hidden = false;
      els.routeSubmit.disabled = false;
    }
  });

  $('route-cancel').addEventListener('click', () => els.routeDialog.close());

  return {
    open,
    refresh,
    // Why the route last hidden or shown wasn't, or null.
    get hideError() { return hideError; },
  };
}
