const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fetchRouters, normalizeRouters, parseEntryPointPorts } = require('./traefik');
const { checkAllRoutes, isCheckable } = require('./healthcheck');
const { ConfigError, createConfigStore } = require('./config');
const { createIconStore, parseSavedIcons } = require('./favicon');
const { createEvents } = require('./events');
const { writeSafely } = require('./files');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const MAX_BODY_BYTES = 64 * 1024;

// The page only loads its own files, apart from route icons, which can be any http:// or https:// image set on the
// page. So even if a route's name or rule managed to get into the page as markup, it couldn't run script or send
// data anywhere.
const PAGE_CSP = "default-src 'self'; img-src 'self' http: https:; object-src 'none'; base-uri 'none'";

// The page's own files are checked with the server on each load, so an upgrade shows up straight away, and come back
// as 304s when they haven't changed. The fonts never change, so browsers keep them for a week without asking.
function cacheControlFor(filePath) {
  return path.extname(filePath) === '.woff2' ? 'public, max-age=604800' : 'no-cache';
}

// Ticks start a little later each time, by however long the Traefik request took, so a route checked one interval
// ago can look a moment too young. Without some slack it would wait a whole extra tick.
const DUE_SLACK_MS = 2000;

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
    return { ...route, health: healthResults.get(id) || null };
  }

  function getRoutesWithHealth() {
    return state.routes.map(route => {
      const health = healthResults.get(route.id);
      return { ...route, health: health || null };
    });
  }

  return { state, refresh, refreshHealth, checkRoute, getRoutesWithHealth };
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

