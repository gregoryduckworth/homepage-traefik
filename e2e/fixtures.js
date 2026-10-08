const { test: base, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.resolve(__dirname, '..', 'src', 'server.js');

// A stand-in for the Traefik API. Tests change `routers`, or set `down`, to change what the homepage sees.
async function startTraefik(routers) {
  const state = { routers, down: false };
  const server = http.createServer((req, res) => {
    if (state.down) {
      res.writeHead(503).end();
    } else if (req.url.startsWith('/api/http/routers')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(state.routers));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const ROUTERS = [
  { name: 'grafana@docker', rule: 'Host(`grafana.test`)', entryPoints: ['web'], status: 'enabled', service: 'grafana@docker' },
  { name: 'jellyfin@docker', rule: 'Host(`jellyfin.test`)', entryPoints: ['web'], status: 'enabled', service: 'jellyfin@docker' },
  { name: 'sonarr@docker', rule: 'Host(`sonarr.test`)', entryPoints: ['websecure'], tls: {}, status: 'enabled', service: 'sonarr@docker' },
  { name: 'api@internal', rule: 'PathPrefix(`/api`)', entryPoints: ['traefik'], status: 'enabled', provider: 'internal' },
];

// `homepage` is a running homepage server with its own config folder, reading from its own fake Traefik.
// Health checks are pinned to this machine so they never leave it; these tests don't depend on their results.
const test = base.extend({
  routers: [ROUTERS, { option: true }],

  traefik: async ({ routers }, use) => {
    const traefik = await startTraefik(structuredClone(routers));
    await use(traefik);
    await traefik.close();
  },

  homepage: async ({ traefik }, use) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'homepage-e2e-'));
    const port = await freePort();
    const configFile = path.join(dir, 'config', 'homepage.json');
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: String(port),
        TRAEFIK_API_URL: traefik.url,
        CONFIG_FILE: configFile,
        POLL_INTERVAL_SECONDS: '5',
        HEALTHCHECK_ADDRESS: '127.0.0.1',
        HEALTHCHECK_TIMEOUT_SECONDS: '1',
      },
      stdio: 'ignore',
    });
    const url = `http://127.0.0.1:${port}/`;
    await expect.poll(() => fetch(`${url}healthz`).then(res => res.status, () => 0)).toBe(200);
    const readConfig = async () => JSON.parse(await fs.readFile(configFile, 'utf8'));
    await use({ url, configFile, readConfig });
    child.kill();
    await fs.rm(dir, { recursive: true, force: true });
  },
});

module.exports = { test, expect };
