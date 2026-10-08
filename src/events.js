// Tells open pages that something they show has changed, over server-sent events, so they fetch it straight away
// instead of waiting for their next poll. The message carries no data: pages reload everything from /api/routes.
// Changes that come close together, such as a batch of icon lookups, are sent as one message. A comment is sent
// now and then so proxies don't close a quiet connection.
function createEvents({ delayMs = 250, heartbeatMs = 30000 } = {}) {
  const clients = new Set();
  let pending = null;
  const heartbeat = setInterval(() => send(': ping\n\n'), heartbeatMs).unref();

  function send(text) {
    for (const res of clients) res.write(text);
  }

  function handle(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.write('retry: 5000\n\n');
    clients.add(res);
    res.on('close', () => clients.delete(res));
  }

  function notify() {
    pending ??= setTimeout(() => {
      pending = null;
      send('data: change\n\n');
    }, delayMs);
  }

  // Ends every stream, so the server can close without waiting for pages to go away.
  function close() {
    clearInterval(heartbeat);
    clearTimeout(pending);
    pending = null;
    for (const res of clients) res.end();
    clients.clear();
  }

  return { handle, notify, close };
}

module.exports = { createEvents };
