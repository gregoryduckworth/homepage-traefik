// Each route's checks over the last day, so the details panel can show overnight outages and flapping that the latest
// check alone hides. Every check is kept, in typed arrays rather than objects: seven bytes a check, about 10 KB a
// route at the default interval of a minute.

const DAY_MS = 24 * 60 * 60 * 1000;
const BUCKET_MS = 30 * 60 * 1000;
const BUCKETS = DAY_MS / BUCKET_MS;

// Each check is saved as a time in seconds (4 bytes), a latency in milliseconds (2 bytes) and an outcome (1 byte).
const RECORD_BYTES = 7;
const MAX_LATENCY_MS = 0xffff;
const UP = 0;
const WARN = 1;
const DOWN = 2;

// The same reading of a check as the page's: no response, a 5xx or a status the route's health settings don't count as
// up is down, and Traefik's own 404 is a warning, since the check may not have reached the route.
function outcomeOf(result) {
  if (!result.reachable || result.statusCode >= 500 || result.unexpected) return DOWN;
  return result.unrouted ? WARN : UP;
}

// Room for a day of checks at `intervalMs`, plus some for checks asked for on the page. Once a route's buffer is full
// each check replaces its oldest.
function capacityFor(intervalMs) {
  return Math.ceil((DAY_MS / Math.max(intervalMs, 1000)) * 1.1) + 64;
}

function createRing(capacity) {
  return { times: new Uint32Array(capacity), latencies: new Uint16Array(capacity), outcomes: new Uint8Array(capacity), next: 0, size: 0 };
}

function push(ring, seconds, outcome, latencyMs) {
  const capacity = ring.times.length;
  ring.times[ring.next] = seconds;
  ring.latencies[ring.next] = Math.min(Math.max(Math.round(latencyMs) || 0, 0), MAX_LATENCY_MS);
  ring.outcomes[ring.next] = outcome;
  ring.next = (ring.next + 1) % capacity;
  ring.size = Math.min(ring.size + 1, capacity);
}

// Calls `visit(seconds, outcome, latencyMs)` for each check in the ring, oldest first.
function each(ring, visit) {
  const capacity = ring.times.length;
  for (let i = 0; i < ring.size; i++) {
    const at = (ring.next - ring.size + i + capacity) % capacity;
    visit(ring.times[at], ring.outcomes[at], ring.latencies[at]);
  }
}

// The checks saved by `serialize`, keyed by route id, as { url, checks } with `checks` a Buffer of packed records.
// The file is only a cache, so entries that don't make sense are dropped rather than reported.
function parseSavedHistory(text) {
  // An empty file (say, one just created with touch so it can be mounted) means no history yet.
  if (!text.trim()) return new Map();
  const doc = JSON.parse(text);
  const routes = doc?.routes && typeof doc.routes === 'object' && !Array.isArray(doc.routes) ? Object.entries(doc.routes) : [];
  const saved = new Map();
  for (const [id, entry] of routes) {
    if (typeof entry?.url !== 'string' || typeof entry.checks !== 'string') continue;
    const checks = Buffer.from(entry.checks, 'base64');
    if (checks.length % RECORD_BYTES) continue;
    saved.set(id, { url: entry.url, checks });
  }
  return saved;
}

