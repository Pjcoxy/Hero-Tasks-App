const { test, expect } = require('@playwright/test');

// What this covers, and why each one is here rather than in check-frontend.js:
// every assertion below is about RENDERED OUTPUT. The existing checks read the
// source - they parse the script, count buttons, grep CSS - so all three bugs
// that shipped green on 22 Aug passed them. These drive a real browser against
// the real API logic and look at what a person would actually see.

const PORT = process.env.SMOKE_PORT || 4173;

// index.html hardcodes the deployed Function App URL. Rather than change
// production code for the benefit of a test, send that request to the local
// server instead - the page under test stays byte-for-byte what ships.
// route.continue() refuses to change protocol (the page asks for https, the
// local server speaks http), so forward the request by hand and fulfil with the
// real response. The request body and the response body are both passed through
// untouched - this is a transport redirect, not a stub. What answers is the
// actual hero.js route table.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/hero', async (route) => {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/hero`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: route.request().postData() || '{}',
    });
    await route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: await response.text(),
    });
  });
  await page.goto('/index.html');
});

// Everyone in the seeded household has a PIN, so picking a person opens the PIN
// modal before the screen changes. Kids and parents take the same path.
async function pickPerson(page, name, pin = '1234') {
  await page.getByRole('button', { name: new RegExp(name, 'i') }).first().click();
  const modal = page.locator('#pin-modal');
  if (await modal.isVisible().catch(() => false)) {
    await page.locator('#pin-input').fill(pin);
    await page.getByRole('button', { name: /let's go/i }).click();
    await expect(modal).toBeHidden();
  }
}

test('the person picker lists everyone in the household', async ({ page }) => {
  for (const name of ['Peter', 'Tymanda', 'Toby', 'Ollie']) {
    await expect(page.getByText(name, { exact: false }).first()).toBeVisible();
  }
});

// Regression guard for #88 + #157. An avatar is stored either as an emoji
// character or as "svg:<key>". When the second form was introduced, only two
// render sites were converted, so the raw string appeared verbatim all over the
// UI. Nothing that reads source code can see that; this can.
test('no avatar is rendered as its raw stored value', async ({ page }) => {
  await expect(page.locator('body')).not.toContainText('svg:');
  await pickPerson(page, 'Ollie');
  await expect(page.locator('body')).not.toContainText('svg:');
});

// Regression guard for #118. logout() was never broken - nothing called it, so
// once a kid was picked there was no way back and the app opened as that kid
// permanently. A unit test cannot see "there is no way out of this screen".
test('a kid can get back to the picker and switch to someone else', async ({ page }) => {
  await pickPerson(page, 'Ollie');
  await expect(page.locator('#screen-kid')).toBeVisible();
  await expect(page.locator('#k-name')).toContainText('Ollie');

  await page.locator('#screen-kid .kid-header-left').click();

  await expect(page.locator('#screen-who')).toBeVisible();
  await pickPerson(page, 'Toby');
  await expect(page.locator('#k-name')).toContainText('Toby');
  await expect(page.locator('#k-name')).not.toContainText('Ollie');
});

test('every kid tab opens and shows its own content', async ({ page }) => {
  await pickPerson(page, 'Ollie');
  const tabs = page.locator('.tab-bar .tab-btn');
  const count = await tabs.count();
  expect(count).toBeGreaterThanOrEqual(4);

  for (let i = 0; i < count; i += 1) {
    await tabs.nth(i).click();
    await expect(tabs.nth(i)).toHaveClass(/active/);
    // Whichever panel is showing must actually have something in it.
    await expect(page.locator('.tab-panel:not(.hidden), .kid-tab-panel:not(.hidden)').first())
      .toBeVisible();
  }
});

test('the kid screen survives a reload without losing who you are', async ({ page }) => {
  await pickPerson(page, 'Toby');
  await expect(page.locator('#k-name')).toContainText('Toby');
  await page.reload();
  await expect(page.locator('#k-name')).toContainText('Toby');
});

test('a parent can reach Parent HQ and every tab renders', async ({ page }) => {
  await pickPerson(page, 'Peter');
  await expect(page.locator('#screen-parent')).toBeVisible();

  const tabs = page.locator('.parent-tabbar .choice-pill');
  const count = await tabs.count();
  expect(count).toBeGreaterThanOrEqual(4);
  for (let i = 0; i < count; i += 1) {
    await tabs.nth(i).click();
    await expect(tabs.nth(i)).toHaveClass(/active/);
  }
});

// The page must never come up blank or stuck on a skeleton, whatever else is
// true. This is the cheapest possible "is the app alive" assertion and the one
// most likely to catch a syntax error that only bites at runtime.
test('the app renders without a JavaScript error', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html');
  await expect(page.locator('#screen-who')).toBeVisible();
  expect(errors).toEqual([]);
});

// A native prompt() or confirm() is prefixed by the browser with the page's
// origin - the app announced itself as "salmon-river-0e879dc00.7.azurestatic
// apps.net says". Unstyleable, and the most web-page-ish thing it did.
//
// If a native dialog reappears, Playwright auto-dismisses it and the flow
// silently does nothing - so assert on the in-app modal being there, and fail
// loudly if a native one fires.
test('adding an extra task uses the in-app dialog, not a browser prompt', async ({ page }) => {
  const native = [];
  page.on('dialog', async (d) => { native.push(d.message()); await d.dismiss(); });

  await pickPerson(page, 'Ollie');
  await page.getByRole('button', { name: /something extra/i }).click();

  await expect(page.locator('#ask-modal')).toBeVisible();
  await expect(page.locator('#ask-title')).toContainText('What did you do?');
  await page.locator('#ask-input').fill('Tidied the shed');
  await page.getByRole('button', { name: /send it/i }).click();
  await expect(page.locator('#ask-modal')).toBeHidden();

  expect(native, 'a native browser dialog fired').toEqual([]);
});

test('cancelling the in-app dialog does nothing', async ({ page }) => {
  await pickPerson(page, 'Ollie');
  await page.getByRole('button', { name: /something extra/i }).click();
  await expect(page.locator('#ask-modal')).toBeVisible();
  await page.getByRole('button', { name: /^cancel$/i }).click();
  await expect(page.locator('#ask-modal')).toBeHidden();
  await expect(page.locator('#screen-kid')).toBeVisible();
});
