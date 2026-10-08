# homepage-traefik

A small homepage that lists every route Traefik is serving. It reads routers from the Traefik API (`/api/http/routers`), turns each `Host(...)` rule into a link named after its router, with the site's own icon, and groups the links by entrypoint. When you add a container with Traefik labels, it shows up on the page within one poll interval. There is nothing to configure per service, though you can rename routes, give them your own icons (see [Names and icons](#names-and-icons)) and drag them into your own groups (see [Groups](#groups)).

The app is a single Node.js process with no runtime dependencies.

![The homepage listing routes in two custom groups and one entrypoint group, with a status strip across the top and one route refused](docs/screenshot.png)

## Quick start with Docker Compose

```sh
touch homepage.json icons.json
docker compose up -d
```

`homepage.json` is where the groups you make on the page are saved (see [Groups](#groups)), and `icons.json` keeps the icons found on your sites (see [Names and icons](#names-and-icons)). Then open <http://home.localhost>. The example `docker-compose.yml` starts Traefik, this homepage, and a `whoami` demo service, so you should see both `home.localhost` and `whoami.localhost` listed.

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
      - ./icons.json:/app/config/icons.json
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
| `HEALTHCHECK_TIMEOUT_SECONDS`  | `10`                   | How long each health check and icon request may take (at least 1)                                                 |
| `HEALTHCHECK_ADDRESS`          | (unset)                | Host or IP to send health checks to instead of resolving each route's hostname, for example `traefik` (see below) |
| `HOMEPAGE_TITLE`               | `Routes`               | Heading and browser tab title                                                                                     |
| `CONFIG_FILE`                  | `config/homepage.json` | Stores your groups, names, icons and latest health checks (`/app/config/homepage.json` in the image)              |
| `PORT`                         | `3000`                 | Port the homepage listens on                                                                                      |

## What gets shown

- Traefik's own `@internal` routers (API, dashboard) are hidden.
- Each route is named after its Traefik router, without the `@provider` suffix (`jellyfin@docker` shows as **jellyfin**), with its address underneath. Routes in the entrypoint groups are listed by name. You can change the name and icon (see [Names and icons](#names-and-icons)).
- A router's link is the first `Host` in its rule, plus any `Path`/`PathPrefix`. Routers with TLS link to `https://`.
- When an HTTP router and an HTTPS router serve the same host and path (the usual redirect setup), only the HTTPS one is listed.
- Routers without a `Host` rule (for example `HostRegexp` or path-only rules) are listed without a link.
- Disabled routers, and routers that have warnings, are marked as such.
- Each enabled route with a link gets a live status, and a strip at the top shows every route's status at a glance. The server sends a `HEAD` request to the route's URL, at most 8 at a time, each on a fresh connection. Each route is checked once every `HEALTHCHECK_INTERVAL_SECONDS`, on the first Traefik poll after its last check is that old, so lower `POLL_INTERVAL_SECONDS` doesn't mean more checks. A route that's new, or whose URL changed, is checked on the next poll. The latest result for each route is saved in the groups file (see [Groups](#groups)), so after a restart the page shows it straight away and the route isn't checked again until its interval is up:
  - Any HTTP response below 500 shows as **Up**, with its response time.
  - If `HEAD` gets a 5xx, times out or has its connection reset, the check is tried once more with `GET`, because some apps don't answer `HEAD` properly. A 5xx from that `GET` shows its status code.
  - A request that fails shows why: **Timed out** (no response within `HEALTHCHECK_TIMEOUT_SECONDS`), **DNS failed**, **Refused**, **Unreachable** (no network route to the host), **Reset** (the connection was closed before a response), **Certificate error** (the certificate isn't trusted, has expired or doesn't match the host), **TLS error** (the TLS handshake failed, for example HTTPS sent to a plain HTTP port), or **Down** for anything else.
  - The details panel explains the failure in a sentence, including how far the request got: for example "Couldn't open a connection to 203.0.113.7:443 within 10 seconds" or "Connected to 172.18.0.2:443, but it didn't send a response within 10 seconds". It also shows the address that was used, whether `GET` was needed, and the error code. Hovering over a red segment in the strip shows the same sentence.
- Each route has an info button that opens a details panel. It shows the route's status, the last health check (result, error code and when it ran), Traefik's own status and any error messages Traefik reports for the router, and the route's address and its router's name, rule, service, entry points, middlewares, TLS certificate resolver and priority.
- The checks run from the homepage container, so its DNS must resolve your route hostnames, and the container must be able to reach the address they resolve to. Two common setups break this: `*.localhost` hosts resolve to the container itself, and public hostnames often resolve to your router's public IP, which many routers won't loop back to from inside the network. Both show up as **Timed out** or **Refused** even though the site works in your browser. To fix either, set `HEALTHCHECK_ADDRESS` to your Traefik container's name (for example `traefik`, if the homepage shares a Docker network with it). Checks then connect to Traefik directly, on the route's own port (80 or 443), while still sending the route's hostname so Traefik serves the right router. This works when Traefik's entrypoints listen on 80 and 443 inside the container. Node does not trust self-signed certificates, Traefik's default certificate or private CAs, so HTTPS routes using them show **Certificate error** even when they work in your browser.
- Open pages update as soon as something changes: the server tells them when routes, health checks or found icons change, and when someone saves groups, names or icons on the page. Pages also check every 30 seconds, which picks up hand edits to the config file and anything a dropped connection missed. A browser tab that's in the background stops listening and catches up when you switch back to it.
- The page has light and dark themes. It follows your system setting until you pick one with the toggle.
- If Traefik can't be reached, the page keeps showing the last routes it loaded and explains what went wrong.

## Names and icons

Each route shows an icon beside its name. Once a route's health check succeeds, the server fetches its page and looks for an icon the way a browser does: an SVG icon, then an `apple-touch-icon`, then any other `<link rel="icon">` (largest first), then `/favicon.ico`. Icons are fetched from the homepage container, the same way as health checks, so `HEALTHCHECK_ADDRESS` applies to them too. They're looked up again after a day, or after an hour if none was found, and served to the page from `/api/icons/`. A new or changed icon shows up on open pages straight away, without a reload.

The icons found are saved, base64-encoded, in `icons.json` beside `CONFIG_FILE`, so after a restart the page shows them straight away instead of looking every site up again. It's only a cache: deleting it just means the icons are looked up again. Mount it next to `homepage.json`, as the example compose file does, to keep it when the container is recreated, for example to upgrade it (see [Keeping the file with your Compose project](#keeping-the-file-with-your-compose-project)). Without a mount it's kept when the container restarts, but not when it's recreated.

- Redirects to another host aren't followed, because that's usually a login page whose icon would belong to your sign-in provider. A route behind authentication may get no icon, or its login page's icon if that's on the same host.
- Certificates aren't checked when fetching icons, so routes with self-signed certificates still get one. Only images (PNG, ICO, GIF, JPEG, WebP or SVG, up to 256 KB) are used.
- A route with no icon shows the first letter of its name.

To change a route's name or icon, open its details panel and select **Change name or icon**. The icon is the `http://` or `https://` address of an image, for example one from [Dashboard Icons](https://github.com/homarr-labs/dashboard-icons) such as `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/jellyfin.svg`. Your browser loads it directly, so it must be reachable from wherever you open the homepage; if it doesn't load, the page shows the route's own icon instead. Leave a field empty to go back to the router name or the icon found on the site.

These are saved in the same file as your groups (see below), under `routes`, keyed by router name:

```json
{
  "routes": {
    "jellyfin@docker": { "name": "Jellyfin", "icon": "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/jellyfin.svg" },
    "grafana@docker": { "name": "Dashboards" }
  }
}
```

Names can be up to 60 characters. Like group members, entries for routes Traefik isn't serving right now stay in the file.

## Groups

By default routes are grouped by entrypoint. To make your own groups, select **New group**, name it, then drag routes onto it. Dropping a route on another route in a group puts it in front of that one, so you can also reorder routes this way. To take a route out of its group, drag it onto an entrypoint group or onto the box that appears at the bottom of the page while you drag. To reorder your groups, drag a group by its heading above or below another group, or use the up and down arrows on its heading. Each group heading also has buttons to rename or delete it. Deleting a group sends its routes back to their entrypoint groups.

You can also move a route from its details panel by choosing a group in the **Group** menu. This and the arrow buttons work with a keyboard and on phones, where drag and drop can be unreliable.

Groups are saved on the server, so everyone who opens the page sees the same layout (and the same names and icons). They are stored in a JSON file (`CONFIG_FILE`) that you can also edit by hand:

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

Anyone who can open the homepage can change the groups, names and icons.

### Keeping the file with your Compose project

Mount the file into the container so it survives rebuilds and lives next to your `docker-compose.yml`, where you can back it up, commit it or copy it to another machine:

```yaml
    volumes:
      - ./homepage.json:/app/config/homepage.json
      - ./icons.json:/app/config/icons.json
```

`icons.json` is optional: it keeps the icons found on your sites, so they show straight away after the container is recreated (see [Names and icons](#names-and-icons)).

- Create the files before the first `docker compose up`. Empty files are fine (`touch homepage.json icons.json`), and so are ones you've copied from another setup. If a file doesn't exist, Docker creates a directory with that name instead. The page tells you to replace `homepage.json` with a file, and the server's log says the same for `icons.json`. The same happens on Docker Desktop or Colima if the file is in a folder they don't share with Docker; both share your home folder by default.
- The container runs as the `node` user (UID 1000), which needs to be able to write the files. If your host user has a different UID, run `chmod a+w homepage.json icons.json`, or set `user:` on the service to your own UID.
- Some editors save by replacing the file rather than rewriting it, and a container keeps seeing the old one until it's recreated. If a hand edit doesn't show up, run `docker compose up -d --force-recreate homepage`.

If you'd rather not keep the file in your project, mount a named volume on the whole directory instead (`homepage-config:/app/config`). Docker then creates the file for you.

## API

The server also exposes `GET /api/routes` (the normalized route list, your groups and any config file error as JSON; each route has its saved name and icon under `custom` and the path of its found icon under `icon`), `PUT /api/groups` (replaces the groups; send `{"groups": [...]}` as `application/json`), `PUT /api/routes/<router name>` (sets a route's name and icon; send `{"name": "...", "icon": "..."}`, with empty values to clear them), `GET /api/icons/<router name>`, `GET /api/events` (a server-sent event stream that sends a message when routes, health checks, icons or saved settings change) and `GET /healthz`.

## Development

Requires Node.js 20 or newer.

```sh
TRAEFIK_API_URL=http://localhost:8080 npm run dev
npm test
```
