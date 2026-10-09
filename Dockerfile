# The current Node LTS. CI tests the same version, from .nvmrc, and checks the two match.
FROM node:24-alpine

# The image's version, as tagged on Docker: 1.2.3 for a release, main for a build of main. CI sets it, and the page
# shows it at the foot; an image built by hand says dev.
ARG VERSION=dev
ENV NODE_ENV=production HOMEPAGE_VERSION=$VERSION
WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
# Groups, route settings and found icons are saved here; mount a volume on it to keep them across container rebuilds.
RUN mkdir config && chown node:node config

USER node
EXPOSE 3000

# Checks the port the server listens on, so setting PORT doesn't leave the container unhealthy, which Traefik's
# Docker provider would then stop routing to.
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

CMD ["node", "src/server.js"]
