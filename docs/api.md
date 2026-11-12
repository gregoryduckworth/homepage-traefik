# API

| Endpoint                        | Description                                                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `GET /api/routes`               | Routes with their health, saved settings (`custom`) and found icon, plus your groups, their `groupsVersion` and the image's `version` |
| `PUT /api/groups`               | Replace the groups: `{"groups": [...]}`. Replies with them and their new `groupsVersion`. Send `If-Match: "<groupsVersion>"` to have the change refused with a `409`, and the groups as they are now, if they've changed since |
| `PUT /api/routes/<router name>` | Set any of `{"name": "...", "icon": "...", "hidden": true, "health": {"path": "/health", "check": false, "expect": [200]}}`. Empty or `false` clears (`"check": true` and `"health": null` clear too); omitted fields are kept, and `health` is replaced as a whole |
| `GET /api/icons/<router name>`  | The icon found on the route's site                                                                             |
| `POST /api/check/<router name>` | Check the route and look up its icon now. Replies with its new `health` once both are done, or a `404` for a route that isn't checked |
| `GET /api/history/<router name>` | How the route has done over the last 24 hours (see below)                                                     |
| `GET /api/events`               | Server-sent events, one message whenever anything on the page changes                                          |
| `GET /healthz`                  | Liveness check                                                                                                 |

`PUT` bodies, and `POST` requests, are sent as `application/json`.

On a [read-only](./customising#sharing-the-page-read-only) homepage, `GET /api/routes` includes `"readOnly": true` and both `PUT` endpoints answer with a `403`. `POST /api/check/<router name>` still works, as it saves nothing.

`GET /api/history/<router name>` answers with `checks`, the number of failed (`down`) and warning (`warn`, Traefik's own 404) checks, `uptime` (the share that didn't fail, from 0 to 1), the average `latencyMs` of those that answered, `since` (the oldest check counted), and `buckets`: 48 half hours, oldest first, each with its `start`, `checks`, `warn` and `down`. Half hours start on the clock's half hours, and the last is the one under way. `uptime`, `latencyMs` and `since` are `null` before the first check. It answers with a `404` for a router Traefik isn't serving.

The page sends `If-Match` with every group change, so a change made on a page that missed one saved elsewhere, say because its connection dropped, doesn't silently undo it. The page says the change wasn't saved and shows the groups as they are now. `groupsVersion` only changes when the groups do: renaming, hiding or giving an icon to a route leaves it alone.

