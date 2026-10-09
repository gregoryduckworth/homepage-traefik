const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ConfigError, createConfigStore } = require('./config');
const { createIconStore, parseSavedIcons } = require('./favicon');
const { createEvents } = require('./events');
const { writeSafely, saveQuietly, readCache } = require('./files');
const { readSettings } = require('./env');
const { createRouteStore } = require('./routeStore');
const { createPoller } = require('./poller');

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

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Browsers only send another site's request as application/json after asking the server first, which it never agrees
// to, so requiring it means only the page itself can change things.
function isJson(req) {
  return /^application\/json\b/.test(req.headers['content-type'] || '');
}

// Answers with a 405 or a 415 unless the request is a `method` with a JSON body, and says whether it was.
function accepts(req, res, method) {
  if (req.method !== method) {
    res.writeHead(405, { Allow: method, 'Content-Type': 'text/plain' }).end('Method not allowed');
    return false;
  }
  if (!isJson(req)) {
    sendJson(res, 415, { error: 'Send the request body as application/json' });
    return false;
  }
  return true;
}

async function readJson(req) {
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
  if (!accepts(req, res, 'PUT')) return false;
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
  // Checks under way, by route id, so a route asked for again from another page waits for the same check.
  const checks = new Map();

  function checkOnce(id) {
    if (!checks.has(id)) checks.set(id, check(id).finally(() => checks.delete(id)));
    return checks.get(id);
  }

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
      if (!accepts(req, res, 'POST')) return;
      const route = await checkOnce(pathParam(pathname, '/api/check/'));
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

// Starts the homepage as `env` sets it up: serves the page, and polls Traefik until it's stopped.
async function main(env) {
  const { port, frameAncestors, traefikUrl, pollSeconds, healthSeconds, title, version, entryPointPorts, configFile, healthOptions } = readSettings(env);
  // Icons found on the sites are saved beside the config file, so a restart shows them straight away.
  const iconsFile = path.join(path.dirname(configFile), 'icons.json');
  const config = createConfigStore({ file: configFile });
  const events = createEvents();
  const savedIcons = await readCache(iconsFile, parseSavedIcons);

  const store = createRouteStore({ traefikUrl, fetchImpl: fetch, entryPointPorts, healthOptions, healthIntervalMs: healthSeconds * 1000 });
  // Icons are looked up even for routes with one set in the config file, so the page can fall back to the
  // site's own icon if that one doesn't load.
  const icons = createIconStore({ options: healthOptions, saved: savedIcons ?? new Map(), onChange: events.notify });
  const saveIcons = saveQuietly(`Saving icons to ${iconsFile}`, () => writeSafely(iconsFile, icons.serialize()));
  const { poll, check } = createPoller({ store, icons, events, saveIcons });

  const server = createServer({ store, config, title, version, icons, events, check, frameAncestors });
  // Polling only starts once the server is listening. A port it can't listen on, such as one already in use, ends
  // it with a sentence rather than Node's stack trace.
  server.once('error', err => {
    console.error(err.code === 'EADDRINUSE'
      ? `Port ${port} is already in use. Stop whatever is using it, or set PORT to another port.`
      : `Can't listen on port ${port} (${err.code || err.message})`);
    process.exit(1);
  });
  server.listen(port, () => {
    console.log(`Homepage on :${port}, reading routes from ${traefikUrl} every ${pollSeconds}s, checking each route every ${healthSeconds}s, groups from ${configFile}`);
    poll();
    setInterval(poll, pollSeconds * 1000).unref();
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => shutDown({ server, events }).then(() => process.exit(0)));
  }
}

if (require.main === module) main(process.env);

module.exports = { createServer, shutDown };