// `intervalMs` is how often each route is checked, which sets how many checks each route keeps. `saved` holds
// checks from an earlier run, as parseSavedHistory reads them. `now` is only replaced in tests.
function createHistory({ intervalMs = 60000, saved = new Map(), now = Date.now } = {}) {
  const capacity = capacityFor(intervalMs);
  // By route id: the URL checked, the checks, and the time of the newest, in seconds.
  const routes = new Map();

  function entryFor(id, url) {
    let entry = routes.get(id);
    // A route whose URL changes starts afresh, as its old checks were of somewhere else.
    if (!entry || entry.url !== url) {
      entry = { url, ring: createRing(capacity), newest: 0 };
      routes.set(id, entry);
    }
    return entry;
  }

  function add(entry, seconds, outcome, latencyMs) {
    push(entry.ring, seconds, outcome, latencyMs);
    entry.newest = Math.max(entry.newest, seconds);
  }

  for (const [id, { url, checks }] of saved) {
    const entry = entryFor(id, url);
    // Only as many as fit, newest last, so a smaller buffer keeps the latest checks.
    const first = Math.max(0, checks.length / RECORD_BYTES - capacity);
    for (let offset = first * RECORD_BYTES; offset < checks.length; offset += RECORD_BYTES) {
      const outcome = checks.readUInt8(offset + 6);
      if (outcome <= DOWN) add(entry, checks.readUInt32LE(offset), outcome, checks.readUInt16LE(offset + 4));
    }
  }

  // Records a health check of `url` for route `id`.
  function record(id, url, result) {
    const at = result.checkedAt ? Date.parse(result.checkedAt) : now();
    if (Number.isNaN(at)) return;
    add(entryFor(id, url), Math.floor(at / 1000), outcomeOf(result), result.latencyMs);
  }

  // Forgets routes with no check in the last day, so a route that's gone for good doesn't stay forever. A route
  // that's only missing for a moment, say while its container is recreated, keeps its history.
  function prune() {
    const cutoff = (now() - DAY_MS) / 1000;
    for (const [id, entry] of routes) {
      if (entry.newest < cutoff) routes.delete(id);
    }
  }

  // How route `id` has done over the last day: how many checks there were, how many failed or warned, the share
  // that didn't fail and the average latency of those that answered, plus the same counts for each half hour, oldest
  // first. Half hours start on the clock's half hours, and the last one is the one under way, so they don't shift
  // each time the panel is opened. `uptime` and `latencyMs` are null when there were no checks.
  function summary(id) {
    const end = (Math.floor(now() / BUCKET_MS) + 1) * BUCKET_MS;
    const start = end - DAY_MS;
    const buckets = Array.from({ length: BUCKETS }, (_, i) => ({ start: new Date(start + i * BUCKET_MS).toISOString(), checks: 0, warn: 0, down: 0 }));
    let checks = 0;
    let warn = 0;
    let down = 0;
    let latencyTotal = 0;
    let oldest = Infinity;
    const entry = routes.get(id);
    if (entry) {
      each(entry.ring, (seconds, outcome, latencyMs) => {
        const at = seconds * 1000;
        if (at < start || at >= end) return;
        const bucket = buckets[Math.floor((at - start) / BUCKET_MS)];
        bucket.checks++;
        checks++;
        oldest = Math.min(oldest, at);
        if (outcome === DOWN) {
          bucket.down++;
          down++;
          return;
        }
        if (outcome === WARN) {
          bucket.warn++;
          warn++;
        }
        latencyTotal += latencyMs;
      });
    }
    return {
      since: checks ? new Date(oldest).toISOString() : null,
      checks,
      warn,
      down,
      uptime: checks ? (checks - down) / checks : null,
      latencyMs: checks > down ? Math.round(latencyTotal / (checks - down)) : null,
      bucketMinutes: BUCKET_MS / 60000,
      buckets,
    };
  }

  // Every route's checks from the last day, for parseSavedHistory to read back after a restart. Records are packed
  // little-endian, so the file reads the same on any machine.
  function serialize() {
    prune();
    const saved = {};
    for (const [id, entry] of routes) {
      const checks = Buffer.alloc(entry.ring.size * RECORD_BYTES);
      let offset = 0;
      each(entry.ring, (seconds, outcome, latencyMs) => {
        checks.writeUInt32LE(seconds, offset);
        checks.writeUInt16LE(latencyMs, offset + 4);
        checks.writeUInt8(outcome, offset + 6);
        offset += RECORD_BYTES;
      });
      saved[id] = { url: entry.url, checks: checks.toString('base64') };
    }
    return `${JSON.stringify({ version: 1, routes: saved })}\n`;
  }

  return { record, prune, summary, serialize };
}

module.exports = { createHistory, parseSavedHistory, capacityFor };
