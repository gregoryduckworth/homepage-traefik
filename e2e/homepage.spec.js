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

test('a group change made on a page that missed a change saved elsewhere is refused, and the page catches up', async ({ page, homepage }) => {
  await createGroup(page, 'Media');
  // The page stops hearing about changes saved elsewhere, as when its event stream is down.
  await page.route('**/api/events', route => route.abort());
  await page.reload();
  await expect(group(page, 'Media')).toBeVisible();
  await page.request.put(`${homepage.url}api/groups`, { data: { groups: [{ name: 'Media', routes: ['jellyfin@docker'] }] } });

  await page.getByRole('button', { name: 'Rename Media' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename group' });
  await dialog.getByLabel('Name').fill('Films');
  await dialog.getByRole('button', { name: 'Rename group' }).click();

  await expect(page.getByText('Your group change wasn’t saved')).toBeVisible();
  await expect(page.getByText(/changed somewhere else/)).toBeVisible();
  await expect(details(group(page, 'Media'), 'jellyfin')).toBeVisible();
  await expect(group(page, 'Films')).toHaveCount(0);
  expect((await homepage.readConfig()).groups).toEqual([{ name: 'Media', routes: ['jellyfin@docker'] }]);
});

test('groups can be reordered with their arrow buttons', async ({ page }) => {
  await createGroup(page, 'First');
  await createGroup(page, 'Second');
  await page.getByRole('button', { name: 'Move Second up' }).click();

  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Second (0)', 'First (0)', 'web (2)', 'websecure (1)']);
  await expect(page.getByRole('button', { name: 'Move Second up' })).toBeDisabled();
});

test('a route can be moved up and down its group from its details with the keyboard alone', async ({ page, homepage }) => {
  await page.request.put(`${homepage.url}api/groups`, {
    data: { groups: [{ name: 'Media', routes: ['grafana@docker', 'jellyfin@docker', 'sonarr@docker'] }] },
  });
  await page.reload();
  const tiles = group(page, 'Media').getByRole('listitem');
  await expect(tiles).toHaveCount(3);
  await expect(tiles).toContainText(['grafana', 'jellyfin', 'sonarr']);

  await details(page, 'jellyfin').focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'jellyfin' });
  const up = dialog.getByRole('button', { name: 'Move up' });
  const down = dialog.getByRole('button', { name: 'Move down' });
  const announcement = dialog.getByText(/^Moved to/);
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('Group')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(up).toBeFocused();

  // At the top, Move up is disabled, so focus goes to Move down.
  await page.keyboard.press('Enter');
  await expect(announcement).toHaveText('Moved to 1 of 3 in Media');
  await expect(up).toBeDisabled();
  await expect(down).toBeFocused();
  await expect(tiles).toContainText(['jellyfin', 'grafana', 'sonarr']);

  await page.keyboard.press('Enter');
  await expect(announcement).toHaveText('Moved to 2 of 3 in Media');
  await expect(down).toBeFocused();

  // At the bottom, it's the other way round.
  await page.keyboard.press('Enter');
  await expect(announcement).toHaveText('Moved to 3 of 3 in Media');
  await expect(down).toBeDisabled();
  await expect(up).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await expect(tiles).toContainText(['grafana', 'sonarr', 'jellyfin']);
  await expect.poll(async () => (await homepage.readConfig()).groups)
    .toEqual([{ name: 'Media', routes: ['grafana@docker', 'sonarr@docker', 'jellyfin@docker'] }]);
  await page.reload();
  await expect(tiles).toContainText(['grafana', 'sonarr', 'jellyfin']);
});

