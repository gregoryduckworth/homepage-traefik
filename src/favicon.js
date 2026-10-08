const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { isCheckable, lookupFor } = require('./healthcheck');
const { mapLimit } = require('./pool');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_CONCURRENCY = 4;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_ICON_BYTES = 256 * 1024;
const MAX_REDIRECTS = 5;
// Icons linked from the page that are tried before /favicon.ico, best first.
const MAX_LINKED_ICONS = 3;
const HOUR_MS = 60 * 60 * 1000;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

// Fetches a URL into a buffer, following redirects on the same host only: a redirect to another host is usually a
// login page, whose icon belongs to the login provider. Certificates aren't verified, because self-signed ones are
// common on home labs and the result is only a picture; the server sends it with headers that stop it running script.
// With `truncate`, a body over `maxBytes` is cut short rather than refused, which is enough to read a page's <head>.
function get(url, { timeoutMs, lookup, maxBytes, truncate = false, redirects = MAX_REDIRECTS }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(target, {
      agent: false,
      lookup,
      rejectUnauthorized: false,
      headers: { 'user-agent': 'homepage-traefik icon lookup', accept: '*/*' },
    });
    const timer = setTimeout(() => req.destroy(new Error(`No response within ${timeoutMs} ms`)), timeoutMs);
    const settle = (fn, value) => {
      clearTimeout(timer);
      fn(value);
    };

    req.once('response', res => {
      res.on('error', err => settle(reject, err));
      const location = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && location) {
        req.destroy();
        const next = new URL(location, target);
        if (!redirects || next.hostname !== target.hostname || !/^https?:$/.test(next.protocol)) {
          settle(reject, httpError(res.statusCode));
        } else {
          settle(resolve, get(next.href, { timeoutMs, lookup, maxBytes, truncate, redirects: redirects - 1 }));
        }
        return;
      }
      if (res.statusCode !== 200) {
        req.destroy();
        settle(reject, httpError(res.statusCode));
        return;
      }
      const chunks = [];
      let size = 0;
      const done = () => settle(resolve, { url: target.href, type: res.headers['content-type'] || '', body: Buffer.concat(chunks) });
      res.on('data', chunk => {
        if (size > maxBytes) return;
        chunks.push(chunk.subarray(0, maxBytes - size));
        size += chunk.length;
        if (size <= maxBytes) return;
        if (truncate) {
          req.destroy();
          done();
        } else {
          req.destroy(new Error(`Larger than ${maxBytes} bytes`));
        }
      });
      res.once('end', done);
    });
    req.once('error', err => settle(reject, err));
    req.end();
  });
}

function decodeEntities(text) {
  return text.replace(/&(amp|quot|#39|apos|lt|gt);/g, (_, name) => ({ amp: '&', quot: '"', '#39': "'", apos: "'", lt: '<', gt: '>' })[name]);
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i'));
  return match ? decodeEntities(match[1] ?? match[2] ?? match[3]).trim() : null;
}

// The largest side listed in a sizes attribute, with "any" (a scalable icon) counting as large.
function largestSize(sizes) {
  if (/\bany\b/i.test(sizes || '')) return Infinity;
  return Math.max(0, ...[...(sizes || '').matchAll(/(\d+)x(\d+)/gi)].map(([, w]) => Number(w)));
}

// Icons the page links to, best first: SVG icons scale cleanly, apple-touch-icons are large PNGs, and other icons
// are tried largest first. Relative links are resolved against the page's <base>, if any, then the page itself.
function iconLinks(html, pageUrl) {
  const baseHref = attr(html.match(/<base\b[^>]*>/i)?.[0] || '', 'href');
  const base = baseHref && URL.canParse(baseHref, pageUrl) ? new URL(baseHref, pageUrl).href : pageUrl;
  const links = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(tag, 'rel') || '').toLowerCase().split(/\s+/);
    const href = attr(tag, 'href');
    if (!href || !URL.canParse(href, base)) continue;
    const url = new URL(href, base);
    if (!/^https?:$/.test(url.protocol)) continue;
    const svg = /svg/i.test(attr(tag, 'type') || '') || /\.svg$/i.test(url.pathname);
    let rank;
    if (rel.includes('icon') && svg) rank = 0;
    else if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) rank = 1;
    else if (rel.includes('icon')) rank = 2;
    else continue;
    links.push({ url: url.href, rank, size: largestSize(attr(tag, 'sizes')) });
  }
  return links.sort((a, b) => a.rank - b.rank || b.size - a.size).map(link => link.url);
}

