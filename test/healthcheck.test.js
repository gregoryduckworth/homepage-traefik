const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { checkHealth, checkAllRoutes, describeFailure } = require('../src/healthcheck');

const TIMEOUT_MS = 200;
const servers = [];

// Loopback servers stand in for routes, so the probe runs over real sockets without leaving the machine.
async function listen(server) {
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

function httpServer(handler) {
  return listen(http.createServer(handler));
}

// Accepts connections and never says anything, so requests stall after connecting.
function silentServer() {
  const sockets = new Set();
  const server = net.createServer(socket => sockets.add(socket));
  server.on('close', () => sockets.forEach(socket => socket.destroy()));
  return listen(server);
}

async function closedPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

after(() => {
  for (const server of servers) {
    server.closeAllConnections?.();
    server.close();
  }
});

describe('checkHealth', () => {
  it('reports a reachable route with its status code, latency and address', async () => {
    const port = await httpServer((req, res) => res.writeHead(204).end());
    const result = await checkHealth(`http://127.0.0.1:${port}`, { timeoutMs: TIMEOUT_MS });
    assert.equal(result.reachable, true);
    assert.equal(result.statusCode, 204);
    assert.equal(typeof result.latencyMs, 'number');
    assert.equal(result.method, 'HEAD');
    assert.equal(result.address, `127.0.0.1:${port}`);
  });

  it('falls back to GET when HEAD gets a server error', async () => {
    const port = await httpServer((req, res) => res.writeHead(req.method === 'HEAD' ? 501 : 200).end('hello'));
    const result = await checkHealth(`http://127.0.0.1:${port}`, { timeoutMs: TIMEOUT_MS });
    assert.deepEqual([result.reachable, result.statusCode, result.method], [true, 200, 'GET']);
  });

  it('falls back to GET when the route never answers HEAD', async () => {
    const port = await httpServer((req, res) => { if (req.method === 'GET') res.writeHead(200).end(); });
    const result = await checkHealth(`http://127.0.0.1:${port}`, { timeoutMs: TIMEOUT_MS });
    assert.deepEqual([result.reachable, result.method, result.attempts], [true, 'GET', 2]);
  });

  it('reports a 5xx from both HEAD and GET as reachable with that status code', async () => {
    const port = await httpServer((req, res) => res.writeHead(503).end());
    const result = await checkHealth(`http://127.0.0.1:${port}`, { timeoutMs: TIMEOUT_MS });
    assert.deepEqual([result.reachable, result.statusCode], [true, 503]);
  });

  it('times out with the stage it reached when a connected route never responds', async () => {
    const port = await silentServer();
    const result = await checkHealth(`http://127.0.0.1:${port}`, { timeoutMs: TIMEOUT_MS });
    assert.deepEqual(
      { reachable: result.reachable, error: result.error, phase: result.phase, attempts: result.attempts },
      { reachable: false, error: 'TIMEOUT', phase: 'response', attempts: 2 },
    );
    assert.equal(result.detail, `Connected to 127.0.0.1:${port}, but it didn't send a response within 0.2 seconds.`);
  });

  it('times out in the TLS stage when an HTTPS route never completes the handshake', async () => {
    const port = await silentServer();
    const result = await checkHealth(`https://127.0.0.1:${port}`, { timeoutMs: TIMEOUT_MS });
    assert.deepEqual([result.error, result.phase], ['TIMEOUT', 'tls']);
  });

  it('reports a refused connection without retrying', async () => {
    const port = await closedPort();
    const result = await checkHealth(`http://127.0.0.1:${port}`, { timeoutMs: TIMEOUT_MS });
    assert.deepEqual([result.error, result.attempts], ['ECONNREFUSED', 1]);
  });

  it('reports the resolved address when a hostname connects nowhere', async () => {
    const port = await closedPort();
    const result = await checkHealth(`http://app.example.test:${port}`, { timeoutMs: TIMEOUT_MS, address: '127.0.0.1' });
    assert.deepEqual([result.error, result.phase, result.address], ['ECONNREFUSED', 'connect', `127.0.0.1:${port}`]);
  });

  it('reports a name that does not resolve', async () => {
    const lookup = (hostname, options, callback) => callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }));
    const result = await checkHealth('http://app.example.test', { timeoutMs: TIMEOUT_MS, lookup });
    assert.deepEqual([result.error, result.phase, result.detail], ['ENOTFOUND', 'dns', "app.example.test doesn't resolve from the homepage container."]);
  });

  it('connects to a pinned address while sending the route hostname', async () => {
    let host;
    const port = await httpServer((req, res) => { host = req.headers.host; res.writeHead(200).end(); });
    const result = await checkHealth(`http://app.example.test:${port}`, { timeoutMs: TIMEOUT_MS, address: '127.0.0.1' });
    assert.equal(result.reachable, true);
    assert.equal(host, `app.example.test:${port}`);
  });

  it('records when the check ran', async () => {
    const port = await httpServer((req, res) => res.writeHead(200).end());
    const { checkedAt } = await checkHealth(`http://127.0.0.1:${port}`, { timeoutMs: TIMEOUT_MS });
    assert.ok(!Number.isNaN(Date.parse(checkedAt)));
  });
});

