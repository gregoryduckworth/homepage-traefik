const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fetchRouters, normalizeRouters } = require('./traefik');
const { checkAllRoutes, isCheckable } = require('./healthcheck');
const { ConfigError, linkId, storedHealth, createConfigStore } = require('./config');
const { createIconStore, parseSavedIcons } = require('./favicon');
const { createEvents } = require('./events');
const { writeSafely } = require('./files');

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

// A link from the config file, shaped like a route so it's listed, grouped and checked the same way.
function linkRoute(link) {
  const url = new URL(link.url);
  return {
    id: linkId(link.name),
    protocol: 'link',
    name: link.name,
    provider: 'link',
    status: 'enabled',
    rule: '',
    service: null,
    entryPoints: [],
    middlewares: [],
    priority: null,
    errors: [],
    tls: url.protocol === 'https:',
    certResolver: null,
    host: url.host,
    path: `${url.pathname === '/' ? '' : url.pathname}${url.search}`,
    url: link.url,
    link,
  };
}

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
  // Routes from Traefik and links from the config file, kept apart so either can change without the other.
  let traefikRoutes = [];
  let linkRoutes = [];
  // Keyed by route id. Each result records the URL it checked, so a route whose URL changes is checked again.
  let healthResults = new Map(health);

  // Resolves to whether the routes or the error changed.
  async function refresh() {
    const before = JSON.stringify([state.routes, state.error]);
    try {
      traefikRoutes = normalizeRouters(await fetchRouters(traefikUrl, { fetchImpl }));
      state.routes = [...traefikRoutes, ...linkRoutes];
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

  // Resolves to whether the links changed. They're listed even while Traefik can't be reached.
  function setLinks(links) {
    const before = JSON.stringify(linkRoutes);
    linkRoutes = links.map(linkRoute);
    state.routes = [...traefikRoutes, ...linkRoutes];
    return JSON.stringify(linkRoutes) !== before;
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

  return { state, refresh, setLinks, refreshHealth, getHealth, getRoutesWithHealth };
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

// Reads a JSON body for a PUT and replies with whatever `save` returns, or with the error. `remove`, when given,
// answers a DELETE the same way, without a body. Resolves to whether the change was saved.
async function handlePut(req, res, what, save, remove = null) {
  if (req.method !== 'PUT' && !(remove && req.method === 'DELETE')) {
    res.writeHead(405, { Allow: remove ? 'PUT, DELETE' : 'PUT', 'Content-Type': 'text/plain' }).end('Method not allowed');
    return false;
  }
  try {
    sendJson(res, 200, req.method === 'DELETE' ? await remove() : await save(await readJson(req)));
    return true;
  } catch (err) {
    const status = err instanceof ConfigError ? err.status : 500;
    if (status >= 500) console.error(`Saving ${what} failed: ${err.message}`);
    if (!res.headersSent) sendJson(res, status, { error: err instanceof ConfigError ? err.message : `Saving ${what} failed` });
    return false;
  }
}

// Icons come from the routes themselves, so they're served with headers that stop an SVG running script if someone
// opens one directly. The URL carries a hash of the icon, so browsers can cache it until it changes.
function sendIcon(res, icon) {
  if (!icon) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': icon.type,
    'Cache-Control': 'public, max-age=86400',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(icon.body);
}

function iconPath(id, icon) {
  return icon ? `api/icons/${encodeURIComponent(id)}?v=${icon.hash}` : null;
}

// The decoded rest of the path after a prefix, such as the router name in /api/routes/<name>. Null for a
// malformed escape.
function pathParam(pathname, prefix) {
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
}

// `events`, when given, serves /api/events and tells other open pages about changes saved here.
function createServer({ store, config, title, icons = { get: () => null }, events = null }) {
  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/api/routes') {
      const { groups, routes: settings, error: configError } = await config.read();
      sendJson(res, 200, {
        title,
        routes: store.getRoutesWithHealth().map(route => ({
          ...route,
          custom: settings[route.id] || null,
          icon: iconPath(route.id, icons.get(route.id)),
        })),
        groups,
        updatedAt: store.state.updatedAt,
        error: store.state.error,
        configError,
      });
      return;
    }

    if (pathname.startsWith('/api/routes/')) {
      const id = pathParam(pathname, '/api/routes/');
      if (await handlePut(req, res, 'the route', async body => ({ custom: await config.saveRoute(id, body) }))) events?.notify();
      return;
    }

    // The links are listed straight away, rather than on the next poll; they're checked on the next poll.
    if (pathname.startsWith('/api/links/')) {
      const name = pathParam(pathname, '/api/links/');
      const saved = await handlePut(req, res, 'the link',
        async body => ({ link: await config.saveLink(name, body) }),
        async () => {
          if (!(await config.deleteLink(name))) throw new ConfigError(`There's no link called "${name}"`, 404);
          return { deleted: true };
        });
      if (saved) {
        store.setLinks((await config.read()).links);
        events?.notify();
      }
      return;
    }

    if (pathname === '/api/groups') {
      if (await handlePut(req, res, 'groups', async body => ({ groups: await config.saveGroups(body?.groups) }))) events?.notify();
      return;
    }

    if (pathname === '/api/events' && events) {
      events.handle(req, res);
      return;
    }

    if (pathname.startsWith('/api/icons/')) {
      sendIcon(res, icons.get(pathParam(pathname, '/api/icons/')));
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

// Runs `task` one call at a time. A failure is logged once rather than on every call while it keeps failing, say
// while the file stays unwritable.
function saveQuietly(what, task) {
  let queue = Promise.resolve();
  let lastError = null;
  return () => {
    queue = queue.then(async () => {
      try {
        await task();
        lastError = null;
      } catch (err) {
        if (err.message !== lastError) console.error(`${what} failed: ${err.message}`);
        lastError = err.message;
      }
    });
    return queue;
  };
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
  const timeoutSeconds = readSeconds(process.env, 'HEALTHCHECK_TIMEOUT_SECONDS', { fallback: 10, min: 1 });
  const healthOptions = {
    timeoutMs: timeoutSeconds * 1000,
    address: process.env.HEALTHCHECK_ADDRESS || undefined,
  };

  // Icons found on the sites are saved beside the config file, so a restart shows them straight away.
  const iconsFile = path.join(path.dirname(configFile), 'icons.json');
  const loadIcons = () => fs.readFile(iconsFile, 'utf8').then(parseSavedIcons).catch(err => {
    if (err.code === 'EISDIR') {
      console.warn(`${iconsFile} is a directory, not a file, so icons won't be saved. Docker creates a directory when the file you mount doesn't exist on the host: create the file (an empty one is fine), remove the directory Docker made and recreate the container`);
    } else if (err.code !== 'ENOENT') {
      console.warn(`Ignoring ${iconsFile}: ${err.message}`);
    }
    return new Map();
  });

  const config = createConfigStore({ file: configFile });
  const events = createEvents();

  Promise.all([config.read(), loadIcons()]).then(([{ doc }, savedIcons]) => {
    const store = createRouteStore({ traefikUrl, fetchImpl: fetch, healthOptions, healthIntervalMs: healthSeconds * 1000, health: storedHealth(doc) });
    // Icons are looked up even for routes with one set in the config file, so the page can fall back to the
    // site's own icon if that one doesn't load.
    const icons = createIconStore({ options: healthOptions, saved: savedIcons, onChange: events.notify });
    const saveHealth = saveQuietly(`Saving health checks to ${configFile}`, () => config.saveHealth(store.getHealth()));
    const saveIcons = saveQuietly(`Saving icons to ${iconsFile}`, () => writeSafely(iconsFile, icons.serialize()));
    const refreshIcons = () => icons.refresh(store.getRoutesWithHealth()).then(changed => changed && saveIcons(), err => {
      console.error(`Looking up route icons failed: ${err.message}`);
    });

    // Skip a tick if the previous cycle is still running, so a slow probe can't overwrite newer results. Icons are
    // looked up in the background, so a slow site can't hold up the next poll. Until Traefik has answered once
    // there are no routes, and refreshing the icons would forget the saved ones.
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        // Picks up links added or changed by hand in the config file.
        const linksChanged = store.setLinks((await config.read()).links);
        const routesChanged = (await store.refresh()) || linksChanged;
        const healthChanged = await store.refreshHealth();
        if (routesChanged || healthChanged) events.notify();
        if (healthChanged) await saveHealth();
        if (store.state.updatedAt) refreshIcons();
      } finally {
        polling = false;
      }
    };

    const server = createServer({ store, config, title, icons, events });
    server.listen(port, () => console.log(`Homepage on :${port}, reading routes from ${traefikUrl} every ${pollSeconds}s, checking each route every ${healthSeconds}s, groups from ${configFile}`));
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        events.close();
        server.close(() => process.exit(0));
      });
    }
    poll();
    setInterval(poll, pollSeconds * 1000).unref();
  });
}

module.exports = { createServer, createRouteStore, linkRoute, readSeconds };
