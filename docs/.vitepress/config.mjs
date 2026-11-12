import { defineConfig } from 'vitepress';

const repo = 'https://github.com/gregoryduckworth/homepage-traefik';

// The documentation site, published to GitHub Pages by .github/workflows/docs.yml. Preview it with `npm run docs:dev`.
export default defineConfig({
  title: 'homepage-traefik',
  description: 'A small homepage that lists every route your Traefik is serving, with a live status for each one.',
  // Served from https://gregoryduckworth.github.io/homepage-traefik/.
  base: '/homepage-traefik/',
  cleanUrls: true,
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: '/homepage-traefik/favicon.svg' }]],
  themeConfig: {
    logo: '/favicon.svg',
    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'API', link: '/api' },
      { text: 'Releases', link: `${repo}/releases` },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/getting-started' },
          { text: 'Where routes come from', link: '/routes' },
          { text: 'Configuration', link: '/configuration' },
          { text: 'Health checks', link: '/health-checks' },
          { text: 'Customising the page', link: '/customising' },
          { text: 'Saved settings', link: '/saved-settings' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'API', link: '/api' },
          { text: 'Development', link: '/development' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: repo }],
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
    search: { provider: 'local' },
    footer: { message: `Released under the <a href="${repo}/blob/main/LICENSE">MIT License</a>.` },
  },
});