describe('describeFailure', () => {
  const base = { host: 'app.lab', address: '10.0.0.5:443', timeoutMs: 10000, message: 'boom' };
  const cases = [
    [{ error: 'TIMEOUT', phase: 'dns', address: null }, 'Looking up app.lab took longer than 10 seconds.'],
    [{ error: 'TIMEOUT', phase: 'connect' }, "Couldn't open a connection to 10.0.0.5:443 within 10 seconds. The host may not be reachable from the homepage container."],
    [{ error: 'TIMEOUT', phase: 'tls' }, "Connected to 10.0.0.5:443, but the TLS handshake didn't finish within 10 seconds."],
    [{ error: 'ECONNREFUSED', phase: 'connect' }, '10.0.0.5:443 refused the connection. Nothing is listening on that port.'],
    [{ error: 'EHOSTUNREACH', phase: 'connect' }, "There's no network route to 10.0.0.5:443 from the homepage container."],
    [{ error: 'ECONNRESET', phase: 'response' }, '10.0.0.5:443 closed the connection before sending a response.'],
    [{ error: 'CERT_HAS_EXPIRED', phase: 'tls' }, 'The certificate for app.lab has expired.'],
    [{ error: 'ERR_TLS_CERT_ALTNAME_INVALID', phase: 'tls' }, "The certificate doesn't cover app.lab."],
    [{ error: 'DEPTH_ZERO_SELF_SIGNED_CERT', phase: 'tls' }, "The certificate for app.lab isn't trusted by the homepage (DEPTH_ZERO_SELF_SIGNED_CERT)."],
    [{ error: 'ERR_SSL_WRONG_VERSION_NUMBER', phase: 'tls' }, 'The TLS handshake with 10.0.0.5:443 failed (boom). The port may not be serving HTTPS.'],
    [{ error: 'EPROTO', phase: 'response' }, 'The request to 10.0.0.5:443 failed: boom.'],
  ];
  for (const [failure, expected] of cases) {
    it(`explains ${failure.error} during ${failure.phase}`, () => {
      assert.equal(describeFailure({ ...base, ...failure }), expected);
    });
  }
});

describe('checkAllRoutes', () => {
  it('skips disabled routes and routes without a URL', async () => {
    const results = await checkAllRoutes([
      { id: 'off@docker', url: 'http://off.test', status: 'disabled' },
      { id: 'metrics@file', url: null },
    ]);
    assert.equal(results.size, 0);
  });

  it('keys results by route id in route order', async () => {
    const up = await httpServer((req, res) => res.writeHead(200).end());
    const down = await closedPort();
    const results = await checkAllRoutes([
      { id: 'up@docker', url: `http://127.0.0.1:${up}` },
      { id: 'down@docker', url: `http://127.0.0.1:${down}` },
    ], { timeoutMs: TIMEOUT_MS });
    assert.deepEqual([...results].map(([id, health]) => [id, health.reachable]), [['up@docker', true], ['down@docker', false]]);
  });

  it('runs no more checks at once than the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    const port = await httpServer((req, res) => {
      peak = Math.max(peak, ++active);
      setTimeout(() => { active--; res.writeHead(200).end(); }, 20);
    });
    const routes = Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, url: `http://127.0.0.1:${port}/${i}` }));
    await checkAllRoutes(routes, { concurrency: 2, timeoutMs: 1000 });
    assert.equal(peak, 2);
  });
});
