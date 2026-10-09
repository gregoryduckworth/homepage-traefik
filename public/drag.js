// Drag and drop: a tile dropped on a custom group joins it (before the tile it lands on), and one dropped on
// an entry point group or the ungroup zone leaves its group. A custom group dragged by its heading and dropped
// on another custom group goes above or below it, depending on which half of it the pointer is over.

const DRAG_TYPE = 'application/x-homepage-route';
const GROUP_DRAG_TYPE = 'application/x-homepage-group';

// `routes` holds the group sections, and `ungroupZone` is shown while a route in a group is dragged. `groups`
// returns the custom groups in page order and `groupOf` the group a route is in. `moveRoute` and `moveGroup` make
// the change a drop asks for, and `onEnd` is called when a drag finishes.
export function createDragAndDrop({ routes, ungroupZone, groups, groupOf, moveRoute, moveGroup, onEnd }) {
  // The id of the route or the name of the group being dragged.
  let dragId = null;
  let dragGroup = null;
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
      ungroupZone.hidden = !groupOf(dragId);
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
    ungroupZone.hidden = true;
    routes.querySelector('[data-dragging]')?.removeAttribute('data-dragging');
    onEnd();
  }

  function dropTarget(event) {
    if (!dragId) return null;
    if (ungroupZone.contains(event.target)) return { section: ungroupZone, group: null, tile: null };
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
    const list = groups();
    const section = event.target.closest('.group[data-group]');
    const index = list.findIndex(g => g.name === section?.dataset.group);
    if (index < 0) return null;
    const box = section.getBoundingClientRect();
    const place = event.clientY > box.top + box.height / 2 ? 'after' : 'before';
    const before = list[place === 'after' ? index + 1 : index]?.name ?? null;
    const next = list[list.findIndex(g => g.name === dragGroup) + 1]?.name ?? null;
    const unchanged = before === dragGroup || before === next;
    return { section: unchanged ? null : section, place, before };
  }

  routes.addEventListener('dragover', event => {
    if (!dragGroup) return;
    const target = groupDropTarget(event);
    showDropHint(target?.section, null, target?.section && target.place);
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  });
  routes.addEventListener('drop', event => {
    const target = groupDropTarget(event);
    if (!target) return;
    event.preventDefault();
    const name = dragGroup;
    endDrag();
    moveGroup(name, target.before);
  });

  for (const zone of [routes, ungroupZone]) {
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

  return { isDragging: () => Boolean(dragId || dragGroup), startDrag, startGroupDrag, endDrag };
}
