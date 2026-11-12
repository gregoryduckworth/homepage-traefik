# Getting started

## Quick start

The example `docker-compose.yml` starts Traefik, the homepage and a `whoami` demo service:

```sh
mkdir config
docker compose up -d
```

Open <http://home.localhost>. You should see `home.localhost` and `whoami.localhost` listed. On Linux, if your user's UID isn't 1000, run `sudo chown 1000 config` first (see [Saved settings](./saved-settings)).

## Adding it to an existing Traefik

1. Enable the Traefik API, either with `--api.insecure=true` (serves it on port 8080 inside the Docker network) or with `--api=true` and a router for `api@internal` that the homepage can reach. That router can use a `basicAuth` middleware: see [A Traefik API behind basic auth](#a-traefik-api-behind-basic-auth).
2. Run the homepage on the same Docker network as Traefik, using the pre-built image for `amd64` and `arm64`:

```yaml
services:
  homepage:
    image: ghcr.io/gregoryduckworth/homepage-traefik:latest
    environment:
      TRAEFIK_API_URL: http://traefik:8080
      HOMEPAGE_TITLE: Home lab
    volumes:
      - ./config:/app/config
    labels:
      - traefik.enable=true
      - traefik.http.routers.homepage.rule=Host(`home.example.com`)
      - traefik.http.services.homepage.loadbalancer.server.port=3000
```

### A Traefik API behind basic auth

If the router for `api@internal` uses a `basicAuth` middleware, give the homepage a username and password for it. They're sent as an `Authorization: Basic` header, and are never shown on the page or written to the logs. Set `TRAEFIK_API_USERNAME` and `TRAEFIK_API_PASSWORD`, or put them in the URL (`http://admin:s3cret@traefik:8080`, percent-encoding any `@`, `:` or `/` in them). To keep the password out of the compose file, read it from a Docker secret with `TRAEFIK_API_PASSWORD_FILE`:

```yaml
services:
  homepage:
    image: ghcr.io/gregoryduckworth/homepage-traefik:latest
    environment:
      TRAEFIK_API_URL: https://traefik.example.com
      TRAEFIK_API_USERNAME: homepage
      TRAEFIK_API_PASSWORD_FILE: /run/secrets/traefik_api_password
    secrets:
      - traefik_api_password

secrets:
  traefik_api_password:
    file: ./traefik_api_password.txt
```

The variables take the place of any username and password in the URL, and `TRAEFIK_API_PASSWORD_FILE` of `TRAEFIK_API_PASSWORD`. If Traefik answers with a 401 or 403, the notice at the top of the page says so: that it refused the username and password, or, if none were given, that it asks for them.

## Choosing an image tag

| Tag      | What you get                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------ |
| `latest` | The newest [release](https://github.com/gregoryduckworth/homepage-traefik/releases). Also what you get with no tag |
| `1.2`    | The newest `1.2.x` release, so you get fixes but choose when to move to `1.3`                                      |
| `1.2.3`  | Exactly that release                                                                                               |
| `main`   | The latest commit on `main`, released or not                                                                       |

The foot of the page shows which one you're running, as its tag: `1.2.3` for a release, `main` for a build of `main`. The release notes say what changed. Docker doesn't fetch a newer image by itself: run `docker compose pull && docker compose up -d` to upgrade.

## Checking where an image came from

Each published image comes with signed provenance, saying which workflow, commit and repository built it, and a list of the packages in it. To check an image was built here before you run it, use the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify oci://ghcr.io/gregoryduckworth/homepage-traefik:latest --owner gregoryduckworth
```
