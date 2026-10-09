// The custom groups, and how a change to them is saved. The changes themselves work on a list of groups and return a
// new one, leaving the list they were given alone.

// The group a route is in, if any.
export function groupOf(groups, id) {
  return groups.find(group => group.routes.includes(id));
}

// Takes the route out of its group and puts it in `target`, in front of `beforeId` or last. With no `target`, it's
// left out of every group.
export function withRouteMoved(groups, id, target, beforeId = null) {
  const moved = groups.map(group => ({ ...group, routes: group.routes.filter(routeId => routeId !== id) }));
  const group = moved.find(g => g.name === target);
  if (group) {
    const index = beforeId ? group.routes.indexOf(beforeId) : -1;
    group.routes.splice(index < 0 ? group.routes.length : index, 0, id);
  }
  return moved;
}

// Puts a group in front of another one, or last when there's no other one.
export function withGroupMoved(groups, name, beforeName) {
  const group = groups.find(g => g.name === name);
  if (!group || name === beforeName) return groups;
  const moved = groups.filter(g => g !== group);
  const index = beforeName ? moved.findIndex(g => g.name === beforeName) : -1;
  moved.splice(index < 0 ? moved.length : index, 0, group);
  return moved;
}

// Moves a group one place up (a `step` of -1) or down (1). A group already at the top or bottom stays put.
export function withGroupShifted(groups, name, step) {
  const index = groups.findIndex(g => g.name === name);
  const target = index + step;
  if (index < 0 || target < 0 || target >= groups.length) return groups;
  return withGroupMoved(groups, name, groups[step < 0 ? target : target + 1]?.name ?? null);
}

// Saving is optimistic: `groups` changes at once and `onChange` is told, so the page shows the change straight
// away. `put` sends the groups to the server and resolves to the groups it saved. If the server refuses a change, the
// groups go back to those it last confirmed and `reload` fetches them afresh, which stays correct even when several
// saves were in flight.
export function createGroups({ put, onChange, reload }) {
  let groups = [];
  // The groups the server last reported, which the page falls back to when a save fails.
  let confirmed = [];
  let saving = 0;
  // Bumped on every change, so a load that started before it can't undo it.
  let edits = 0;
  let error = null;

  async function save(next) {
    if (JSON.stringify(next) === JSON.stringify(groups)) return;
    groups = next;
    error = null;
    saving++;
    edits++;
    onChange();
    let failed = false;
    try {
      const saved = await put(next);
      confirmed = saved;
      // A later save still in flight holds newer groups than this response. Once none is, the server has every
      // change made on the page, including any whose own save failed, so an earlier error no longer applies.
      if (saving === 1) {
        groups = saved;
        error = null;
      }
    } catch (err) {
      failed = true;
      error = err.message;
    } finally {
      saving--;
    }
    // A save still in flight settles the groups itself when it finishes.
    if (failed && !saving) {
      groups = confirmed;
      await reload();
    } else {
      onChange();
    }
  }

  // Call as a load of the groups from the server starts. It returns a function to call with the groups it loaded,
  // which keeps the page's own groups instead if they changed while the request was out: the response may predate
  // the change.
  function startLoad() {
    const editsBefore = edits;
    return loaded => {
      if (saving || edits !== editsBefore) return;
      confirmed = loaded;
      groups = loaded;
    };
  }

  return {
    get list() { return groups; },
    // Why the last change wasn't saved, or null.
    get error() { return error; },
    save,
    startLoad,
  };
}
