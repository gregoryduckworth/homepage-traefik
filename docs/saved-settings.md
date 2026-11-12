# Saved settings

Mount a folder at `/app/config` so your settings survive upgrades:

```yaml
    volumes:
      - ./config:/app/config
```

The server keeps three files there:

| File            | What's in it                                      | Back it up?             |
| --------------- | ------------------------------------------------- | ----------------------- |
| `homepage.json` | Your groups, names, icons, hidden routes and health check settings | Yes    |
| `icons.json`    | Icons found on your sites                         | No, it's only a cache   |
| `history.json`  | Each route's checks over the last 24 hours        | No, it's only a cache   |

`homepage.json` is only written when you change something on the page, so it's safe to keep in git. Older versions also kept a `health.json` there; it's no longer used, so you can delete it.

The container runs as UID 1000, which must be able to write to the folder. Create it before the first start (`mkdir config`); otherwise Docker creates it owned by root. On Linux, run `sudo chown 1000 config` if your UID isn't 1000. A named volume (`homepage-config:/app/config`) works too.

You can also edit `homepage.json` by hand. Changes show up without a restart, and if the file isn't valid, the page says why and keeps the last layout:

```json
{
  "groups": [
    { "name": "Media", "routes": ["jellyfin@docker", "nas@file"] },
    { "name": "Monitoring", "routes": ["grafana@docker"] }
  ],
  "routes": {
    "jellyfin@docker": { "name": "Jellyfin", "icon": "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/jellyfin.svg" },
    "homepage@docker": { "hidden": true },
    "grafana@docker": { "health": { "path": "/api/health", "expect": [200] } },
    "backup@file": { "health": { "check": false } }
  }
}
```

A route's `health` can have a `path` starting with a single `/`, `"check": false`, and an `expect` list of status codes from 100 to 499, all optional. Routes are identified by their full router name, shown as **Router** in the details panel. Entries for routers Traefik isn't serving right now are kept, and come back into place when the router returns.

## Disk writes and SD cards

The homepage is meant to run on a Raspberry Pi without wearing out its SD card. Health checks and icon lookups are network requests, and health results are kept in memory, so the only writes are to the three files above:

| File            | When it's written                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `homepage.json` | Only when you change something on the page; saving without changing anything writes nothing                                                |
| `icons.json`    | Only when an icon is found, changes to a different image, or its route goes away; a daily re-check that finds the same icon writes nothing |
| `history.json`  | Only when the server stops, as on `docker stop` or an upgrade; it's read back when it starts                                               |

Each save writes a temporary file and renames it over the old one, so a power cut can't leave half a file.

Saving the history only on the way out means a running homepage never writes it, but a power cut or crash loses the checks since the last stop, and the panel then starts counting again from the next check. The history takes about 10 KB of memory per route at the default interval (seven bytes a check), and up to six times that at the shortest, 10 seconds. A route Traefik stops serving keeps its history for a day, so one whose container is only being recreated doesn't lose it. If you run a read-only and an editable homepage on the same config folder, each keeps its own history, and whichever stops last saves it.

Apart from one line at startup, the server only logs when something goes wrong. If Traefik can't be reached, it logs that when it happens and whenever the error changes, not on every poll, then logs one line such as `Reading routes from http://traefik:8080 again` when it answers, so the log shows how long the outage lasted.

When a route's own icon can't be found, the server says why once, for example `No icon for jellyfin@docker at https://jellyfin.example.com: No response within 10000 ms`. It says so again only if the reason or the route's address changes, not on every hourly retry, and logs `Found an icon for jellyfin@docker at https://jellyfin.example.com` if one turns up later. A site that simply has no icon (no icon links and no `/favicon.ico`) is noted once. Routes that are down aren't looked up, so they log nothing, and a route that keeps the icon it already had after a failed re-check doesn't either.

Docker keeps container logs on disk, so a size limit such as `logging: { driver: local, options: { max-size: 1m } }` in your compose file still helps keep them small.

