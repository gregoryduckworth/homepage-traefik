# homepage-traefik

A small homepage that lists every route Traefik is serving. It reads routers from the Traefik API (`/api/http/routers`), turns each `Host(...)` rule into a link, and groups the links by entrypoint. When you add a container with Traefik labels, it shows up on the page within one poll interval. There is nothing to configure per service.

The app is a single Node.js process with no runtime dependencies.

## Quick start with Docker Compose

```sh
docker compose up -d
```

Then open <http://home.localhost>. The example `docker-compose.yml` starts Traefik, this homepage, and a `whoami` demo service, so you should see both `home.localhost` and `whoami.localhost` listed.

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

| Variable                | Default               | Description                                        |
| ----------------------- | --------------------- | -------------------------------------------------- |
| `TRAEFIK_API_URL`       | `http://traefik:8080` | Base URL of the Traefik API                        |
| `POLL_INTERVAL_SECONDS` | `30`                  | How often the server refreshes routes from Traefik |
| `HOMEPAGE_TITLE`        | `Routes`              | Heading and browser tab title                      |
| `PORT`                  | `3000`                | Port the homepage listens on                       |

## What gets shown

- Traefik's own `@internal` routers (API, dashboard) are hidden.
- A router's link is the first `Host` in its rule, plus any `Path`/`PathPrefix`. Routers with TLS link to `https://`.
- When an HTTP router and an HTTPS router serve the same host and path (the usual redirect setup), only the HTTPS one is listed.
- Routers without a `Host` rule (for example `HostRegexp` or path-only rules) are listed without a link.
- Disabled routers, and routers that have warnings, are marked as such.
- If Traefik can't be reached, the page keeps showing the last routes it loaded and explains what went wrong.

The server also exposes `GET /api/routes` (the normalized route list as JSON) and `GET /healthz`.

## Development

Requires Node.js 20 or newer.

```sh
TRAEFIK_API_URL=http://localhost:8080 npm run dev
npm test
```
