// The server's background work: reading the routes from Traefik, checking them and looking up their icons, every
// poll and whenever someone asks for one route on the page. `saveIcons` writes the icons out after one changes.
function createPoller({ store, icons, events, saveIcons }) {
  const refreshIcons = () => icons.refresh(store.getRoutesWithHealth()).then(changed => changed && saveIcons(), err => {
    console.error(`Looking up route icons failed: ${err.message}`);
  });

  // Skip a tick if the previous cycle is still running, so a slow probe can't overwrite newer results. Icons are
  // looked up in the background, so a slow site can't hold up the next poll. Until Traefik has answered once
  // there are no routes, and refreshing the icons would forget the saved ones.
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const routesChanged = await store.refresh();
      const healthChanged = await store.refreshHealth();
      if (routesChanged || healthChanged) events.notify();
      if (store.state.updatedAt) refreshIcons();
    } catch (err) {
      // Logged rather than thrown: an unhandled rejection would stop the server, and the next tick may well work.
      console.error(`Polling failed: ${err.message}`);
    } finally {
      polling = false;
    }
  }

  // A check asked for on the page runs straight away, beside the poll's. The page waits for the icon too, so it
  // knows when everything it asked for is done. Resolves to the route with its new health, or null when there's
  // nothing to check.
  async function check(id) {
    const route = await store.checkRoute(id);
    if (!route) return null;
    events.notify();
    if (await icons.recheck(route).catch(err => console.error(`Looking up the icon for ${id} failed: ${err.message}`))) saveIcons();
    return route;
  }

  return { poll, check };
}

module.exports = { createPoller };
