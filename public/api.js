// Resolves to the server's reply, or throws with the reason it gives for refusing the request.
async function send(url, init) {
  const res = await fetch(url, init);
  const reply = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(reply.error || `The homepage server responded with HTTP ${res.status}`);
  return reply;
}

export function putJson(url, body) {
  return send(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// Sent as JSON, which the server requires so that other sites can't send it.
export function post(url) {
  return send(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

// Wraps `task` so that when calls overlap, an older one that finishes after a newer one is dropped, as is one that
// finishes after a newer one failed. Each call resolves to { value } or { error }, or to null when it was dropped.
export function newestOnly(task) {
  let started = 0;
  let settled = 0;
  return async () => {
    const call = ++started;
    const outcome = await task().then(value => ({ value }), error => ({ error }));
    if (call < settled) return null;
    settled = call;
    return outcome;
  };
}
