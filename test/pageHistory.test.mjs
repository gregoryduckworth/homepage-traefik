// What the details panel says about a route's last day. It runs in the browser, but needs nothing from it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bucketKind, bucketLabel, historyText, percent, stripLabel } from '../public/history.js';

const START = Date.parse('2026-01-01T12:30:00Z');
const HALF_HOUR = 30 * 60 * 1000;

// Times as the page shows them, in this machine's locale and time zone.
const time = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function bucket(index, fields = {}) {
  return { start: new Date(START + index * HALF_HOUR).toISOString(), checks: 0, warn: 0, down: 0, ...fields };
}

// A day's summary as the server sends it, with `fill` giving the counts of some half hours by index.
function summary({ fill = {}, since = START, latencyMs = 40 } = {}) {
  const buckets = Array.from({ length: 48 }, (_, i) => bucket(i, fill[i]));
  const checks = buckets.reduce((sum, b) => sum + b.checks, 0);
  const down = buckets.reduce((sum, b) => sum + b.down, 0);
  const warn = buckets.reduce((sum, b) => sum + b.warn, 0);
  return {
    since: checks ? new Date(since).toISOString() : null,
    checks,
    warn,
    down,
    uptime: checks ? (checks - down) / checks : null,
    latencyMs: checks > down ? latencyMs : null,
    bucketMinutes: 30,
    buckets,
  };
}

describe('percent', () => {
  for (const [uptime, expected] of [[1, '100%'], [0.9999, '99.9%'], [0.994, '99.4%'], [0.5, '50%'], [0, '0%']]) {
    it(`shows ${uptime} as ${expected}`, () => {
      assert.equal(percent(uptime), expected);
    });
  }
});

describe('bucketKind', () => {
  for (const [name, fields, expected] of [
    ['with no checks', {}, 'none'],
    ['where every check answered', { checks: 30 }, 'up'],
    ['where some checks failed', { checks: 30, down: 1 }, 'warn'],
    ['where some checks reached no router', { checks: 30, warn: 2 }, 'warn'],
    ['where every check failed', { checks: 30, down: 30 }, 'down'],
  ]) {
    it(`shows a half hour ${name} as ${expected}`, () => {
      assert.equal(bucketKind(bucket(0, fields)), expected);
    });
  }
});

describe('bucketLabel', () => {
  const when = `${time(START)} to ${time(START + HALF_HOUR)}`;

  it('says when a half hour had no checks', () => {
    assert.equal(bucketLabel(bucket(0), 30), `${when}: no checks`);
  });

  it('says when every check answered', () => {
    assert.equal(bucketLabel(bucket(0, { checks: 30 }), 30), `${when}: 30 checks, all answered`);
  });

  it('counts the failures and warnings', () => {
    assert.equal(bucketLabel(bucket(0, { checks: 30, down: 2, warn: 1 }), 30), `${when}: 30 checks, 2 failed, 1 reached no router`);
  });

  it('says "check" for a single check', () => {
    assert.equal(bucketLabel(bucket(0, { checks: 1 }), 30), `${when}: 1 check, all answered`);
  });
});

describe('historyText', () => {
  it('says there have been no checks yet', () => {
    assert.deepEqual(historyText(summary()), { headline: 'No checks in the last 24 hours yet', detail: null });
  });

  it('gives the uptime over the day and how many checks failed', () => {
    const text = historyText(summary({ fill: { 0: { checks: 1000 }, 47: { checks: 438, down: 2 } } }));
    assert.deepEqual(text, { headline: '99.8% up over the last 24 hours', detail: `2 of ${(1438).toLocaleString()} checks failed. Average response 40 ms.` });
  });

  it('says none failed when every check answered', () => {
    assert.equal(historyText(summary({ fill: { 0: { checks: 2 } } })).detail, '2 checks, none failed. Average response 40 ms.');
  });

  it('counts checks that reached no router', () => {
    assert.equal(historyText(summary({ fill: { 0: { checks: 2, warn: 1 } } })).detail, '2 checks, none failed. 1 check reached Traefik but no router. Average response 40 ms.');
  });

  it('leaves out the latency when every check failed', () => {
    assert.equal(historyText(summary({ fill: { 0: { checks: 2, down: 2 } } })).detail, '2 of 2 checks failed.');
  });

  it('says when a history shorter than the day starts', () => {
    const since = START + 40 * HALF_HOUR;
    assert.equal(historyText(summary({ fill: { 40: { checks: 5 } }, since })).headline, `100% up since ${time(since)}`);
  });
});

describe('stripLabel', () => {
  const range = (from, to) => `${time(START + from * HALF_HOUR)} to ${time(START + to * HALF_HOUR)}`;

  it('says there have been no checks yet', () => {
    assert.equal(stripLabel(summary()), 'No checks yet');
  });

  it('says when no checks failed', () => {
    assert.equal(stripLabel(summary({ fill: { 0: { checks: 30, warn: 1 } } })), 'No checks failed in the last 24 hours');
  });

  it('runs neighbouring half hours with failures together', () => {
    const label = stripLabel(summary({ fill: { 3: { checks: 30, down: 1 }, 4: { checks: 30, down: 30 }, 10: { checks: 30, down: 2 } } }));
    assert.equal(label, `Checks failed ${range(3, 5)} and ${range(10, 11)}`);
  });

  it('lists a single period on its own', () => {
    assert.equal(stripLabel(summary({ fill: { 3: { checks: 30, down: 1 } } })), `Checks failed ${range(3, 4)}`);
  });

  it('counts the periods after the first four', () => {
    const fill = Object.fromEntries([0, 2, 4, 6, 8, 10].map(i => [i, { checks: 30, down: 1 }]));
    assert.equal(stripLabel(summary({ fill })), `Checks failed ${range(0, 1)}, ${range(2, 3)}, ${range(4, 5)}, ${range(6, 7)} and 2 other periods`);
  });
});
