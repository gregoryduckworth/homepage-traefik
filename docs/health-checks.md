# Health checks

Each enabled route with a link is checked once per `HEALTHCHECK_INTERVAL_SECONDS` with a `HEAD` request to the address it links to, retried once with `GET` if that fails with a 5xx, a timeout or a reset. A route's own settings can check another path, count only some status codes as up, or turn its check off (see [Changing how a route is checked](#changing-how-a-route-is-checked)).

Checks run when Traefik is polled, so the interval is rounded up to a whole number of polls: with the defaults (`POLL_INTERVAL_SECONDS=30`, `HEALTHCHECK_INTERVAL_SECONDS=60`) each route is checked every 60 seconds, and a 45-second interval also works out at every 60 seconds. The latest results are only kept in memory, so after a restart routes show as **Checking** until the first checks finish, a few seconds later.

A strip across the top shows every route at a glance, and the info button on each route opens a details panel. The panel shows how the route has done over the last 24 hours: the share of checks that didn't fail, how many did, its average response time, and a strip of half hours, green where every check answered, amber where some failed or reached Traefik but no router, red where all failed and grey where there were none. So a route that was down at 3am, or fails one check in five, stands out even when its latest check passed. Hover over a half hour to see its counts. The panel also explains a failure in a sentence, for example "Connected to 172.18.0.2:443, but it didn't send a response within 10 seconds". Select **Check now** in the panel to check the route and look up its icon straight away, say after fixing it, rather than waiting for the next check.

| Status                     | Meaning                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Up**                     | Any response below 500, with its response time                                                                                     |
| **No router**              | Traefik's own `404 page not found`: the check reached a Traefik, or an entry point, that doesn't serve this route                  |
| **HTTP 5xx**               | The route answered with a server error                                                                                             |
| **HTTP** and another code  | The route answered with a status its settings don't count as up                                                                    |
| **Not checked**            | The route's check is turned off in its settings                                                                                    |
| **Timed out**              | No response within `HEALTHCHECK_TIMEOUT_SECONDS`                                                                                   |
| **DNS failed**             | The hostname doesn't resolve from the homepage container                                                                           |
| **Refused** / **Reset**    | Nothing listening on the port / the connection closed before a response                                                            |
| **Unreachable**            | No network route to the host                                                                                                       |
| **Certificate error**      | The certificate isn't trusted, has expired or doesn't match. See below to trust your own CA or a self-signed certificate           |
| **TLS error** / **Down**   | The TLS handshake failed (for example HTTPS on a plain HTTP port) / anything else                                                  |

## Changing how a route is checked

Checking the address a route links to doesn't always show whether the service works. An app whose front page needs a login may redirect to a sign-in page, which counts as up even when the app behind it is broken; a backup target that only runs at night shows as down most of the day; and a request every minute may keep a disk or machine from going to sleep. For routes like these, open the route's details, select **Change settings**, and under **Health check**:

- **Path to check** requests that path on the route's host and port instead of the route's own address, such as `/health` or `/api/health`. It may have a query string, such as `/health?full=1`. The panel shows it as **Checked URL**.
- **Status codes that count as up** lists the only codes that do, such as `200, 204`, so a redirect to a sign-in page counts as down. Without any, every response below 500 counts as up. A 5xx always counts as down, so it can't be listed. When `HEAD` gets a code that doesn't count, it's tried once more with `GET`.
- Clearing **Check this route** stops the route being checked at all. It shows as **Not checked**, as a disabled router does, has no history and no **Check now**, and still counts towards the total in the summary but not as up. Its icon isn't looked up either, so it isn't woken that way: one already found is kept, or set one on the page. The path and codes are kept for when the check is turned back on.

A route whose settings change is checked again straight away, and its history starts afresh if the checked address changed. In `homepage.json` these settings are in the route's `health` (see [Saved settings](./saved-settings)). Traefik's API doesn't return container labels, so they can't be set with Docker labels.

**If everything times out or is refused but works in your browser:** the checks run from inside the homepage container. There, `*.localhost` resolves to the container itself, and public hostnames often resolve to an IP your router won't loop back to. Set `HEALTHCHECK_ADDRESS` to your Traefik container's name (for example `traefik`). Checks then connect straight to Traefik on the route's port, while still sending the route's hostname so Traefik picks the right router. This needs Traefik's entry points to listen on the same ports inside its container as the links use (80 and 443, or those in `ENTRYPOINT_PORTS`).

**If your routes use certificates from your own CA, or self-signed ones:** the checks only trust the public CAs Node ships with, so those routes show **Certificate error**. That includes a private CA such as step-ca, mkcert or Caddy's internal CA. Mount the CA's certificate (or the self-signed certificate itself) into the container and point `NODE_EXTRA_CA_CERTS` at it, then recreate the container:

```yaml
    environment:
      NODE_EXTRA_CA_CERTS: /certs/lab-ca.pem
    volumes:
      - ./lab-ca.pem:/certs/lab-ca.pem:ro
```

The file is in PEM format, starting with `-----BEGIN CERTIFICATE-----`, and can hold several certificates one after another. Node reads it once, when the container starts. Icon lookups don't check certificates, so they work either way.

