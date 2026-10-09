const { fetchRouters, normalizeRouters } = require('./traefik');
const { checkAllRoutes, isCheckable } = require('./healthcheck');

// Ticks start a little later each time, by however long the Traefik request took, so a route checked one interval
// ago can look a moment too young. Without some slack it would wait a whole extra tick.
const DUE_SLACK_MS = 2000;

// The routes Traefik serves and the latest health check of each, refreshed by the server's poll. `checkRoutes` and
// `now` are only replaced in tests.
function createRouteStore({
  traefikUrl,
  fetchImpl,
  entryPointPorts = new Map(),
  checkRoutes = checkAllRoutes,
  healthOptions = {},
  healthIntervalMs = 0,
  now = Date.now,
}) {
  const state = { routes: [], updatedAt: null, error: null };
  // Keyed by route id. Each result records the URL it checked, so a route whose URL changes is checked again. They're
  // only kept in memory: after a restart every route is checked straight away.
  let healthResults = new Map();

  // Resolves to whether the routes or the error changed.
  async function refresh() {
    const before = JSON.stringify([state.routes, state.error]);
    try {
      const [httpRouters, tcpRouters] = await Promise.all([
        fetchRouters(traefikUrl, { fetchImpl }),
        fetchRouters(traefikUrl, { fetchImpl, protocol: 'tcp' }),
      ]);
      state.routes = normalizeRouters(httpRouters, { ports: entryPointPorts, tcpRouters });
      state.updatedAt = new Date().toISOString();
      state.error = null;
    } catch (err) {
      if (err.name === 'TimeoutError') {
        state.error = `The Traefik API at ${traefikUrl} didn't respond in time`;
      } else if (err.cause) {
        state.error = `Can't reach the Traefik API at ${traefikUrl} (${err.cause.code || err.cause.message}). Check TRAEFIK_API_URL and that the API is enabled.`;
      } else {
        state.error = err.message;
      }
      console.error(`Route refresh failed: ${state.error}`);
    }
    return JSON.stringify([state.routes, state.error]) !== before;
  }

  // A check that started earlier, such as the poll's while someone asked for one on the page, can finish later, so
  // it only replaces a result for the same URL if it isn't older.
  function setResult(route, result) {
    const last = healthResults.get(route.id);
    if (last?.url === route.url && Date.parse(last.checkedAt) > Date.parse(result.checkedAt)) return;
    healthResults.set(route.id, { ...result, url: route.url });
  }

  function isDue(route) {
    const last = healthResults.get(route.id);
    if (!last || last.url !== route.url) return true;
    return now() - Date.parse(last.checkedAt) >= healthIntervalMs - DUE_SLACK_MS;
  }

  // Only routes that are new, have a new URL or were last checked an interval ago are checked, so each route gets
  // at most one check per interval however often Traefik is polled. Returns whether any route was checked.
  async function refreshHealth() {
    // Until Traefik has answered once there's nothing to check.
    if (!state.updatedAt) return false;
    const checkable = state.routes.filter(isCheckable);
    const due = checkable.filter(isDue);
    if (due.length) {
      const fresh = await checkRoutes(due, healthOptions);
      for (const route of due) {
        const result = fresh.get(route.id);
        if (result) setResult(route, result);
      }
    }
    // Forget routes Traefik no longer serves, so the results don't grow forever.
    const kept = new Map(checkable.filter(route => healthResults.has(route.id)).map(route => [route.id, healthResults.get(route.id)]));
    const pruned = kept.size !== healthResults.size;
    healthResults = kept;
    return due.length > 0 || pruned;
  }

  // Checks one route now, whether or not it's due, as when someone asks for it on the page. Resolves to the route
  // with its new health, or null when there's no such route or it has nothing to check.
  async function checkRoute(id) {
    const route = state.routes.find(r => r.id === id);
    if (!route || !isCheckable(route)) return null;
    const result = (await checkRoutes([route], healthOptions)).get(id);
    if (result) setResult(route, result);
    return withHealth(route);
  }

  // The route with its latest health check, or null health when it hasn't been checked.
  function withHealth(route) {
    return { ...route, health: healthResults.get(route.id) || null };
  }

  function getRoutesWithHealth() {
    return state.routes.map(withHealth);
  }

  return { state, refresh, refreshHealth, checkRoute, getRoutesWithHealth };
}

module.exports = { createRouteStore };
