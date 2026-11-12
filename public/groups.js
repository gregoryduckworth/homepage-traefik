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

// Moves a route one place up (a `step` of -1) or down (1) among `listed`, the routes in its group that the page lists,
// in order. Routes the page leaves out, such as hidden ones, keep their places. A route already at the top or bottom,
// or in no group, stays put.
export function withRouteShifted(groups, id, step, listed) {
  const group = groupOf(groups, id);
  const index = listed.indexOf(id);
  const neighbour = listed[index + step];
  if (!group || index < 0 || !neighbour) return groups;
  // Up goes in front of the neighbour; down, in front of whatever follows the neighbour in the group, or last.
  const others = group.routes.filter(routeId => routeId !== id);
  const beforeId = step < 0 ? neighbour : others[others.indexOf(neighbour) + 1] ?? null;
  return withRouteMoved(groups, id, group.name, beforeId);
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
// away. `put(groups, version)` sends the groups to the server along with the version of the groups they were made
// to, and resolves to { groups, version } as it saved them. The server refuses a change made to groups that have
// since changed elsewhere, rather than undo that change. If it refuses a change for that or any other reason, the
// groups go back to those it last confirmed and `reload` fetches them afresh.
export function createGroups({ put, onChange, reload }) {
  let groups = [];
  // The groups the server last reported, which the page falls back to when a save fails, and their version.
  let confirmed = [];
  let version = null;
  // The save under way, if any, and whether the page has changed the groups since it was sent.
  let sending = null;
  let unsent = false;
  // Bumped on every change, so a load that started before it can't undo it.
  let edits = 0;
  let error = null;

  // Sends the page's groups, and then any change made while that was out, until the server has them all. Saves go
  // one at a time because each carries the version of the groups it was made to, which only the previous one's reply
  // says. Resolves to whether every change was saved; once one is refused, the changes made on top of it are dropped.
  async function send() {
    try {
      while (unsent) {
        unsent = false;
        const saved = await put(groups, version);
        confirmed = saved.groups;
        version = saved.version;
        // A change made while this save was out stays on the page until it's sent too.
        if (!unsent) groups = saved.groups;
      }
      return true;
    } catch (err) {
      unsent = false;
      error = err.message;
      groups = confirmed;
      return false;
    }
  }

  async function save(next) {
    if (JSON.stringify(next) === JSON.stringify(groups)) return;
    groups = next;
    error = null;
    edits++;
    unsent = true;
    onChange();
    sending ??= send().then(async saved => {
      sending = null;
      if (saved) onChange();
      else await reload();
    });
    await sending;
  }

  // Call as a load of the groups from the server starts. It returns a function to call with the groups it loaded and
  // their version, which keeps the page's own groups instead if they changed while the request was out: the response
  // may predate the change.
  function startLoad() {
    const editsBefore = edits;
    return (loaded, loadedVersion = null) => {
      if (sending || edits !== editsBefore) return;
      confirmed = loaded;
      version = loadedVersion;
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
