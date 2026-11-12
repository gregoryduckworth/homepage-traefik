# Development

Uses Node.js 24, the current LTS and the version in the image. Run `nvm use` to switch to it, as `.nvmrc` sets it.

```sh
TRAEFIK_API_URL=http://localhost:8080 npm run dev
npm test                                   # unit tests, nothing to install
npm run test:coverage                      # the same, failing if coverage drops below its minimums, as CI runs it
npm install && npx playwright install chromium
npm run test:e2e                           # browser tests against a fake Traefik API
npm run lint                               # ESLint, as CI runs it
```

Playwright, ESLint and VitePress are development dependencies only; the image doesn't include them.

The coverage minimums (lines, branches and functions) are the `--test-coverage-*` flags in `package.json`'s `test:coverage` script, set a little below today's figures; raise them as coverage goes up. The totals include the page modules the unit tests import (`public/api.js`, `groups.js`, `routes.js`), but not those only the browser tests reach.

## Documentation

This site is built with [VitePress](https://vitepress.dev/) from the Markdown files in `docs/`, with its sidebar and other settings in `docs/.vitepress/config.mjs`. A new page needs adding to the sidebar there.

```sh
npm install
npm run docs:dev                           # serves the site, reloading as you edit
npm run docs:build                         # builds it into docs/.vitepress/dist, failing on a link to a page that doesn't exist
```

The **Docs** workflow builds the site for every pull request that changes it, and publishes it to [GitHub Pages](https://gregoryduckworth.github.io/homepage-traefik/) when the change reaches `main`.

## Releasing

Run the **Release** workflow from the Actions tab, on `main`, and choose `patch`, `minor` or `major` (or type an exact version). It:

1. Tags the latest commit on `main` with the next version, such as `v1.2.4` after `v1.2.3`.
2. Writes a GitHub release, with notes listing the pull requests merged since the last one.
3. Starts the image build for the tag, which runs the tests and publishes `ghcr.io/gregoryduckworth/homepage-traefik:1.2.4`, `:1.2` and `:latest` for `amd64` and `arm64`, with signed provenance and a list of the packages in it.

For the first release, choose `major` to get `1.0.0`. A commit that's already released can't be released again. Pushing a `v1.2.3` tag yourself still builds and publishes the image, but doesn't write a release.

The git tag is the version. `package.json` stays at `0.0.0` and isn't bumped on release, since nothing reads it: the version at the foot of the page comes from the image. It's also marked `private`, so it can't be published to npm by mistake.

