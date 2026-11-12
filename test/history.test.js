const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createHistory, parseSavedHistory, capacityFor } = require('../src/history');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2026-01-02T12:10:00Z');

const up = (at, latencyMs = 40) => ({ reachable: true, statusCode: 200, latencyMs, checkedAt: new Date(at).toISOString() });
const down = at => ({ reachable: false, statusCode: null, latencyMs: null, error: 'ECONNREFUSED', checkedAt: new Date(at).toISOString() });

function historyAt(now = NOW, options = {}) {
  return createHistory({ intervalMs: MINUTE, now: () => now, ...options });
}

describe('history summary', () => {
  it('counts the checks of the last day and the share that answered', () => {
    const history = historyAt();
    history.record('a', 'https://a.test', up(NOW - 3 * MINUTE));
    history.record('a', 'https://a.test', down(NOW - 2 * MINUTE));
    history.record('a', 'https://a.test', up(NOW - 1 * MINUTE));
    history.record('a', 'https://a.test', up(NOW));

    const { checks, down: failed, uptime } = history.summary('a');

    assert.deepEqual({ checks, failed, uptime }, { checks: 4, failed: 1, uptime: 0.75 });
  });

  it('averages the latency of the checks that answered only', () => {
    const history = historyAt();
    history.record('a', 'https://a.test', up(NOW - 2 * MINUTE, 20));
    history.record('a', 'https://a.test', down(NOW - MINUTE));
    history.record('a', 'https://a.test', up(NOW, 60));

    assert.equal(history.summary('a').latencyMs, 40);
  });

  it('counts Traefik\'s own 404 as a warning, not a failure', () => {
    const history = historyAt();
    history.record('a', 'https://a.test', { ...up(NOW), statusCode: 404, unrouted: true });

    const { warn, down: failed, uptime } = history.summary('a');

    assert.deepEqual({ warn, failed, uptime }, { warn: 1, failed: 0, uptime: 1 });
  });

  it('counts a 5xx as a failure', () => {
    const history = historyAt();
    history.record('a', 'https://a.test', { ...up(NOW), statusCode: 503 });

    assert.equal(history.summary('a').down, 1);
  });

  it('counts a status the route\'s health settings don\'t count as up as a failure', () => {
    const history = historyAt();
    history.record('a', 'https://a.test', { ...up(NOW), statusCode: 302, unexpected: true });
    assert.equal(history.summary('a').down, 1);
  });

  it('splits the day into 48 half hours on the clock, the last being the one under way', () => {
    const summary = historyAt().summary('a');

    assert.equal(summary.buckets.length, 48);
    assert.equal(summary.bucketMinutes, 30);
    assert.equal(summary.buckets.at(-1).start, '2026-01-02T12:00:00.000Z');
    assert.equal(summary.buckets[0].start, '2026-01-01T12:30:00.000Z');
  });

  it('puts each check in its half hour', () => {
    const history = historyAt();
    history.record('a', 'https://a.test', down(Date.parse('2026-01-02T03:10:00Z')));
    history.record('a', 'https://a.test', up(Date.parse('2026-01-02T03:20:00Z')));

    const bucket = history.summary('a').buckets.find(b => b.start === '2026-01-02T03:00:00.000Z');

    assert.deepEqual(bucket, { start: '2026-01-02T03:00:00.000Z', checks: 2, warn: 0, down: 1 });
  });

  it('leaves out checks from before the day began', () => {
    const history = historyAt();
    history.record('a', 'https://a.test', down(NOW - 25 * HOUR));
    history.record('a', 'https://a.test', up(NOW));

    const { checks, since } = history.summary('a');

    assert.deepEqual({ checks, since }, { checks: 1, since: new Date(NOW).toISOString() });
  });

  it('says there were no checks for a route it hasn\'t seen', () => {
    const { checks, uptime, latencyMs, since } = historyAt().summary('nope');

    assert.deepEqual({ checks, uptime, latencyMs, since }, { checks: 0, uptime: null, latencyMs: null, since: null });
  });

  it('has no latency when every check failed', () => {
    const history = historyAt();
    history.record('a', 'https://a.test', down(NOW));

    assert.equal(history.summary('a').latencyMs, null);
  });

  it('starts afresh when a route\'s URL changes', () => {
    const history = historyAt();
    history.record('a', 'https://old.test', down(NOW - MINUTE));
    history.record('a', 'https://new.test', up(NOW));

    assert.equal(history.summary('a').checks, 1);
  });

  it('dates a check without a time by the clock', () => {
    const history = historyAt();
    history.record('a', 'https://a.test', { reachable: true, statusCode: 200 });

    assert.equal(history.summary('a').since, new Date(Math.floor(NOW / 1000) * 1000).toISOString());
  });

  it('ignores a check whose time doesn\'t parse', () => {
    const history = historyAt();
    history.record('a', 'https://a.test', { ...up(NOW), checkedAt: 'whenever' });

    assert.equal(history.summary('a').checks, 0);
  });

  it('keeps only the newest checks once a route\'s buffer is full', () => {
    const history = createHistory({ intervalMs: HOUR, now: () => NOW });
    const capacity = capacityFor(HOUR);
    for (let i = capacity; i >= 0; i--) history.record('a', 'https://a.test', i === capacity ? down(NOW - i * 1000) : up(NOW - i * 1000));

    const { checks, down: failed } = history.summary('a');

    assert.deepEqual({ checks, failed }, { checks: capacity, failed: 0 });
  });
});