test('a route in no group, or alone in its group, has no buttons to move it', async ({ page }) => {
  await createGroup(page, 'Media');
  await details(page, 'jellyfin').click();
  const dialog = page.getByRole('dialog', { name: 'jellyfin' });
  await expect(dialog.getByRole('button', { name: 'Move up' })).toBeHidden();

  await dialog.getByLabel('Group').selectOption('Media');
  await expect(details(group(page, 'Media'), 'jellyfin')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Move up' })).toBeHidden();
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

test('a route can be checked again from its details, which say so until it is done', async ({ page }) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/check/**', async route => {
    await held;
    await route.continue();
  });
  await details(page, 'grafana').click();
  const dialog = page.getByRole('dialog', { name: 'grafana' });
  await dialog.getByRole('button', { name: 'Check now' }).click();
  await expect(dialog.getByRole('button', { name: 'Checking…' })).toHaveAttribute('aria-disabled', 'true');

  const checked = page.waitForResponse(res => res.url().endsWith('/api/check/grafana%40docker'));
  release();
  expect((await checked).status()).toBe(200);
  await expect(dialog.getByRole('button', { name: 'Check now' })).toHaveAttribute('aria-disabled', 'false');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('a check that fails says why in the route\'s details', async ({ page }) => {
  await page.route('**/api/check/**', route => route.fulfill({ status: 500, json: { error: 'The homepage server hit an error' } }));
  await details(page, 'grafana').click();
  const dialog = page.getByRole('dialog', { name: 'grafana' });
  await dialog.getByRole('button', { name: 'Check now' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('The route wasn’t checked. The homepage server hit an error');
});

test('a route\'s details show how it has done since the homepage started', async ({ page }) => {
  await details(page, 'grafana').click();
  const dialog = page.getByRole('dialog', { name: 'grafana' });
  await expect(dialog.getByText(/^\d+(\.\d)?% up since /)).toBeVisible();
  const strip = dialog.getByRole('img');
  await expect(strip).toHaveAttribute('aria-label', /^(Checks failed|No checks failed)/);
  await expect(strip.locator('span')).toHaveCount(48);
});

test('a route\'s history shows each half hour by how its checks went', async ({ page }) => {
  const start = Date.parse('2026-01-01T12:30:00Z');
  const counts = { 0: { checks: 30 }, 1: { checks: 30, down: 3 }, 2: { checks: 30, down: 30 } };
  const buckets = Array.from({ length: 48 }, (_, i) => ({ start: new Date(start + i * 30 * 60000).toISOString(), checks: 0, warn: 0, down: 0, ...counts[i] }));
  await page.route('**/api/history/**', route => route.fulfill({
    json: { since: buckets[0].start, checks: 90, warn: 0, down: 33, uptime: 57 / 90, latencyMs: 41, bucketMinutes: 30, buckets },
  }));
  await details(page, 'grafana').click();
  const dialog = page.getByRole('dialog', { name: 'grafana' });
  await expect(dialog.getByText('63.3% up over the last 24 hours')).toBeVisible();
  await expect(dialog.getByText('33 of 90 checks failed. Average response 41 ms.')).toBeVisible();
  const segments = dialog.getByRole('img').locator('span');
  await expect(segments.nth(0)).toHaveAttribute('data-kind', 'up');
  await expect(segments.nth(1)).toHaveAttribute('data-kind', 'warn');
  await expect(segments.nth(2)).toHaveAttribute('data-kind', 'down');
  await expect(segments.nth(3)).toHaveAttribute('data-kind', 'none');
  // The two half hours with failures run together into one period.
  await expect(dialog.getByRole('img')).toHaveAttribute('aria-label', /^Checks failed (?!.* and ).+ to .+$/);
});

test('a route\'s history that can\'t be loaded says why', async ({ page }) => {
  await page.route('**/api/history/**', route => route.fulfill({ status: 500, json: { error: 'The homepage server hit an error' } }));
  await details(page, 'grafana').click();
  const dialog = page.getByRole('dialog', { name: 'grafana' });
  await expect(dialog.getByText('Couldn’t load how this route has done over the last day')).toBeVisible();
  await expect(dialog.getByText('The homepage server hit an error')).toBeVisible();
  await expect(dialog.getByRole('img')).toBeHidden();
});

test.describe('a disabled route', () => {
  // In the [value, options] form, as Playwright would read a bare list of two routers as one router and its options.
  test.use({
    routers: [[
      { name: 'grafana@docker', rule: 'Host(`grafana.test`)', entryPoints: ['web'], status: 'enabled', service: 'grafana@docker' },
      { name: 'old@docker', rule: 'Host(`old.test`)', entryPoints: ['web'], status: 'disabled', service: 'old@docker' },
    ], { option: true }],
  });

  test('has no history in its details, as it\'s never checked', async ({ page }) => {
    let asked = false;
    await page.route('**/api/history/**', route => {
      asked = true;
      return route.continue();
    });
    await details(page, 'old').click();
    const dialog = page.getByRole('dialog', { name: 'old' });
    await expect(dialog.getByText('Not checked while the router is disabled')).toBeVisible();
    await expect(dialog.getByText(/up (over|since)|No checks/)).toBeHidden();
    await expect(dialog.getByRole('img')).toBeHidden();
    expect(asked).toBe(false);
  });
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

test.describe('a read-only homepage', () => {
  test.use({
    readOnly: true,
    savedConfig: { groups: [{ name: 'Media', routes: ['jellyfin@docker', 'grafana@docker'] }], routes: { 'sonarr@docker': { hidden: true } } },
  });

  test('shows the saved layout without the controls that change it', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Media (2)']);
    await expect(page.getByRole('button', { name: 'New group' })).toBeHidden();
    await expect(page.getByRole('button', { name: /^(Rename|Delete|Move) Media/ })).toHaveCount(0);
    await expect(page.locator('[draggable="true"]')).toHaveCount(0);

    await details(page, 'jellyfin').click();
    const dialog = page.getByRole('dialog', { name: 'jellyfin' });
    await expect(dialog.getByRole('button', { name: 'Check now' })).toBeVisible();
    await expect(dialog.getByLabel('Group')).toBeHidden();
    await expect(dialog.getByRole('button', { name: /^Move (up|down)$/ })).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Change name or icon' })).toBeHidden();
    await expect(dialog.getByRole('button', { name: 'Hide route' })).toBeHidden();
  });

  test('still lets hidden routes be shown, which only changes this page', async ({ page }) => {
    await page.getByRole('button', { name: 'Show 1 hidden route' }).click();
    await expect(details(page, 'sonarr')).toBeVisible();
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
