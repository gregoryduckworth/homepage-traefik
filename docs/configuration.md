# Configuration

| Variable                       | Default                | Description                                                                                         |
| ------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `TRAEFIK_API_URL`              | `http://traefik:8080`  | Base URL of the Traefik API                                                                         |
| `TRAEFIK_API_USERNAME`         | (unset)                | Username for a Traefik API behind basic auth (see [Getting started](./getting-started#a-traefik-api-behind-basic-auth))        |
| `TRAEFIK_API_PASSWORD`         | (unset)                | Password for a Traefik API behind basic auth                                                        |
| `TRAEFIK_API_PASSWORD_FILE`    | (unset)                | File to read that password from instead, such as a Docker secret                                    |
| `HOMEPAGE_TITLE`               | `Routes`               | Heading and browser tab title                                                                       |
| `POLL_INTERVAL_SECONDS`        | `30`                   | How often routes are read from Traefik (at least 5)                                                 |
| `HEALTHCHECK_INTERVAL_SECONDS` | `60`                   | How often each route is checked (at least 10)                                                       |
| `HEALTHCHECK_TIMEOUT_SECONDS`  | `10`                   | How long each health check and icon request may take (at least 1)                                   |
| `HEALTHCHECK_ADDRESS`          | (unset)                | Send health checks to this host instead of each route's hostname, for example `traefik` (see below) |
| `ENTRYPOINT_PORTS`             | (unset)                | Ports for entry points not on 80/443, for example `websecure:8443,web:8080`                         |
| `CONFIG_FILE`                  | `config/homepage.json` | Where your groups, names and icons are saved (`/app/config/homepage.json` in the image)             |
| `PORT`                         | `3000`                 | Port the homepage listens on                                                                        |
| `FRAME_ANCESTORS`              | `'self'`               | Sites allowed to show the homepage in a frame, for example `https://dash.example.com`               |
| `READ_ONLY`                    | `false`                | Set to `true` to show the page without letting anyone change it (see [Sharing the page read-only](./customising#sharing-the-page-read-only)) |

