const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const { mapLimit } = require('./pool');

// How long a health check or icon request may take, unless HEALTHCHECK_TIMEOUT_SECONDS says otherwise.
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CONCURRENCY = 8;

// Failures worth a second attempt: the route may be slow, flaky, or not answer HEAD. DNS, refused and
// certificate errors won't change a moment later, so they are reported straight away.
const RETRYABLE = new Set(['TIMEOUT', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN']);

const CERT_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// Headers that any server or connection adds, which say nothing about who sent the response.
const ORDINARY_HEADERS = new Set(['date', 'connection', 'keep-alive']);

// Traefik answers a request that none of its routers match with Go's plain "404 page not found": these three headers
// and nothing else. A route's own app would normally send more, or a page of its own, so this usually means the check
// reached a Traefik, or an entry point, that doesn't serve the route. A Go app using http.NotFound looks the same,
// which is why the page shows this as a warning rather than as down.
function isTraefikNotFound(statusCode, headers) {
  if (statusCode !== 404) return false;
  const names = Object.keys(headers).filter(name => !ORDINARY_HEADERS.has(name));
  return names.length === 3
    && headers['content-type'] === 'text/plain; charset=utf-8'
    && headers['x-content-type-options'] === 'nosniff'
    && headers['content-length'] === '19';
}

function seconds(ms) {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} ${s === 1 ? 'second' : 'seconds'}`;
}

// One sentence a person can act on. `phase` is how far the request got: dns, connect, tls or response.
function describeFailure({ error, phase, host, address, timeoutMs, message }) {
  const target = address || host;
  if (error === 'TIMEOUT') {
    if (phase === 'dns') return `Looking up ${host} took longer than ${seconds(timeoutMs)}.`;
    if (phase === 'connect') return `Couldn't open a connection to ${target} within ${seconds(timeoutMs)}. The host may not be reachable from the homepage container.`;
    if (phase === 'tls') return `Connected to ${target}, but the TLS handshake didn't finish within ${seconds(timeoutMs)}.`;
    return `Connected to ${target}, but it didn't send a response within ${seconds(timeoutMs)}.`;
  }
  if (error === 'ENOTFOUND') return `${host} doesn't resolve from the homepage container.`;
  if (error === 'EAI_AGAIN') return `The DNS server didn't answer for ${host}.`;
  if (error === 'ECONNREFUSED') return `${target} refused the connection. Nothing is listening on that port.`;
  if (error === 'EHOSTUNREACH' || error === 'ENETUNREACH') return `There's no network route to ${target} from the homepage container.`;
  if (error === 'ECONNRESET') return `${target} closed the connection before sending a response.`;
  if (error === 'CERT_HAS_EXPIRED') return `The certificate for ${host} has expired.`;
  if (error === 'ERR_TLS_CERT_ALTNAME_INVALID') return `The certificate doesn't cover ${host}.`;
  if (CERT_ERRORS.has(error)) return `The certificate for ${host} isn't trusted by the homepage (${error}).`;
  if (phase === 'tls' || error?.startsWith('ERR_SSL')) return `The TLS handshake with ${target} failed (${message}). The port may not be serving HTTPS.`;
  return `The request to ${target} failed: ${message}.`;
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

// The DNS lookup for outgoing requests. Pinning every lookup to `address` sends them to that host (for example
// Traefik) while keeping the route's hostname in the Host header and TLS SNI, so Traefik still picks the right
// router. An explicit `lookup` wins over both.
function lookupFor({ address, lookup }) {
  if (lookup) return lookup;
  return address ? (hostname, options, callback) => dns.lookup(address, options, callback) : dns.lookup;
}

function hostPort(ip, port) {
  return net.isIPv6(ip) ? `[${ip}]:${port}` : `${ip}:${port}`;
}

// A fresh connection per attempt (agent: false), so a keep-alive socket the server already closed can't fail a check.
// `phase` tracks how far the request got, so a timeout can say whether it stalled on DNS, connecting, TLS or the response.
function probe(url, { method, timeoutMs, lookup = dns.lookup }) {
  return new Promise(resolve => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const port = target.port || (client === https ? 443 : 80);
    const literal = target.hostname.replace(/^\[|\]$/g, '');
    const start = Date.now();
    let phase = net.isIP(literal) ? 'connect' : 'dns';
    let address = net.isIP(literal) ? hostPort(literal, port) : null;

    // Wrapping the lookup is the reliable way to see DNS finish: the socket only emits 'lookup' for some address counts.
    const trackedLookup = (hostname, options, callback) => lookup(hostname, options, (err, result, family) => {
      if (!err) {
        const ip = Array.isArray(result) ? result[0]?.address : result;
        phase = 'connect';
        if (ip) address = hostPort(ip, port);
      }
      callback(err, result, family);
    });

    const req = client.request(target, {
      method,
      agent: false,
      lookup: trackedLookup,
      headers: { 'user-agent': 'homepage-traefik health check', accept: '*/*' },
    });
    const timer = setTimeout(() => req.destroy(failure('TIMEOUT', `No response within ${timeoutMs} ms`)), timeoutMs);

    req.on('socket', socket => {
      socket.once('connect', () => {
        phase = client === https ? 'tls' : 'response';
        if (socket.remoteAddress) address = hostPort(socket.remoteAddress, socket.remotePort);
      });
      socket.once('secureConnect', () => { phase = 'response'; });
    });
    req.once('response', res => {
      clearTimeout(timer);
      res.on('error', () => {}); // cutting the body short can make the response emit "aborted"
      req.destroy(); // a GET fallback only needs the status line, not the body
      resolve({ ok: true, statusCode: res.statusCode, latencyMs: Date.now() - start, address, unrouted: isTraefikNotFound(res.statusCode, res.headers) });
    });
    req.once('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.code || err.name || 'ERROR', message: err.message, phase, address });
    });
    req.end();
  });
}

