const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fetchRouters, normalizeRouters } = require('./traefik');
const { checkAllRoutes, isCheckable } = require('./healthcheck');
const { ConfigError, storedHealth, createConfigStore } = require('./config');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const MAX_BODY_BYTES = 64 * 1024;

// Ticks start a little later each time, by however long the Traefik request took, so a route checked one interval
// ago can look a moment too young. Without some slack it would wait a whole extra tick.
const DUE_SLACK_MS = 2000;

function createRouteStore({
  traefikUrl,
  fetchImpl,
  checkRoutes = checkAllRoutes,
  healthOptions = {},
  healthIntervalMs = 0,
  health = new Map(),
  now = Date.now,
}) {
  const state = { routes: [], updatedAt: null, error: null };
  // Keyed by route id. Each result records the URL it checked, so a route whose URL changes is checked again.
  let healthResults = new Map(health);

  async function refresh() {
    try {
      state.routes = normalizeRouters(await fetchRouters(traefikUrl, { fetchImpl }));
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
  }

  function isDue(route) {
    const last = healthResults.get(route.id);
    if (!last || last.url !== route.url) return true;
    return now() - Date.parse(last.checkedAt) >= healthIntervalMs - DUE_SLACK_MS;
  }

  // Only routes that are new, have a new URL or were last checked an interval ago are checked, so each route gets
  // at most one check per interval however often Traefik is polled. Returns whether any route was checked.
  async function refreshHealth() {
    // Until Traefik has answered once there's nothing to check, and pruning would throw away the saved results.
    if (!state.updatedAt) return false;
    const checkable = state.routes.filter(isCheckable);
    const due = checkable.filter(isDue);
    if (due.length) {
      const fresh = await checkRoutes(due, healthOptions);
      for (const route of due) {
        const result = fresh.get(route.id);
        if (result) healthResults.set(route.id, { ...result, url: route.url });
      }
    }
    // Forget routes Traefik no longer serves, so the saved results don't grow forever.
    const kept = new Map(checkable.filter(route => healthResults.has(route.id)).map(route => [route.id, healthResults.get(route.id)]));
    const pruned = kept.size !== healthResults.size;
    healthResults = kept;
    return due.length > 0 || pruned;
  }

  function getHealth() {
    return Object.fromEntries(healthResults);
  }

  function getRoutesWithHealth() {
    return state.routes.map(route => {
      const health = healthResults.get(route.id);
      return { ...route, health: health || null };
    });
  }

  return { state, refresh, refreshHealth, getHealth, getRoutesWithHealth };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw new ConfigError('Send the request body as application/json', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ConfigError('The request body is too large', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ConfigError('The request body is not valid JSON');
  }
}

async function handleGroups(req, res, config) {
  if (req.method !== 'PUT') {
    res.writeHead(405, { Allow: 'PUT', 'Content-Type': 'text/plain' }).end('Method not allowed');
    return;
  }
  try {
    const body = await readJson(req);
    sendJson(res, 200, { groups: await config.saveGroups(body?.groups) });
  } catch (err) {
    const status = err instanceof ConfigError ? err.status : 500;
    if (status >= 500) console.error(`Saving groups failed: ${err.message}`);
    if (!res.headersSent) sendJson(res, status, { error: err instanceof ConfigError ? err.message : 'Saving groups failed' });
  }
}

function createServer({ store, config, title }) {
  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/api/routes') {
      const { groups, error: configError } = await config.read();
      sendJson(res, 200, {
        title,
        routes: store.getRoutesWithHealth(),
        groups,
        updatedAt: store.state.updatedAt,
        error: store.state.error,
        configError,
      });
      return;
    }

    if (pathname === '/api/groups') {
      await handleGroups(req, res, config);
      return;
    }

    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    try {
      const filePath = path.resolve(PUBLIC_DIR, `.${pathname === '/' ? '/index.html' : decodeURIComponent(pathname)}`);
      if (!filePath.startsWith(PUBLIC_DIR + path.sep)) throw new Error('outside public dir');
      const data = await fs.readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  });
}

// A missing, mistyped or tiny interval would otherwise poll back to back, so it falls back to the default or is
// raised to the minimum.
function readSeconds(env, name, { fallback, min }) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.warn(`${name}=${raw} isn't a number of seconds, so ${fallback} is used`);
    return fallback;
  }
  if (value < min) {
    console.warn(`${name}=${raw} is below the minimum, so ${min} is used`);
    return min;
  }
  return value;
}

if (require.main === module) {
  const port = parseInt(process.env.PORT || '3000', 10);
  const traefikUrl = process.env.TRAEFIK_API_URL || 'http://traefik:8080';
  const pollSeconds = readSeconds(process.env, 'POLL_INTERVAL_SECONDS', { fallback: 30, min: 5 });
  const healthSeconds = readSeconds(process.env, 'HEALTHCHECK_INTERVAL_SECONDS', { fallback: 60, min: 10 });
  const title = process.env.HOMEPAGE_TITLE || 'Routes';
  const configFile = path.resolve(process.env.CONFIG_FILE || 'config/homepage.json');
  const timeoutSeconds = parseFloat(process.env.HEALTHCHECK_TIMEOUT_SECONDS);
  const healthOptions = {
    timeoutMs: timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined,
    address: process.env.HEALTHCHECK_ADDRESS || undefined,
  };

  const config = createConfigStore({ file: configFile });
  let store;
  let saveError = null;
  const saveHealth = async () => {
    try {
      await config.saveHealth(store.getHealth());
      saveError = null;
    } catch (err) {
      // Log once rather than on every check while the file stays unwritable.
      if (err.message !== saveError) console.error(`Saving health checks to ${configFile} failed: ${err.message}`);
      saveError = err.message;
    }
  };

  // Skip a tick if the previous cycle is still running, so a slow probe can't overwrite newer results.
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      await store.refresh();
      if (await store.refreshHealth()) await saveHealth();
    } finally {
      polling = false;
    }
  };

  config.read().then(({ doc }) => {
    store = createRouteStore({ traefikUrl, fetchImpl: fetch, healthOptions, healthIntervalMs: healthSeconds * 1000, health: storedHealth(doc) });
    const server = createServer({ store, config, title });
    server.listen(port, () => console.log(`Homepage on :${port}, reading routes from ${traefikUrl} every ${pollSeconds}s, checking each route every ${healthSeconds}s, groups from ${configFile}`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
    poll();
    setInterval(poll, pollSeconds * 1000).unref();
  });
}

module.exports = { createServer, createRouteStore, readSeconds };
