const RECONNECT_MS = 5000;

// The server says when something on the page has changed, such as a new icon or health check, so it shows up
// straight away. The poll stays as a fallback for when the messages don't get through. A tab in the background
// stops listening, which also keeps it from holding one of the browser's few connections to the server, and
// catches up as soon as it's shown again.
let changes = null;

// Changes made while the stream is down aren't sent again, so the page fetches everything once it's back. The
// browser reconnects by itself after a network error, but gives up for good when the server answers with anything
// other than an event stream, such as Traefik's 502 or 404 while the homepage container restarts. Then a new
// stream is started a little later instead.
function listen(onChange, catchUp = false) {
  if (changes || document.hidden || !window.EventSource) return;
  const source = new EventSource('api/events');
  changes = source;
  source.addEventListener('message', onChange);
  if (catchUp) source.addEventListener('open', onChange, { once: true });
  source.addEventListener('error', () => {
    if (changes !== source) return;
    if (source.readyState === EventSource.CLOSED) {
      changes = null;
      setTimeout(() => listen(onChange, true), RECONNECT_MS);
    } else {
      source.addEventListener('open', onChange, { once: true });
    }
  });
}

// Calls `onChange` whenever the server says something changed, and when a tab in the background is shown again.
export function watchChanges(onChange) {
  listen(onChange);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      changes?.close();
      changes = null;
    } else {
      listen(onChange);
      onChange();
    }
  });
}
