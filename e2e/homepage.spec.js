const { test, expect } = require('./fixtures');

// A group's section, found by its heading ("web (2)", "Media (0)"), whatever its count.
function group(page, name) {
  return page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: new RegExp(`^${name} \\(`) }) });
}

// A route's info button, in the whole page or in one group's section.
function details(scope, name) {
  return scope.getByRole('button', { name: `Details for ${name}` });
}

async function createGroup(page, name) {
  await page.getByRole('button', { name: 'New group' }).click();
  await page.getByRole('dialog', { name: 'New group' }).getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(group(page, name)).toBeVisible();
}

test.beforeEach(async ({ page, homepage }) => {
  await page.goto(homepage.url);
  await expect(details(page, 'grafana')).toBeVisible();
});

test('lists routes by entry point, named after their routers, without Traefik\'s own', async ({ page }) => {
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['web (2)', 'websecure (1)']);
  await expect(group(page, 'web').getByRole('button', { name: /^Details for / })).toHaveCount(2);
  await expect(page.getByRole('link', { name: /sonarr/ })).toHaveAttribute('href', 'https://sonarr.test');
  await expect(details(page, 'api')).toHaveCount(0);
});

test('search narrows the list and says when nothing matches', async ({ page }) => {
  const search = page.getByRole('searchbox', { name: 'Search routes' });
  await search.fill('jelly');
  await expect(page.getByRole('button', { name: /^Details for / })).toHaveCount(1);
  await expect(details(page, 'jellyfin')).toBeVisible();

  await search.fill('nothing');
  await expect(page.getByText('Nothing matches “nothing”')).toBeVisible();
});

test('a route moved into a new group from its details stays there after a reload', async ({ page, homepage }) => {
  await createGroup(page, 'Media');
  await details(page, 'jellyfin').click();
  const dialog = page.getByRole('dialog', { name: 'jellyfin' });
  await dialog.getByLabel('Group').selectOption('Media');
  await dialog.getByRole('button', { name: 'Close' }).click();

  await expect(details(group(page, 'Media'), 'jellyfin')).toBeVisible();
  await expect.poll(async () => (await homepage.readConfig()).groups).toEqual([{ name: 'Media', routes: ['jellyfin@docker'] }]);

  await page.reload();
  await expect(details(group(page, 'Media'), 'jellyfin')).toBeVisible();
  await expect(group(page, 'web').getByRole('heading')).toHaveText('web (1)');
});

test('a route dragged onto a group joins it', async ({ page, homepage }) => {
  await createGroup(page, 'Monitoring');
  const tile = page.getByRole('listitem').filter({ has: details(page, 'grafana') });
  await tile.dragTo(group(page, 'Monitoring'));

  await expect(details(group(page, 'Monitoring'), 'grafana')).toBeVisible();
  await expect.poll(async () => (await homepage.readConfig()).groups).toEqual([{ name: 'Monitoring', routes: ['grafana@docker'] }]);
});

test('groups can be reordered with their arrow buttons', async ({ page }) => {
  await createGroup(page, 'First');
  await createGroup(page, 'Second');
  await page.getByRole('button', { name: 'Move Second up' }).click();

  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Second (0)', 'First (0)', 'web (2)', 'websecure (1)']);
  await expect(page.getByRole('button', { name: 'Move Second up' })).toBeDisabled();
});

test('a group dragged by its heading onto the top half of another goes above it', async ({ page, homepage }) => {
  await createGroup(page, 'First');
  await createGroup(page, 'Second');
  const heading = name => group(page, name).getByRole('heading', { level: 2 });
  await heading('Second').dragTo(group(page, 'First'), { targetPosition: { x: 20, y: 5 } });

  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Second (0)', 'First (0)', 'web (2)', 'websecure (1)']);
  await expect.poll(async () => (await homepage.readConfig()).groups.map(g => g.name)).toEqual(['Second', 'First']);
});

