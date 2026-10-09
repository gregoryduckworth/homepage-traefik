// Resolves to the server's reply, or throws with the reason it gives for refusing the change.
export async function putJson(url, body) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const reply = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(reply.error || `The homepage server responded with HTTP ${res.status}`);
  return reply;
}
