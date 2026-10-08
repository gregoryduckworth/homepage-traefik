const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fetchRouters, normalizeRouters } = require('./traefik');

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function createRouteStore({ traefikUrl, fetchImpl }) {
  const state = { routes: [], updatedAt: null, error: null };

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

  return { state, refresh };
}

function createServer({ store, title }) {
  return http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/api/routes') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ title, ...store.state }));
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

  const store = createRouteStore({ traefikUrl, fetchImpl: fetch });
  store.refresh();
  setInterval(store.refresh, pollMs).unref();

  const server = createServer({ store, title });
  server.listen(port, () => console.log(`Homepage on :${port}, reading routes from ${traefikUrl}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}

module.exports = { createServer, createRouteStore };
