# Where routes come from

The homepage asks Traefik which routers it's serving (`/api/http/routers` and `/api/tcp/routers`). So it lists routers from **every provider** Traefik has loaded, not just Docker labels. A router in a file-provider config shows up exactly like one from a label:

```yaml
# providers.yaml, loaded with --providers.file.filename=/etc/traefik/providers.yaml
http:
  routers:
    nas:
      rule: Host(`nas.example.com`)
      entryPoints: [websecure]
      tls: {}
      service: nas
  services:
    nas:
      loadBalancer:
        servers:
          - url: http://192.168.1.20:5000
```

This lists **nas**, linked to `https://nas.example.com`, with `nas@file` as its router name in the details panel. Routers from Kubernetes, Consul or any other provider appear the same way.

How a router is shown:

- **Name:** the router name without its `@provider` suffix (`jellyfin@docker` shows as **jellyfin**). You can rename it on the page.
- **Link:** the first `Host` in the rule, plus any `Path`/`PathPrefix`, over `https://` if the router has TLS. Links use ports 80/443. If an entry point is published on another port, set `ENTRYPOINT_PORTS` (for example `websecure:8443`).
- **Grouping:** by entry point, until you make your own groups.
- An HTTP→HTTPS redirect pair for the same host and path is listed once, as the HTTPS route.
- Routers without a `Host` (for example `HostRegexp` or path-only rules) are listed without a link.
- TCP routers are listed by name with their `HostSNI` hostname. They have no link and no health check. Their router name starts with `tcp:` (for example `tcp:postgres@docker`).
- Traefik's own `@internal` routers (API, dashboard) are left out. Disabled routers and routers with warnings are marked as such.