// The status codes that count as up: those in `expect` when it's given, otherwise any below 500.
function countsAsUp(statusCode, expect) {
  return expect ? expect.includes(statusCode) : statusCode < 500;
}

function codesText(codes) {
  const list = codes.map(code => `HTTP ${code}`);
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} or ${list.at(-1)}` : list[0];
}

// Any HTTP response below 500 means the route is reachable; the UI decides how to present the status code. `expect`,
// when given, lists the only status codes that count as up, and a response with another is marked `unexpected`.
// HEAD is cheap, but some apps reject it with a 5xx or never answer it, so a failed HEAD is retried once with GET, as
// is one whose status doesn't count as up.
async function checkHealth(url, { timeoutMs = DEFAULT_TIMEOUT_MS, address, lookup, expect = null } = {}) {
  const checkedAt = new Date().toISOString();
  const host = new URL(url).hostname;
  const opts = { timeoutMs, lookup: lookupFor({ address, lookup }) };

  let attempt = await probe(url, { ...opts, method: 'HEAD' });
  let method = 'HEAD';
  const retry = attempt.ok ? !countsAsUp(attempt.statusCode, expect) : RETRYABLE.has(attempt.error);
  if (retry) {
    attempt = await probe(url, { ...opts, method: 'GET' });
    method = 'GET';
  }

  const base = { method, attempts: retry ? 2 : 1, address: attempt.address, checkedAt };
  if (attempt.ok) {
    // A 5xx is down whatever `expect` says, so only a response below 500 is called unexpected.
    const unexpected = attempt.statusCode < 500 && !countsAsUp(attempt.statusCode, expect);
    let detail = null;
    if (attempt.unrouted) {
      detail = `${attempt.address || host} answered "404 page not found", which is what Traefik sends when none of its routers match ${host}. The check may have reached a different Traefik, or an entry point the route isn't on.`;
    } else if (unexpected) {
      detail = `${host} answered HTTP ${attempt.statusCode}, which this route's health check doesn't count as up. Only ${codesText(expect)} does.`;
    }
    return { reachable: true, statusCode: attempt.statusCode, latencyMs: attempt.latencyMs, unrouted: attempt.unrouted, unexpected, error: null, phase: null, detail, ...base };
  }
  const detail = describeFailure({ ...attempt, host, timeoutMs });
  // Said outright so the page needn't keep its own list of certificate error codes.
  const certificateError = CERT_ERRORS.has(attempt.error);
  return { reachable: false, statusCode: null, latencyMs: null, error: attempt.error, phase: attempt.phase, certificateError, detail, ...base };
}

// What a route's health check requests and the status codes that count as up, as { url, expect }, or null when the
// route isn't checked: when it has no web address, such as a TCP route, its router is disabled, or `health`, the
// route's health settings from the config file, turn the check off. A `path` there is requested on the route's own
// host and port instead of its path.
function checkTarget(route, health = null) {
  if (!route.url || route.status === 'disabled' || health?.check === false) return null;
  return { url: health?.path ? new URL(health.path, route.url).href : route.url, expect: health?.expect ?? null };
}

function isCheckable(route, health = null) {
  return Boolean(checkTarget(route, health));
}

// Whether a health result, which records the URL and status codes it checked, is a check of `target`, so a result
// from before the route's health settings changed isn't shown as the route's health.
function isCurrent(result, target) {
  return Boolean(result && target) && result.url === target.url && String(result.expect ?? null) === String(target.expect);
}

// Checks run a few at a time: firing every probe at once makes slow hosts (and Traefik itself) queue up and time out.
// `targets` are { id, url, expect }, as checkTarget gives them with the route's id. Resolves to the results by id.
async function checkAllRoutes(targets, { concurrency = DEFAULT_CONCURRENCY, ...opts } = {}) {
  const results = await mapLimit(targets, concurrency, ({ url, expect }) => checkHealth(url, { ...opts, expect }));
  return new Map(targets.map((target, index) => [target.id, results[index]]));
}

module.exports = { DEFAULT_TIMEOUT_MS, checkHealth, checkAllRoutes, checkTarget, describeFailure, isCheckable, isCurrent, isTraefikNotFound, lookupFor };