// Reads a JSON body for a PUT and replies with whatever `save` returns, or with the error. Resolves to whether
// the change was saved.
async function handlePut(req, res, what, save) {
  if (req.method !== 'PUT') {
    res.writeHead(405, { Allow: 'PUT', 'Content-Type': 'text/plain' }).end('Method not allowed');
    return false;
  }
  try {
    sendJson(res, 200, await save(await readJson(req)));
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

// `events`, when given, serves /api/events and tells other open pages about changes saved here. `frameAncestors`
// lists the sites that may show the page in a frame: anyone who can open it can change its groups, so by default
// only the homepage itself may, which stops another site tricking someone into dragging routes about. `version` is the
// image's version, shown at the foot of the page, or null when not running from the image. `check`, when given, serves
// /api/check/<id>, which checks a route and looks up its icon now rather than when they're next due; it resolves to
// the route with its new health, or null when there's nothing to check.
function createServer({ store, config, title, version = null, icons = { get: () => null }, events = null, check = null, frameAncestors = "'self'" }) {
  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', `${PAGE_CSP}; frame-ancestors ${frameAncestors}`);

    if (pathname === '/api/routes') {
      const { groups, routes: settings, error: configError } = await config.read();
      sendJson(res, 200, {
        title,
        version,
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

    if (pathname === '/api/groups') {
      if (await handlePut(req, res, 'groups', async body => ({ groups: await config.saveGroups(body?.groups) }))) events?.notify();
      return;
    }

    if (pathname.startsWith('/api/check/') && check) {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain' }).end('Method not allowed');
        return;
      }
      const route = await check(pathParam(pathname, '/api/check/'));
      if (route) sendJson(res, 200, { health: route.health });
      else sendJson(res, 404, { error: 'There’s no route by that name with an address to check' });
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
      const stat = await fs.stat(filePath);
      const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      const headers = { ETag: etag, 'Cache-Control': cacheControlFor(filePath) };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers).end();
        return;
      }
      const data = await fs.readFile(filePath);
      res.writeHead(200, { ...headers, 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  }

  // An error nothing above expected is answered with a 500, rather than leaving the request hanging and, as an
  // unhandled rejection, stopping the server.
  return http.createServer((req, res) => {
    handle(req, res).catch(err => {
      console.error(`${req.method} ${req.url} failed: ${err.message}`);
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: 'The homepage server hit an error' });
    });
  });
}

// Stops taking requests, ends pages' event streams, and resolves once the server has closed. Node 24's close() also
// waits for connections that haven't sent a request yet, such as the spare one a browser opens ahead of time, which
// would hold up `docker stop` until Docker kills the container. So requests already under way get `graceMs` to
// finish, and then any connection still open is closed.
function shutDown({ server, events = null, graceMs = 1000 }) {
  events?.close();
  const closed = new Promise(resolve => server.close(() => resolve()));
  const timer = setTimeout(() => server.closeAllConnections(), graceMs);
  return closed.finally(() => clearTimeout(timer));
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

// A port that isn't a whole number from 1 to 65535 would otherwise crash the server as it starts.
function readPort(env, fallback = 3000) {
  const raw = env.PORT;
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= 1 && value <= 65535) return value;
  console.warn(`PORT=${raw} isn't a port number from 1 to 65535, so ${fallback} is used`);
  return fallback;
}

// The sources in FRAME_ANCESTORS, such as "https://dash.example.com" or "*", go straight into a header, so anything
// that would end the directive or the header is refused.
function readFrameAncestors(env, fallback = "'self'") {
  const raw = (env.FRAME_ANCESTORS || '').trim();
  if (!raw) return fallback;
  if (/[;,\r\n]/.test(raw)) {
    console.warn(`FRAME_ANCESTORS=${raw} should be a space-separated list of sites, so only the homepage itself may frame it`);
    return fallback;
  }
  return raw;
}

if (require.main === module) {
  const port = readPort(process.env);
  const frameAncestors = readFrameAncestors(process.env);
  const traefikUrl = process.env.TRAEFIK_API_URL || 'http://traefik:8080';
  const pollSeconds = readSeconds(process.env, 'POLL_INTERVAL_SECONDS', { fallback: 30, min: 5 });
  const healthSeconds = readSeconds(process.env, 'HEALTHCHECK_INTERVAL_SECONDS', { fallback: 60, min: 10 });
  const title = process.env.HOMEPAGE_TITLE || 'Routes';
  const version = process.env.HOMEPAGE_VERSION || null;
  const { ports: entryPointPorts, invalid: invalidPorts } = parseEntryPointPorts(process.env.ENTRYPOINT_PORTS);
  if (invalidPorts.length) console.warn(`Ignoring ${invalidPorts.join(', ')} in ENTRYPOINT_PORTS: each entry should be <entry point>:<port>, such as websecure:8443`);
  const configFile = path.resolve(process.env.CONFIG_FILE || 'config/homepage.json');
  const timeoutSeconds = readSeconds(process.env, 'HEALTHCHECK_TIMEOUT_SECONDS', { fallback: 10, min: 1 });
  const healthOptions = {
    timeoutMs: timeoutSeconds * 1000,
    address: process.env.HEALTHCHECK_ADDRESS || undefined,
  };

  // Icons found on the sites are saved beside the config file, so a restart shows them straight away. They're only a
  // cache, so a file that can't be read is warned about and started afresh.
  const iconsFile = path.join(path.dirname(configFile), 'icons.json');
  const loadCache = (file, parse) => fs.readFile(file, 'utf8').then(parse).catch(err => {
    if (err.code === 'EISDIR') {
      console.warn(`${file} is a directory, not a file, so it won't be saved. Docker creates a directory when the file you mount doesn't exist on the host: create the file (an empty one is fine), remove the directory Docker made and recreate the container`);
    } else if (err.code !== 'ENOENT') {
      console.warn(`Ignoring ${file}: ${err.message}`);
    }
    return null;
  });

  const config = createConfigStore({ file: configFile });
  const events = createEvents();

  loadCache(iconsFile, parseSavedIcons).then(savedIcons => {
    const store = createRouteStore({ traefikUrl, fetchImpl: fetch, entryPointPorts, healthOptions, healthIntervalMs: healthSeconds * 1000 });
    // Icons are looked up even for routes with one set in the config file, so the page can fall back to the
    // site's own icon if that one doesn't load.
    const icons = createIconStore({ options: healthOptions, saved: savedIcons ?? new Map(), onChange: events.notify });
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
    };

    // A check asked for on the page runs straight away, beside the poll's. The page waits for the icon too, so it
    // knows when everything it asked for is done.
    const check = async id => {
      const route = await store.checkRoute(id);
      if (!route) return null;
      events.notify();
      if (await icons.recheck(route).catch(err => console.error(`Looking up the icon for ${id} failed: ${err.message}`))) saveIcons();
      return route;
    };

    const server = createServer({ store, config, title, version, icons, events, check, frameAncestors });
    server.listen(port, () => console.log(`Homepage on :${port}, reading routes from ${traefikUrl} every ${pollSeconds}s, checking each route every ${healthSeconds}s, groups from ${configFile}`));
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => shutDown({ server, events }).then(() => process.exit(0)));
    }
    poll();
    setInterval(poll, pollSeconds * 1000).unref();
  });
}

module.exports = { createServer, createRouteStore, shutDown, readSeconds, readPort, readFrameAncestors };
