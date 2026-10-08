# homepage-traefik

A small homepage that lists every route Traefik is serving. It reads routers from the Traefik API (`/api/http/routers`), turns each `Host(...)` rule into a link, and groups the links by entrypoint. When you add a container with Traefik labels, it shows up on the page within one poll interval. There is nothing to configure per service, though you can drag routes into your own groups (see [Groups](#groups)).

The app is a single Node.js process with no runtime dependencies.

## Quick start with Docker Compose

```sh
touch homepage.json
docker compose up -d
```

`homepage.json` is where the groups you make on the page are saved (see [Groups](#groups)). Then open <http://home.localhost>. The example `docker-compose.yml` starts Traefik, this homepage, and a `whoami` demo service, so you should see both `home.localhost` and `whoami.localhost` listed.

## Using the pre-built Docker image

A pre-built image is published to GitHub Container Registry on every push to `main`. You can pull it directly instead of building from source:

```sh
docker pull ghcr.io/gregoryduckworth/homepage-traefik:main
```

Tagged releases are also available (e.g. `ghcr.io/gregoryduckworth/homepage-traefik:1.0.0`).

To use the pre-built image in a Docker Compose file, replace the `build` directive with `image`:

```yaml
services:
  homepage:
    image: ghcr.io/gregoryduckworth/homepage-traefik:main
    environment:
      TRAEFIK_API_URL: http://traefik:8080
      HOMEPAGE_TITLE: Home lab
    volumes:
      - ./homepage.json:/app/config/homepage.json
    labels:
      - traefik.enable=true
      - traefik.http.routers.homepage.rule=Host(`home.example.com`)
      - traefik.http.services.homepage.loadbalancer.server.port=3000
```

## Adding it to an existing Traefik setup

The homepage needs network access to the Traefik API. Enable the API in Traefik with either of these:

- `--api.insecure=true`, which serves the API on port 8080 of the Traefik container, or
- `--api=true` with a router for `api@internal` on an entrypoint the homepage can reach. If you go this way, don't put authentication middleware in front of that path.

Then add the homepage to the same Docker network as Traefik:

```yaml
services:
  homepage:
    image: ghcr.io/gregoryduckworth/homepage-traefik:main
    environment:
      TRAEFIK_API_URL: http://traefik:8080
    labels:
      - traefik.enable=true
      - traefik.http.routers.homepage.rule=Host(`home.example.com`)
      - traefik.http.services.homepage.loadbalancer.server.port=3000
```

## Configuration

| Variable                       | Default                | Description                                                                                                       |
| ------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `TRAEFIK_API_URL`              | `http://traefik:8080`  | Base URL of the Traefik API                                                                                       |
| `POLL_INTERVAL_SECONDS`        | `30`                   | How often the server refreshes routes from Traefik (at least 5)                                                   |
| `HEALTHCHECK_INTERVAL_SECONDS` | `60`                   | How often each route gets a health check (at least 10; see below)                                                 |
| `HEALTHCHECK_TIMEOUT_SECONDS`  | `10`                   | How long each health check request may take                                                                       |
| `HEALTHCHECK_ADDRESS`          | (unset)                | Host or IP to send health checks to instead of resolving each route's hostname, for example `traefik` (see below) |
| `HOMEPAGE_TITLE`               | `Routes`               | Heading and browser tab title                                                                                     |
| `CONFIG_FILE`                  | `config/homepage.json` | JSON file that stores your groups and the latest health checks (`/app/config/homepage.json` in the image)         |
| `PORT`                         | `3000`                 | Port the homepage listens on                                                                                      |

## What gets shown

- Traefik's own `@internal` routers (API, dashboard) are hidden.
- A router's link is the first `Host` in its rule, plus any `Path`/`PathPrefix`. Routers with TLS link to `https://`.
- When an HTTP router and an HTTPS router serve the same host and path (the usual redirect setup), only the HTTPS one is listed.
- Routers without a `Host` rule (for example `HostRegexp` or path-only rules) are listed without a link.
- Disabled routers, and routers that have warnings, are marked as such.
- Each enabled route with a link gets a live status, and a strip at the top shows every route's status at a glance. The server sends a `HEAD` request to the route's URL, at most 8 at a time, each on a fresh connection. Each route is checked once every `HEALTHCHECK_INTERVAL_SECONDS`, on the first Traefik poll after its last check is that old, so lower `POLL_INTERVAL_SECONDS` doesn't mean more checks. A route that's new, or whose URL changed, is checked on the next poll. The latest result for each route is saved in the groups file (see [Groups](#groups)), so after a restart the page shows it straight away and the route isn't checked again until its interval is up:
  - Any HTTP response below 500 shows as **Up**, with its response time.
  - If `HEAD` gets a 5xx, times out or has its connection reset, the check is tried once more with `GET`, because some apps don't answer `HEAD` properly. A 5xx from that `GET` shows its status code.
  - A request that fails shows why: **Timed out** (no response within `HEALTHCHECK_TIMEOUT_SECONDS`), **DNS failed**, **Refused**, **Unreachable** (no network route to the host), **Reset** (the connection was closed before a response), **Certificate error** (the certificate isn't trusted, has expired or doesn't match the host), **TLS error** (the TLS handshake failed, for example HTTPS sent to a plain HTTP port), or **Down** for anything else.
  - The details panel explains the failure in a sentence, including how far the request got: for example "Couldn't open a connection to 203.0.113.7:443 within 10 seconds" or "Connected to 172.18.0.2:443, but it didn't send a response within 10 seconds". It also shows the address that was used, whether `GET` was needed, and the error code. Hovering over a red segment in the strip shows the same sentence.
- Each route has an info button that opens a details panel. It shows the route's status, the last health check (result, error code and when it ran), Traefik's own status and any error messages Traefik reports for the router, and the router's rule, service, entry points, middlewares, TLS certificate resolver and priority.
- The checks run from the homepage container, so its DNS must resolve your route hostnames, and the container must be able to reach the address they resolve to. Two common setups break this: `*.localhost` hosts resolve to the container itself, and public hostnames often resolve to your router's public IP, which many routers won't loop back to from inside the network. Both show up as **Timed out** or **Refused** even though the site works in your browser. To fix either, set `HEALTHCHECK_ADDRESS` to your Traefik container's name (for example `traefik`, if the homepage shares a Docker network with it). Checks then connect to Traefik directly, on the route's own port (80 or 443), while still sending the route's hostname so Traefik serves the right router. This works when Traefik's entrypoints listen on 80 and 443 inside the container. Node does not trust self-signed certificates, Traefik's default certificate or private CAs, so HTTPS routes using them show **Certificate error** even when they work in your browser.
- A browser tab that's in the background stops asking the server for updates and catches up when you switch back to it.
- The page has light and dark themes. It follows your system setting until you pick one with the toggle.
- If Traefik can't be reached, the page keeps showing the last routes it loaded and explains what went wrong.

## Groups

By default routes are grouped by entrypoint. To make your own groups, select **New group**, name it, then drag routes onto it. Dropping a route on another route in a group puts it in front of that one, so you can also reorder routes this way. To take a route out of its group, drag it onto an entrypoint group or onto the box that appears at the bottom of the page while you drag. Each group heading has buttons to rename or delete it. Deleting a group sends its routes back to their entrypoint groups.

You can also move a route from its details panel by choosing a group in the **Group** menu. This works with a keyboard and on phones, where drag and drop can be unreliable.

Groups are saved on the server, so everyone who opens the page sees the same layout. They are stored in a JSON file (`CONFIG_FILE`) that you can also edit by hand:

```json
{
  "groups": [
    { "name": "Media", "routes": ["jellyfin@docker", "sonarr@docker"] },
    { "name": "Monitoring", "routes": ["grafana@docker"] }
  ]
}
```

- Groups appear in the order they are listed, above the entrypoint groups, and routes appear in the order they are listed within each group.
- A route is identified by its Traefik router name, shown as **Router** in its details panel. If a route is in more than one group, only the first one counts.
- Routes that Traefik isn't serving right now stay in the file and return to their group when they come back.
- The server also keeps the latest health check of each route in the file, under `health`. It rewrites that section after each round of checks (once per `HEALTHCHECK_INTERVAL_SECONDS` at most, or when routes are added or removed), and leaves `groups` and anything else in the file as it is. You don't need to edit it; deleting it just means every route is checked again on the next poll.
- The page picks up changes to the file within one refresh, without a restart. If the file isn't valid, the page says why and keeps showing the last groups it loaded, and changes from the page are refused until the file is fixed.

Anyone who can open the homepage can change the groups.

### Keeping the file with your Compose project

Mount the file into the container so it survives rebuilds and lives next to your `docker-compose.yml`, where you can back it up, commit it or copy it to another machine:

```yaml
    volumes:
      - ./homepage.json:/app/config/homepage.json
```

- Create the file before the first `docker compose up`. An empty file is fine (`touch homepage.json`), and so is one you've copied from another setup. If the file doesn't exist, Docker creates a directory with that name instead, and the page tells you to replace it with a file. The same happens on Docker Desktop or Colima if the file is in a folder they don't share with Docker; both share your home folder by default.
- The container runs as the `node` user (UID 1000), which needs to be able to write the file. If your host user has a different UID, run `chmod a+w homepage.json`, or set `user:` on the service to your own UID.
- Some editors save by replacing the file rather than rewriting it, and a container keeps seeing the old one until it's recreated. If a hand edit doesn't show up, run `docker compose up -d --force-recreate homepage`.

If you'd rather not keep the file in your project, mount a named volume on the whole directory instead (`homepage-config:/app/config`). Docker then creates the file for you.

## API

The server also exposes `GET /api/routes` (the normalized route list, your groups and any config file error as JSON), `PUT /api/groups` (replaces the groups; send `{"groups": [...]}` as `application/json`) and `GET /healthz`.

## Development

Requires Node.js 20 or newer.

```sh
TRAEFIK_API_URL=http://localhost:8080 npm run dev
npm test
```