// The type comes from the bytes rather than the Content-Type header, which is often missing or wrong for
// favicon.ico. Anything that isn't a known image format is refused, so an error page can't pass as an icon.
function sniffImage(body) {
  if (body.length < 4) return null;
  if (body.subarray(0, 8).equals(PNG)) return 'image/png';
  if (body[0] === 0 && body[1] === 0 && (body[2] === 1 || body[2] === 2) && body[3] === 0) return 'image/x-icon';
  if (body.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  if (body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const head = body.subarray(0, 4096).toString('utf8');
  if (/<svg[\s>]/i.test(head) && !/<html[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

// The icon in `body`, or null when it isn't an image.
function iconOf(body) {
  const type = sniffImage(body);
  return type && { type, body, hash: crypto.createHash('sha1').update(body).digest('hex').slice(0, 12) };
}

// Looks for a route's icon the way a browser would: the icons its page links to, then /favicon.ico.
// Resolves to { type, body, hash }, or null when nothing usable was found.
async function findIcon(pageUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, address, lookup } = {}) {
  const opts = { timeoutMs, lookup: lookupFor({ address, lookup }) };
  let candidates = [];
  try {
    const page = await get(pageUrl, { ...opts, maxBytes: MAX_PAGE_BYTES, truncate: true });
    if (/html/i.test(page.type)) candidates = iconLinks(page.body.toString('utf8'), page.url).slice(0, MAX_LINKED_ICONS);
  } catch (err) {
    // No response at all means /favicon.ico won't get one either; an HTTP error page may still have a favicon beside it.
    if (!err.status) return null;
  }
  candidates.push(new URL('/favicon.ico', pageUrl).href);

  for (const url of new Set(candidates)) {
    try {
      const icon = iconOf((await get(url, { ...opts, maxBytes: MAX_ICON_BYTES })).body);
      if (icon) return icon;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function isReachable(route) {
  return isCheckable(route) && route.health?.reachable && route.health.statusCode < 500;
}

// Icons saved by `serialize`, keyed by route id. The saved file is only a cache, so entries that aren't an image
// are dropped rather than reported, and each icon's type and hash come from its bytes, not the file.
function parseSavedIcons(text) {
  // An empty file (say, one just created with touch so it can be mounted) means no icons yet.
  if (!text.trim()) return new Map();
  const doc = JSON.parse(text);
  const entries = doc && typeof doc === 'object' && !Array.isArray(doc) ? Object.entries(doc) : [];
  const saved = new Map();
  for (const [id, entry] of entries) {
    if (typeof entry?.url !== 'string' || typeof entry.data !== 'string') continue;
    const checkedAt = Date.parse(entry.checkedAt);
    const body = Buffer.from(entry.data, 'base64');
    const icon = body.length <= MAX_ICON_BYTES && iconOf(body);
    if (icon && !Number.isNaN(checkedAt)) saved.set(id, { url: entry.url, checkedAt, icon });
  }
  return saved;
}

// Keeps the icon found for each route. A route is looked up once it's reachable, again when its URL changes,
// every `refreshMs` after an icon was found and every `retryMs` after none was. Lookups run in the background a
// few at a time, and a refresh that's already running is reused rather than started twice. `saved` holds icons
// from an earlier run, and `onChange` is told the id of each route whose icon is now a different one.
function createIconStore({
  find = findIcon,
  options = {},
  refreshMs = 24 * HOUR_MS,
  retryMs = HOUR_MS,
  concurrency = DEFAULT_CONCURRENCY,
  now = Date.now,
  saved = new Map(),
  onChange = () => {},
} = {}) {
  const entries = new Map(saved);
  let running = null;

  // Sets or removes one route's entry, and says whether that changed what `serialize` returns.
  function set(id, entry) {
    const before = entries.get(id);
    if (entry) entries.set(id, entry);
    else entries.delete(id);
    if (before?.icon?.hash !== entry?.icon?.hash) onChange(id);
    return Boolean(before?.icon || entry?.icon);
  }

  function isDue(route) {
    const entry = entries.get(route.id);
    if (!entry || entry.url !== route.url) return true;
    return now() - entry.checkedAt >= (entry.icon ? refreshMs : retryMs);
  }

  // `routes` is every route the page lists; icons of routes that aren't in it are forgotten. Resolves to whether
  // the icons worth saving changed.
  async function refresh(routes) {
    if (running) return running;
    running = (async () => {
      let changed = false;
      const ids = new Set(routes.map(route => route.id));
      for (const id of [...entries.keys()]) if (!ids.has(id)) changed = set(id, null) || changed;

      const due = routes.filter(route => isReachable(route) && isDue(route));
      await mapLimit(due, concurrency, async route => {
        const previous = entries.get(route.id);
        const icon = await find(route.url, options).catch(() => null);
        // A route that briefly fails keeps the icon it had, as long as its URL is the same.
        const kept = icon || (previous?.url === route.url ? previous.icon : null);
        changed = set(route.id, { url: route.url, checkedAt: now(), icon: kept }) || changed;
      });
      return changed;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  function get(id) {
    return entries.get(id)?.icon || null;
  }

  // The icons found so far as JSON, with each image base64-encoded. Routes with no icon are left out, so they're
  // looked up again after a restart.
  function serialize() {
    const saved = [...entries].filter(([, entry]) => entry.icon).map(([id, { url, checkedAt, icon }]) => (
      [id, { url, checkedAt: new Date(checkedAt).toISOString(), data: icon.body.toString('base64') }]
    ));
    return `${JSON.stringify(Object.fromEntries(saved), null, 2)}\n`;
  }

  return { refresh, get, serialize };
}

module.exports = { findIcon, iconLinks, sniffImage, parseSavedIcons, createIconStore };
