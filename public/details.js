// A route's details panel, which shows how the route has done over the last day, and from which it can be checked,
// moved to a group or up and down within one, hidden or shown, and given its own name and icon in a dialog of its own.
import { getJson, post, putJson } from './api.js';
import { $, el, closeOnBackdrop } from './dom.js';
import { groupOf } from './groups.js';
import { bucketKind, bucketLabel, historyText, stripLabel } from './history.js';
import { addressOf, detailRows, displayName, isHidden, statusOf } from './routes.js';

// `routeOf` finds a route the page lists by id, and `groups` returns the custom groups. `moveRoute` puts a route in
// a group, or in none. `placeOf` returns the custom group a route is in and the ids of the routes the page lists in
// it, in order, as { group, listed }, or null for a route in no group. `shiftRoute` moves a route one place up (-1)
// or down (1) in its group. `showingHidden` says whether hidden routes are on the page, and `canEdit` whether the
// homepage can be changed; when it can't, the panel only shows the route and lets it be checked. `render` shows a
// change made here straight away, and `load` fetches everything afresh once the server has it.
export function createDetails({ routeOf, groups, moveRoute, placeOf, shiftRoute, showingHidden, canEdit, render, load }) {
  const els = {
    details: $('details'),
    group: $('details-group'),
    order: $('details-order'),
    up: $('details-up'),
    down: $('details-down'),
    moved: $('details-moved'),
    check: $('details-check'),
    checkError: $('details-check-error'),
    edit: $('details-edit'),
    hide: $('details-hide'),
    routeDialog: $('route-dialog'),
    routeForm: $('route-form'),
    routeName: $('route-name'),
    routeIcon: $('route-icon'),
    routeError: $('route-error'),
    routeSubmit: $('route-submit'),
    history: $('details-history'),
    uptime: $('details-uptime'),
    historyDetail: $('details-history-detail'),
    historyStrip: $('details-history-strip'),
    historyAxis: $('details-history-axis'),
  };
  closeOnBackdrop(els.details);
  closeOnBackdrop(els.routeDialog);

  // The route the panel shows.
  let detailsId = null;
  // Routes being checked on request, and why the last such check failed, if it did, as { id, message }.
  const checking = new Set();
  let checkError = null;
  let hideError = null;
  // The route and check the history shown is up to date with, as { id, checkedAt }.
  let historyOf = null;

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
    els.group.parentElement.hidden = !canEdit() || !groups().length;

    // Routes in no group are listed by name, so only those in a group, with others beside them, can be moved.
    const place = placeOf(route.id);
    const index = place ? place.listed.indexOf(route.id) : -1;
    els.order.hidden = !canEdit() || index < 0 || place.listed.length < 2;
    els.up.disabled = index <= 0;
    els.down.disabled = index < 0 || index === place.listed.length - 1;

    els.hide.textContent = isHidden(route) ? 'Show route' : 'Hide route';
    els.edit.hidden = els.hide.hidden = !canEdit();

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

    showHistory(route);

    const open = $('details-open');
    open.hidden = !route.url;
    if (route.url) {
      open.href = route.url;
      open.textContent = `Open ${addressOf(route)}`;
    }
  }

  function drawHistory(summary) {
    const { headline, detail } = historyText(summary);
    els.uptime.textContent = headline;
    els.historyDetail.textContent = detail;
    els.historyStrip.replaceChildren(...summary.buckets.map(bucket => {
      const segment = el('span');
      segment.dataset.kind = bucketKind(bucket);
      segment.title = bucketLabel(bucket, summary.bucketMinutes);
      return segment;
    }));
    els.historyStrip.setAttribute('aria-label', stripLabel(summary));
    els.historyStrip.hidden = els.historyAxis.hidden = false;
  }

  // Fetches the route's history when the panel opens and again after each new check, so it never shows another
  // route's, and an answer that arrives after the panel moved on is dropped. Routes the server never checks have none.
  async function showHistory(route) {
    const checkable = Boolean(route.url) && route.protocol !== 'tcp';
    if (historyOf?.id !== route.id) {
      els.history.hidden = true;
      els.historyStrip.replaceChildren();
    }
    if (!checkable) {
      els.history.hidden = true;
      historyOf = null;
      return;
    }
    const checkedAt = route.health?.checkedAt ?? null;
    if (historyOf?.id === route.id && historyOf.checkedAt === checkedAt) return;
    const asked = historyOf = { id: route.id, checkedAt };
    try {
      const summary = await getJson(`api/history/${encodeURIComponent(route.id)}`);
      if (historyOf !== asked) return;
      drawHistory(summary);
    } catch (err) {
      if (historyOf !== asked) return;
      els.uptime.textContent = 'Couldn’t load how this route has done over the last day';
      els.historyDetail.textContent = err.message;
      els.historyStrip.hidden = els.historyAxis.hidden = true;
      // Tried again the next time the panel updates.
      historyOf = { id: route.id, checkedAt: undefined };
    }
    els.history.hidden = false;
  }

  function open(id) {
    const route = routeOf(id);
    if (!route) return;
    detailsId = id;
    historyOf = null;
    if (checkError?.id !== id) checkError = null;
    els.moved.textContent = '';
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

  // The page, and so this panel, updates as soon as the route moves. Focus stays on the button pressed, unless the
  // route reached the top or bottom and the button is now disabled; then it goes to the other one.
  function shift(step) {
    const id = detailsId;
    shiftRoute(id, step);
    const place = placeOf(id);
    const index = place ? place.listed.indexOf(id) : -1;
    if (index >= 0) els.moved.textContent = `Moved to ${index + 1} of ${place.listed.length} in ${place.group}`;
    const [pressed, other] = step < 0 ? [els.up, els.down] : [els.down, els.up];
    if (pressed.disabled) other.focus();
  }

  els.up.addEventListener('click', () => shift(-1));
  els.down.addEventListener('click', () => shift(1));

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

  els.edit.addEventListener('click', () => {
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
