const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fetchRouters, normalizeRouters } = require('./traefik');
const { checkAllRoutes } = require('./healthcheck');
const { ConfigError, createConfigStore } = require('./config');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const MAX_BODY_BYTES = 64 * 1024;

function createRouteStore({ traefikUrl, fetchImpl, checkRoutes = checkAllRoutes, healthOptions = {} }) {
  const state = { routes: [], updatedAt: null, error: null };
  let healthResults = new Map();

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

  async function refreshHealth() {
    if (!state.routes.length) return;
    healthResults = await checkRoutes(state.routes, healthOptions);
  }

  function getRoutesWithHealth() {
    return state.routes.map(route => {
      const health = healthResults.get(route.id);
      return { ...route, health: health || null };
    });
  }

  return { state, refresh, refreshHealth, getRoutesWithHealth };
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

if (require.main === module) {
  const port = parseInt(process.env.PORT || '3000', 10);
  const traefikUrl = process.env.TRAEFIK_API_URL || 'http://traefik:8080';
  const pollMs = parseInt(process.env.POLL_INTERVAL_SECONDS || '30', 10) * 1000;
  const title = process.env.HOMEPAGE_TITLE || 'Routes';
  const configFile = path.resolve(process.env.CONFIG_FILE || 'config/homepage.json');
  const timeoutSeconds = parseFloat(process.env.HEALTHCHECK_TIMEOUT_SECONDS);
  const healthOptions = {
    timeoutMs: timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined,
    address: process.env.HEALTHCHECK_ADDRESS || undefined,
  };

  const store = createRouteStore({ traefikUrl, fetchImpl: fetch, healthOptions });
  // Skip a tick if the previous cycle is still running, so a slow probe can't overwrite newer results.
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      await store.refresh();
      await store.refreshHealth();
    } finally {
      polling = false;
    }
  };
  poll();
  setInterval(poll, pollMs).unref();

  const config = createConfigStore({ file: configFile });
  const server = createServer({ store, config, title });
  server.listen(port, () => console.log(`Homepage on :${port}, reading routes from ${traefikUrl}, groups from ${configFile}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}

module.exports = { createServer, createRouteStore };
