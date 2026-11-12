---
layout: home

hero:
  name: homepage-traefik
  tagline: A small homepage that lists every route your Traefik is serving, with a live status for each one.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/gregoryduckworth/homepage-traefik

features:
  - title: Nothing to configure per service
    details: It reads the routers from the Traefik API, so a new service shows up within one poll.
  - title: Every provider
    details: It reads routers defined anywhere, such as Docker labels, the file provider, Kubernetes and Consul.
    link: /routes
    linkText: Where routes come from
  - title: Health checks
    details: Each route is checked from the server, and failures are explained in plain words.
    link: /health-checks
    linkText: How routes are checked
  - title: Your layout
    details: Rename routes, set icons, hide the ones you don't need and drag them into groups. Everyone who opens the page sees the same layout.
    link: /customising
    linkText: Customising the page
  - title: Lightweight
    details: A single Node.js process with no runtime dependencies, gentle enough to run from a Raspberry Pi's SD card.
    link: /saved-settings#disk-writes-and-sd-cards
    linkText: Disk writes and SD cards
---

![The homepage listing routes in two custom groups and one entrypoint group, with a status strip across the top, one route refused and the version at the foot](./screenshot.png)
