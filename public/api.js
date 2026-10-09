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

export function post(url) {
  return send(url, { method: 'POST' });
}
