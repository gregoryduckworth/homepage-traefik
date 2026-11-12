// What the details panel says about how a route has done over the last day, worked out from the server's summary
// (GET /api/history/<router name>).

// How many periods with failures the strip's description lists before it just counts the rest.
const LISTED_PERIODS = 4;

function count(n, one, many = `${one}s`) {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

function timeOf(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Rounded down, so a route that failed even one check never shows as 100%.
export function percent(uptime) {
  const tenths = Math.floor(uptime * 1000) / 10;
  return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)}%`;
}

// A half hour's segment on the strip: all its checks failed, some failed or reached Traefik but no router, all
// answered, or there were none.
export function bucketKind(bucket) {
  if (!bucket.checks) return 'none';
  if (bucket.down === bucket.checks) return 'down';
  if (bucket.down || bucket.warn) return 'warn';
  return 'up';
}

function bucketRange(bucket, minutes) {
  const start = Date.parse(bucket.start);
  return [start, start + minutes * 60000];
}

// The tooltip for a half hour's segment, such as "03:00 to 03:30: 30 checks, 2 failed".
export function bucketLabel(bucket, minutes) {
  const [start, end] = bucketRange(bucket, minutes);
  const when = `${timeOf(start)} to ${timeOf(end)}`;
  if (!bucket.checks) return `${when}: no checks`;
  const problems = [bucket.down && `${bucket.down.toLocaleString()} failed`, bucket.warn && `${bucket.warn.toLocaleString()} reached no router`].filter(Boolean);
  return `${when}: ${count(bucket.checks, 'check')}${problems.length ? `, ${problems.join(', ')}` : ', all answered'}`;
}

// The headline and the line of counts under it, such as "99.4% up over the last 24 hours" and "2 of 1,438 checks
// failed. Average response 45 ms." A history shorter than the day, as after a restart, says when it starts.
export function historyText(summary) {
  if (!summary.checks) return { headline: 'No checks in the last 24 hours yet', detail: null };
  const since = Date.parse(summary.since);
  const windowStart = Date.parse(summary.buckets[0].start);
  const span = since - windowStart > summary.bucketMinutes * 60000 ? `since ${timeOf(since)}` : 'over the last 24 hours';
  const failed = summary.down
    ? `${summary.down.toLocaleString()} of ${count(summary.checks, 'check')} failed.`
    : `${count(summary.checks, 'check')}, none failed.`;
  const warned = summary.warn ? ` ${count(summary.warn, 'check')} reached Traefik but no router.` : '';
  const latency = summary.latencyMs == null ? '' : ` Average response ${summary.latencyMs.toLocaleString()} ms.`;
  return { headline: `${percent(summary.uptime)} up ${span}`, detail: `${failed}${warned}${latency}` };
}

// The strip's description for screen readers, which can't hover its segments: when checks failed, with neighbouring
// half hours run together, such as "Checks failed 03:00 to 04:00 and 14:30 to 15:00".
export function stripLabel(summary) {
  if (!summary.checks) return 'No checks yet';
  const periods = [];
  for (const bucket of summary.buckets) {
    if (!bucket.down) continue;
    const [start, end] = bucketRange(bucket, summary.bucketMinutes);
    const last = periods.at(-1);
    if (last && last.end === start) last.end = end;
    else periods.push({ start, end });
  }
  if (!periods.length) return 'No checks failed in the last 24 hours';
  const listed = periods.slice(0, LISTED_PERIODS).map(({ start, end }) => `${timeOf(start)} to ${timeOf(end)}`);
  const more = periods.length - listed.length;
  if (more) listed.push(count(more, 'other period'));
  const list = listed.length > 1 ? `${listed.slice(0, -1).join(', ')} and ${listed.at(-1)}` : listed[0];
  return `Checks failed ${list}`;
}