test('a route can be renamed, and goes back to its router name when cleared', async ({ page, homepage }) => {
  await details(page, 'grafana').click();
  await page.getByRole('button', { name: 'Change name or icon' }).click();
  const form = page.getByRole('dialog', { name: 'Name and icon' });
  await form.getByLabel('Name').fill('Dashboards');
  await form.getByRole('button', { name: 'Save' }).click();

  await expect(details(page, 'Dashboards')).toBeVisible();
  expect((await homepage.readConfig()).routes).toEqual({ 'grafana@docker': { name: 'Dashboards' } });

  await page.getByRole('button', { name: 'Change name or icon' }).click();
  await form.getByLabel('Name').fill('');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(details(page, 'grafana')).toBeVisible();
});

test('an icon that does not load is not requested again each time the page updates', async ({ page }) => {
  let requests = 0;
  // Browsers reuse a failed image they're allowed to cache, so this one isn't, as with many apps' error pages.
  await page.route('https://icons.test/broken.png', route => {
    requests++;
    return route.fulfill({ status: 404, headers: { 'Cache-Control': 'no-store' } });
  });
  await details(page, 'grafana').click();
  await page.getByRole('button', { name: 'Change name or icon' }).click();
  const form = page.getByRole('dialog', { name: 'Name and icon' });
  await form.getByLabel('Icon address').fill('https://icons.test/broken.png');
  await form.getByRole('button', { name: 'Save' }).click();
  await page.keyboard.press('Escape');

  const tile = page.getByRole('link', { name: /grafana/ });
  await expect(tile.locator('.tile-letter')).toHaveText('G');
  // Each keystroke in the search box rebuilds the tiles.
  const search = page.getByRole('searchbox', { name: 'Search routes' });
  await search.fill('graf');
  await search.fill('');
  await expect(tile.locator('.tile-letter')).toHaveText('G');
  expect(requests).toBe(1);
});

test('a hidden route leaves the page until hidden routes are shown', async ({ page }) => {
  await details(page, 'jellyfin').click();
  await page.getByRole('button', { name: 'Hide route' }).click();
  await expect(details(page, 'jellyfin')).toHaveCount(0);

  const toggle = page.getByRole('button', { name: 'Show 1 hidden route' });
  await toggle.click();
  await expect(details(page, 'jellyfin')).toBeVisible();
  await details(page, 'jellyfin').click();
  await page.getByRole('button', { name: 'Show route' }).click();
  await expect(page.getByRole('button', { name: /hidden route/ })).toBeHidden();
});

test('pressing / jumps to the search box', async ({ page }) => {
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: 'Search routes' })).toBeFocused();
});

test('a route added to Traefik shows up without reloading the page', async ({ page, traefik }) => {
  traefik.state.routers.push({ name: 'radarr@docker', rule: 'Host(`radarr.test`)', entryPoints: ['web'], status: 'enabled' });
  await expect(details(page, 'radarr')).toBeVisible({ timeout: 15000 });
});

test('the page keeps the last routes and explains why when Traefik goes away', async ({ page, traefik }) => {
  traefik.state.down = true;
  await expect(page.getByRole('alert')).toContainText('Showing the last routes we could load', { timeout: 15000 });
  await expect(details(page, 'grafana')).toBeVisible();
});

test('nothing on the page is blocked by its Content-Security-Policy', async ({ page }) => {
  await page.addInitScript(() => {
    window.cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => window.cspViolations.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  await page.reload();
  await details(page, 'grafana').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Dark theme' }).click();
  expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
});

test('the foot of the page shows the version, linked to its release notes', async ({ page }) => {
  await expect(page.getByRole('contentinfo')).toHaveText('homepage-traefik 1.2.3');
  await expect(page.getByRole('link', { name: '1.2.3' })).toHaveAttribute('href', 'https://github.com/gregoryduckworth/homepage-traefik/releases/tag/v1.2.3');
});

test.describe('a build of main', () => {
  test.use({ version: 'main' });

  test('links its version to the repository, as it has no release notes', async ({ page }) => {
    await expect(page.getByRole('link', { name: 'main' })).toHaveAttribute('href', 'https://github.com/gregoryduckworth/homepage-traefik');
  });
});

test.describe('theme', () => {
  test.use({ colorScheme: 'light' });

  test('the chosen theme is kept after a reload', async ({ page }) => {
    const toggle = page.getByRole('button', { name: 'Dark theme' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});
