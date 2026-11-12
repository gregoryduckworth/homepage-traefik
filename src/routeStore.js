const { fetchRouters, normalizeRouters, splitApiUrl } = require('./traefik');
const { checkAllRoutes, checkTarget, isCurrent } = require('./healthcheck');

// Ticks start a little later each time, by however long the Traefik request took, so a route checked one interval
// ago can look a moment too young. Without some slack it would wait a whole extra tick.
const DUE_SLACK_MS = 2000;

// The routes Traefik serves and the latest health check of each, refreshed by the server's poll. `auth` is the
// username and password for the Traefik API, if it needs them; they can also be in `traefikUrl`, but are taken out of
// it either way, so no error shows them. `history`, when given, is told every check, as createHistory's is.
// `routeSettings` resolves to each route's settings from the config file, by id, whose `health` says how it's checked.
// `checkRoutes` and `now` are only replaced in tests.
function createRouteStore({
  traefikUrl: rawTraefikUrl,
  auth: givenAuth = null,
  fetchImpl,
  entryPointPorts = new Map(),
  checkRoutes = checkAllRoutes,
  healthOptions = {},
  healthIntervalMs = 0,
  history = null,
  routeSettings = async () => ({}),
  now = Date.now,
}) {
  const { url: traefikUrl, auth: urlAuth } = splitApiUrl(rawTraefikUrl);
  const auth = givenAuth || urlAuth;
  const state = { routes: [], updatedAt: null, error: null };
  // Keyed by route id. Each result records the URL it checked and the status codes that counted as up, so a route
  // whose URL or health settings change is checked again. They're only kept in memory: after a restart every route
  // is checked straight away.
  let healthResults = new Map();

  // Resolves to whether the routes or the error changed. A failure is logged when it starts and when its message
  // changes, not on every poll while Traefik stays down, and one line says when routes can be read again.
  async function refresh() {
    const lastError = state.error;
    const before = JSON.stringify([state.routes, lastError]);
    try {
      const [httpRouters, tcpRouters] = await Promise.all([
        fetchRouters(traefikUrl, { fetchImpl, auth }),
        fetchRouters(traefikUrl, { fetchImpl, auth, protocol: 'tcp' }),
      ]);
      state.routes = normalizeRouters(httpRouters, { ports: entryPointPorts, tcpRouters });
      state.updatedAt = new Date().toISOString();
      state.error = null;
      if (lastError) console.log(`Reading routes from ${traefikUrl} again`);
    } catch (err) {
      if (err.name === 'TimeoutError') {
        state.error = `The Traefik API at ${traefikUrl} didn't respond in time`;
      } else if (err.cause) {
        state.error = `Can't reach the Traefik API at ${traefikUrl} (${err.cause.code || err.cause.message}). Check TRAEFIK_API_URL and that the API is enabled.`;
      } else {
        state.error = err.message;
      }
      if (state.error !== lastError) console.error(`Route refresh failed: ${state.error}`);
    }
    return JSON.stringify([state.routes, state.error]) !== before;
  }

  // What each route's check requests, as checkTarget gives it with the route's id, for the routes that are checked.
  async function targetsFor(routes) {
    const settings = await routeSettings();
    return routes
      .map(route => ({ route, target: checkTarget(route, Object.hasOwn(settings, route.id) ? settings[route.id]?.health : null) }))
      .filter(({ target }) => target)
      .map(({ route, target }) => ({ id: route.id, ...target }));
  }

  // A check that started earlier, such as the poll's while someone asked for one on the page, can finish later, so
  // it only replaces a result for the same URL if it isn't older. The history keeps both.
  function setResult(target, result) {
    history?.record(target.id, target.url, result);
    const last = healthResults.get(target.id);
    if (last?.url === target.url && Date.parse(last.checkedAt) > Date.parse(result.checkedAt)) return;
    healthResults.set(target.id, { ...result, url: target.url, expect: target.expect });
  }

  function isDue(target) {
    const last = healthResults.get(target.id);
    if (!isCurrent(last, target)) return true;
    return now() - Date.parse(last.checkedAt) >= healthIntervalMs - DUE_SLACK_MS;
  }

  // Only routes that are new, have a new URL or health settings, or were last checked an interval ago are checked, so
  // each route gets at most one check per interval however often Traefik is polled. Returns whether any route was
  // checked.
  async function refreshHealth() {
    // Until Traefik has answered once there's nothing to check.
    if (!state.updatedAt) return false;
    const targets = await targetsFor(state.routes);
    const due = targets.filter(isDue);
    if (due.length) {
      const fresh = await checkRoutes(due, healthOptions);
      for (const target of due) {
        const result = fresh.get(target.id);
        if (result) setResult(target, result);
      }
    }
    // Forget routes Traefik no longer serves, or that are no longer checked, so the results don't grow forever.
    const kept = new Map(targets.filter(target => healthResults.has(target.id)).map(target => [target.id, healthResults.get(target.id)]));
    const pruned = kept.size !== healthResults.size;
    healthResults = kept;
    history?.prune();
    return due.length > 0 || pruned;
  }

  // Checks one route now, whether or not it's due, as when someone asks for it on the page. Resolves to the route
  // with its new health, or null when there's no such route or it isn't checked.
  async function checkRoute(id) {
    const route = state.routes.find(r => r.id === id);
    if (!route) return null;
    const [target] = await targetsFor([route]);
    if (!target) return null;
    const result = (await checkRoutes([target], healthOptions)).get(id);
    if (result) setResult(target, result);
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