// Pruning only frees memory, so these look back from the original time after pruning later on: a forgotten route
// then has no checks to show.
describe('history pruning', () => {
  function prunedAfter(ms) {
    let now = NOW;
    const history = createHistory({ intervalMs: MINUTE, now: () => now });
    history.record('a', 'https://a.test', up(NOW));
    now = NOW + ms;
    history.prune();
    now = NOW;
    return history.summary('a').checks;
  }

  it('forgets a route with no check in the last day', () => {
    assert.equal(prunedAfter(25 * HOUR), 0);
  });

  it('keeps a route checked within the day, even if Traefik isn\'t serving it right now', () => {
    assert.equal(prunedAfter(23 * HOUR), 1);
  });
});

describe('capacityFor', () => {
  it('has room for a day of checks at the interval and some to spare', () => {
    assert.ok(capacityFor(MINUTE) >= 1440);
    assert.ok(capacityFor(MINUTE) < 1700);
  });

  it('treats an interval under a second as a second', () => {
    assert.equal(capacityFor(0), capacityFor(1000));
  });
});

describe('saving history', () => {
  it('reads back what it saved', () => {
    const before = historyAt();
    before.record('a', 'https://a.test', up(NOW - MINUTE, 25));
    before.record('a', 'https://a.test', down(NOW));

    const after = historyAt(NOW, { saved: parseSavedHistory(before.serialize()) });

    assert.deepEqual(after.summary('a'), before.summary('a'));
  });

  it('leaves out routes with no check in the last day', () => {
    const history = historyAt();
    history.record('a', 'https://a.test', up(NOW - 25 * HOUR));

    assert.deepEqual(JSON.parse(history.serialize()).routes, {});
  });

  it('keeps the newest saved checks when they don\'t all fit', () => {
    const before = createHistory({ intervalMs: MINUTE, now: () => NOW });
    before.record('a', 'https://a.test', down(NOW - 2 * HOUR));
    for (let i = 0; i < capacityFor(HOUR); i++) before.record('a', 'https://a.test', up(NOW - i * 1000));

    const after = createHistory({ intervalMs: HOUR, now: () => NOW, saved: parseSavedHistory(before.serialize()) });

    assert.equal(after.summary('a').down, 0);
  });

  it('skips saved checks with an outcome it doesn\'t know', () => {
    const checks = Buffer.alloc(7);
    checks.writeUInt32LE(NOW / 1000, 0);
    checks.writeUInt8(9, 6);
    const saved = parseSavedHistory(JSON.stringify({ routes: { a: { url: 'https://a.test', checks: checks.toString('base64') } } }));

    assert.equal(historyAt(NOW, { saved }).summary('a').checks, 0);
  });
});

describe('parseSavedHistory', () => {
  it('reads an empty file as no history', () => {
    assert.equal(parseSavedHistory('  \n').size, 0);
  });

  it('throws on a file that isn\'t JSON', () => {
    assert.throws(() => parseSavedHistory('{'), SyntaxError);
  });

  it('reads a file without routes as no history', () => {
    assert.equal(parseSavedHistory('{"routes": []}').size, 0);
  });

  it('drops entries that don\'t make sense', () => {
    const saved = parseSavedHistory(JSON.stringify({
      routes: {
        noUrl: { checks: '' },
        noChecks: { url: 'https://a.test' },
        partRecord: { url: 'https://a.test', checks: Buffer.alloc(5).toString('base64') },
        good: { url: 'https://a.test', checks: Buffer.alloc(14).toString('base64') },
      },
    }));

    assert.deepEqual([...saved.keys()], ['good']);
  });
});
