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

// The rewards shop shipped with no rewards in it, so the "N more points to go"
// text that was already written had never once been seen. That is the shape
// this whole suite exists for: coded correctly, invisible in the running app.
test('the kid Home screen names a real reward and how far away it is', async ({ page }) => {
  await pickPerson(page, 'Ollie');

  const cards = page.locator('#k-goal-carousel .goal-card');
  // One card per active reward, cheapest first.
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0)).toContainText('A player for your soccer game');
  await expect(cards.nth(1)).toContainText("Ice cream from McDonald's");
  await expect(cards.nth(0)).toContainText(/\d+ more points? to go/);
});

// #178. The carousel has to be swipeable and it has to open on the prize the
// kid is actually working toward - the cheapest one they cannot yet afford -
// not on card one by accident of it happening to be the same card.
test('the prize carousel scrolls and tracks which prize you are on', async ({ page }) => {
  await pickPerson(page, 'Ollie');

  const carousel = page.locator('#k-goal-carousel');
  const dots = page.locator('#k-goal-dots .goal-dot');
  await expect(dots).toHaveCount(4);

  // A brand new kid has 0 points, so the cheapest prize is the target: card 0.
  await expect(dots.nth(0)).toHaveClass(/active/);
  expect(await carousel.evaluate((el) => el.scrollLeft)).toBe(0);

  // The container must actually be scrollable - if the cards were stacked or
  // full-width-wrapped, scrollWidth would equal clientWidth and no swipe would
  // be possible at all.
  const [scrollWidth, clientWidth] = await carousel.evaluate((el) => [el.scrollWidth, el.clientWidth]);
  expect(scrollWidth).toBeGreaterThan(clientWidth);

  // Swipe to the next prize; the dots must follow.
  await carousel.evaluate((el) => { el.scrollLeft = el.clientWidth; });
  await expect(dots.nth(1)).toHaveClass(/active/);
  await expect(dots.nth(0)).not.toHaveClass(/active/);
});

// Tapping a prize should hand the kid to the Rewards tab, on that prize's row -
// the carousel only ever shows the gap, redeeming happens in the shop.
test('tapping a prize card opens it in the Rewards tab', async ({ page }) => {
  await pickPerson(page, 'Ollie');

  // The carousel drops any click landing within 250ms of a scroll - that is the
  // swipe guard the next test covers. The shared store grows through the run,
  // so late in the suite the screen is still settling when this click arrives,
  // the guard eats it and the tab never switches. Wait for the guard to go cold
  // rather than clicking into it; Playwright's own stability wait does not help
  // because the guard keys off scroll events, not the card moving.
  await page.waitForFunction(() => Date.now() - (window.goalScrolledAt || 0) > 300);
  await page.locator('#k-goal-carousel .goal-card').nth(1).click();

  await expect(page.locator('#tab-rewards')).toBeVisible();
  await expect(page.locator('#tab-home')).toBeHidden();

  // The row it landed on must be the prize that was tapped, and it must be the
  // one in view - not just present somewhere in the list.
  //
  // Polled rather than asserted once. The jump defers a tick past the tab
  // transition and then scrolls with behaviour:'smooth', and the shared store
  // grows through the run so the list this scrolls through gets longer. A
  // single immediate assertion was racing the scroll and failed intermittently
  // late in the suite.
  const row = page.locator('#k-rewards .task').filter({ hasText: "Ice cream from McDonald's" });
  await expect(row).toBeVisible();
  await expect.poll(async () => row.isVisible().then(() => row.boundingBox())
    .then((b) => b !== null && b.y >= 0 && b.y < page.viewportSize().height))
    .toBe(true);
});

// A swipe ends with a finger on a card too. A browser suppresses the click once
// a touch has scrolled, but scroll-snap keeps firing scroll events while it
// settles, and a click arriving in that window must not throw the kid onto the
// Rewards tab. Fired synchronously right after the scroll, because that is the
// only window the guard covers - a normal deliberate tap is well outside it and
// must still work (the test above proves that half).
test('a tap arriving while the carousel is still settling is ignored', async ({ page }) => {
  await pickPerson(page, 'Ollie');

  await page.evaluate(() => {
    const carousel = document.getElementById('k-goal-carousel');
    carousel.scrollLeft = carousel.clientWidth;
    carousel.dispatchEvent(new Event('scroll'));
    document.querySelectorAll('#k-goal-carousel .goal-card')[1].click();
  });

  await expect(page.locator('#tab-home')).toBeVisible();
  await expect(page.locator('#tab-rewards')).toBeHidden();
});

// #9. The hero used to count toward a pet ladder (Egg -> Hatchling -> ... ->
// MEGA LEGEND) and a daily streak. Neither buys anything, so neither motivated
// anyone. If any of this reappears, the incentive path has been undone.
test('the pet ladder and the streak badge are gone from the kid Home screen', async ({ page }) => {
  await pickPerson(page, 'Ollie');

  const home = page.locator('#tab-home');
  await expect(home).not.toContainText(/Egg|Hatchling|Busy Bee|Chore Ninja|MEGA LEGEND/);
  await expect(home).not.toContainText(/streak/i);
  await expect(home).not.toContainText(/points to become/i);
  await expect(page.locator('#k-streak')).toHaveCount(0);
  await expect(page.locator('#k-level')).toHaveCount(0);
});

test('the rewards shop is not empty', async ({ page }) => {
  await pickPerson(page, 'Ollie');
  await page.getByRole('button', { name: /rewards/i }).first().click();
  await expect(page.locator('#k-rewards')).not.toContainText('No rewards in the shop yet');
  await expect(page.locator('#k-rewards')).toContainText("Ice cream from McDonald's");
});

// The Home tab's Today / This Week glance. It replaces "Today's Missions",
// which only ever filtered to daily chores - one-off and weekly chores due
// today, and every event or reminder, were absent because they only come from
// the calendar action.
test('the kid Home screen shows a Today and a This Week section', async ({ page }) => {
  await pickPerson(page, 'Ollie');

  await expect(page.getByRole('heading', { name: /🗓️ Today/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /This Week/ })).toBeVisible();

  // Both must resolve to real content or a real empty state - never a permanent
  // skeleton, which is what a broken fetch looks like.
  await expect(page.locator('#k-glance-today')).not.toBeEmpty();
  await expect(page.locator('#k-glance-week')).not.toBeEmpty();
  await expect(page.locator('#k-glance-today .glance-skel')).toHaveCount(0);
  await expect(page.locator('#k-glance-week .glance-skel')).toHaveCount(0);
});

// The Home glance shares one fetch with the Calendar tab, but its promise is
// "today and the next seven days" whatever view that tab is in. Before the
// fetch was widened, switching the calendar to Day silently emptied Home's
// This Week - Thursday's Scouts vanished from a Tuesday Home screen.
test('Home’s This Week survives the Calendar tab being in Day view', async ({ page }) => {
  const eventId = await page.evaluate(async () => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    const state = await post({ action: 'state' });
    const start = new Date(new Date(state.today + 'T12:00:00Z').getTime() + 2 * 86400000);
    const made = await post({
      action: 'addPlanningItem', parentId: 'peter', parentPin: '1234',
      type: 'event', title: 'Glance range probe', personId: 'toby',
      startAt: start.toISOString(),
    });
    return made.item.id;
  });

  await page.reload();
  await pickPerson(page, 'Toby');
  await expect(page.locator('#k-glance-week')).toContainText('Glance range probe');

  await page.locator('#tabbtn-calendar').click();
  await page.locator('#calendar-view-day').click();
  await page.locator('#tabbtn-home').click();
  await expect(page.locator('#k-glance-week')).toContainText('Glance range probe');

  await page.evaluate(async (id) => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    await post({ action: 'deletePlanningItem', planningItemId: id, parentId: 'peter', parentPin: '1234' });
  }, eventId);
});

test('the old daily-only Missions section is gone from Home', async ({ page }) => {
  await pickPerson(page, 'Ollie');
  await expect(page.locator('#tab-home')).not.toContainText("Today's Missions");
  // The Missions tab keeps its own weekly and one-off lists.
  await page.getByRole('button', { name: /missions/i }).first().click();
  await expect(page.locator('#k-weekly')).toBeVisible();
});

// #128. The capture sheet used to post `action: 'saveVoiceReminder'`, which is
// not in hero.js's ROUTES table at all - every save returned "Unknown action".
// Source-level checks could not see that: the string was present, the route was
// not. This drives the real sheet against the real route table, so the two have
// to agree.
//
// SpeechRecognition is removed first, deliberately. Whether a headless Chromium
// exposes it varies by build - where it does, start() waits on a speech service
// the runner cannot reach and the sheet never opens, so the test would pass or
// hang depending on the machine. Removing it pins the flow to its typed
// fallback: the documented path for a browser that cannot record, and the one
// that exercises everything this test is actually about.
test('the voice capture sheet lets the kid pick the item type and saves it', async ({ page }) => {
  await page.addInitScript(() => {
    delete window.SpeechRecognition;
    delete window.webkitSpeechRecognition;
  });
  await page.reload();
  await pickPerson(page, 'Ollie');

  await page.locator('#k-voice-reminder-btn').click();
  await expect(page.locator('#voice-reminder-modal')).toBeVisible();

  await page.locator('#voice-transcript-input').fill('soccer training on Saturday');
  await page.getByRole('button', { name: /check it/i }).click();

  // Type pills only appear once the sheet has something to confirm.
  await expect(page.locator('#voice-type-choices')).toBeVisible();
  await expect(page.locator('#voice-type-choice-reminder')).toBeVisible();
  await expect(page.locator('#voice-type-choice-task')).toBeVisible();
  await expect(page.locator('#voice-type-choice-event')).toBeVisible();

  // Exactly one is selected at a time, and the kid's choice sticks.
  await page.locator('#voice-type-choice-event').click();
  await expect(page.locator('#voice-type-choice-event')).toHaveClass(/active/);
  await expect(page.locator('#voice-type-choices .choice-pill.active')).toHaveCount(1);

  await page.getByRole('button', { name: /^confirm$/i }).click();

  // The save has to actually land. An unknown action leaves the sheet open with
  // an error, so a closed sheet is the assertion that matters here.
  await expect(page.locator('#voice-reminder-modal')).toBeHidden();
  await expect(page.locator('#toast')).toContainText(/Event saved/i);
});

// #122. My List: a kid's own notes, plans and reminders, separate from the
// chores a parent assigns. These items have no date, which is exactly why they
// need their own fetch - the calendar action skips anything without a parseable
// startAt, so an undated note is invisible to every other screen in the app.
test('a kid can add something to their own list and tick it off', async ({ page }) => {
  await pickPerson(page, 'Ollie');
  await page.getByRole('button', { name: /missions/i }).first().click();

  await expect(page.locator('#k-mylist')).toContainText('Nothing on your list yet');

  await page.locator('#k-mylist-add').click();
  await expect(page.locator('#myitem-sheet')).toBeVisible();
  await page.locator('#myitem-title').fill('Library book is due');
  await page.getByRole('button', { name: /🎒 School/ }).click();
  await page.getByRole('button', { name: /Add it/ }).click();

  // Sheet closes and the item lands - if the route were wrong this would stay
  // on screen as an optimistic row and then vanish on the rollback.
  await expect(page.locator('#myitem-sheet')).toBeHidden();
  const card = page.locator('#k-mylist .mylist-item').filter({ hasText: 'Library book is due' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('🎒 School');

  // Tick it off; it must survive a reload, which is the real proof it persisted
  // rather than only ever existing in the optimistic local copy.
  await card.locator('.tick').click();
  await expect(card).toHaveClass(/done/);

  await page.reload();
  await page.getByRole('button', { name: /missions/i }).first().click();
  const after = page.locator('#k-mylist .mylist-item').filter({ hasText: 'Library book is due' });
  await expect(after).toBeVisible();
  await expect(after).toHaveClass(/done/);
});

// One kid's list must never show up on another kid's screen.
test('my list is private to the kid who wrote it', async ({ page }) => {
  await pickPerson(page, 'Ollie');
  await page.getByRole('button', { name: /missions/i }).first().click();
  await page.locator('#k-mylist-add').click();
  await page.locator('#myitem-title').fill('Ollie secret plan');
  await page.getByRole('button', { name: /Add it/ }).click();
  await expect(page.locator('#k-mylist')).toContainText('Ollie secret plan');

  await page.locator('.kid-header-left').click();
  await pickPerson(page, 'Toby');
  await page.getByRole('button', { name: /missions/i }).first().click();
  await expect(page.locator('#k-mylist')).not.toContainText('Ollie secret plan');
  await expect(page.locator('#k-mylist')).toContainText('Nothing on your list yet');
});

// #123. A kid can put their own list in the order they care about. The API
// requires every one of their ids, so the interesting part is that moving one
// row inside a filtered or split view still sends a complete, valid list.
//
// The smoke server keeps one in-memory store for the whole run, so Ollie's list
// already has rows from earlier tests. These assert on the relative order of two
// rows they add themselves rather than on the whole list.
test('a kid can reorder their own list, and it sticks', async ({ page }) => {
  await pickPerson(page, 'Ollie');
  await page.getByRole('button', { name: /missions/i }).first().click();

  for (const title of ['Alpha row', 'Beta row']) {
    await page.locator('#k-mylist-add').click();
    await page.locator('#myitem-title').fill(title);
    await page.getByRole('button', { name: /Add it/ }).click();
    await expect(page.locator('#k-mylist')).toContainText(title);
  }

  const titles = () => page.locator('#k-mylist .mylist-item .title').allTextContents();
  const indexOf = async (label) => (await titles()).indexOf(label);

  // New items append, so Alpha sits directly above Beta.
  expect(await indexOf('Beta row')).toBe((await indexOf('Alpha row')) + 1);

  await page.locator('#k-mylist .mylist-item')
    .nth(await indexOf('Beta row'))
    .getByRole('button', { name: 'Move up' })
    .click();
  await expect.poll(async () => (await indexOf('Beta row')) < (await indexOf('Alpha row'))).toBe(true);

  // A reload is the real proof - an optimistic swap alone would look identical.
  await page.reload();
  await page.getByRole('button', { name: /missions/i }).first().click();
  await expect.poll(async () => (await indexOf('Beta row')) < (await indexOf('Alpha row'))).toBe(true);
});

// The ends must be inert, not an error toast.
test('moving past the ends of the list is a no-op', async ({ page }) => {
  await pickPerson(page, 'Ollie');
  await page.getByRole('button', { name: /missions/i }).first().click();

  await page.locator('#k-mylist-add').click();
  await page.locator('#myitem-title').fill('Ends check row');
  await page.getByRole('button', { name: /Add it/ }).click();
  await expect(page.locator('#k-mylist')).toContainText('Ends check row');

  const rows = page.locator('#k-mylist .mylist-item');
  await expect(rows.first().getByRole('button', { name: 'Move up' })).toBeDisabled();
  await expect(rows.last().getByRole('button', { name: 'Move down' })).toBeDisabled();

  // Reordering is organisation, not achievement: no toast, no celebration.
  await rows.first().getByRole('button', { name: 'Move down' }).click();
  await expect(page.locator('#toast')).toBeHidden();
});

// Reordering is organisation, not achievement - the parent's own task views
// must not sprout kid reorder controls.
test('Parent HQ task rows have no reorder controls', async ({ page }) => {
  await pickPerson(page, 'Peter');
  await page.getByRole('button', { name: /^Tasks$/i }).first().click();
  await expect(page.locator('#p-tab-tasks .move-controls')).toHaveCount(0);
});

// Approvals is the tab a parent lands on. What is waiting on them has to be at
// the top of it, not below two sections of context. The two counts are tiles
// side by side, not stacked sections - the row must actually be a row.
test('Approvals opens with what is waiting on the parent, at the top', async ({ page }) => {
  await pickPerson(page, 'Peter');

  const tiles = page.locator('#p-tab-approvals .parent-section').first().locator('.stat-tile');
  await expect(tiles).toHaveCount(3);
  await expect(tiles.first()).toContainText('Awaiting approval');
  await expect(tiles.nth(1)).toContainText('Reward requests');
  await expect(tiles.nth(2)).toContainText('From email');
  const a = await tiles.first().boundingBox();
  const b = await tiles.nth(1).boundingBox();
  const c = await tiles.nth(2).boundingBox();
  expect(Math.abs(a.y - b.y)).toBeLessThan(4);
  expect(Math.abs(a.y - c.y)).toBeLessThan(4);

  const headings = await page.locator('#p-tab-approvals .parent-section-title').allTextContents();
  expect(headings[0]).toMatch(/Today, by kid/);
});

// A "Waiting on you" row was a plain div - it looked actionable and did
// nothing. It must now lead to the card where the decision is actually made.
//
// The seed ships no chores, so this creates one and completes it first. That
// setup goes through the real API (the page's own route intercept forwards it
// to the same handler), and every assertion below is still on rendered UI. An
// earlier version of this test skipped itself when it found no waiting row,
// which meant the behaviour it exists for was never actually checked.
test('a Waiting on you row leads to its approval card', async ({ page }) => {
  const pending = await page.evaluate(async () => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());

    await post({
      action: 'addTask', parentId: 'peter', parentPin: '1234',
      kidId: 'toby', title: 'Feed the dog', points: 3, cycle: 'daily',
    });
    const state = await post({ action: 'state' });
    const task = state.tasks.find((t) => t.title === 'Feed the dog');
    await post({ action: 'completeTask', personId: 'toby', pin: '1234', taskId: task.id });
    return true;
  });
  expect(pending).toBe(true);

  await page.reload();
  await pickPerson(page, 'Peter');

  const waitingRow = page.locator('#p-approvals-today-by-kid .parent-list-row-link')
    .filter({ hasText: 'Feed the dog' });
  await expect(waitingRow).toHaveCount(1);
  await expect(waitingRow).toContainText('Waiting on you');

  await waitingRow.click();

  // It must land on the real approval card, in view, with the buttons on it.
  const highlighted = page.locator('#p-pending .arriving');
  await expect(highlighted).toHaveCount(1);
  await expect(highlighted).toContainText('Feed the dog');
  await expect(highlighted).toBeInViewport();
  await expect(highlighted.getByRole('button', { name: '✓ Approve', exact: true })).toBeVisible();
});

// Rows with nothing to go to must stay inert rather than looking tappable.
test('rows that are not waiting on the parent are not links', async ({ page }) => {
  await pickPerson(page, 'Peter');
  const notStarted = page.locator('#p-approvals-today-by-kid .parent-list-row').filter({ hasText: 'Not started' });
  const count = await notStarted.count();
  for (let i = 0; i < count; i += 1) {
    await expect(notStarted.nth(i)).not.toHaveClass(/parent-list-row-link/);
  }
});

// Approve/decline notes. Declining without a reason leaves a kid with a red
// cross and nothing to act on, so the reason is mandatory - and the note has to
// actually reach the kid's own screen, which is the part source checks can't see.
async function seedPendingChore(page, title) {
  return page.evaluate(async (choreTitle) => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    await post({
      action: 'addTask', parentId: 'peter', parentPin: '1234',
      kidId: 'toby', title: choreTitle, points: 2, cycle: 'oneoff',
    });
    const state = await post({ action: 'state' });
    const task = state.tasks.find((t) => t.title === choreTitle);
    await post({ action: 'completeTask', personId: 'toby', pin: '1234', taskId: task.id });
    return true;
  }, title);
}

test('sending back needs a reason in the note box, and it reaches the kid', async ({ page }) => {
  await seedPendingChore(page, 'Sweep the porch');
  await page.reload();
  await pickPerson(page, 'Peter');

  const card = page.locator('#p-pending .parent-card').filter({ hasText: 'Sweep the porch' });

  // Sending it back with an empty note box must not go through: it bounces
  // to the box (focused, no dialog) so the kid gets something to act on.
  await card.getByRole('button', { name: /Try again/ }).click();
  await expect(page.locator('#toast')).toContainText('Tell them what to fix');
  await expect(page.locator('#ask-modal')).toBeHidden();
  await expect(card).toBeVisible();
  await expect(card.locator('.approve-note')).toBeFocused();

  await card.locator('.approve-note').fill('The step by the door is still dusty.');
  await card.getByRole('button', { name: /Try again/ }).click();
  await expect(card).toBeHidden();

  // Now the part that matters: the kid can read it on their own screen.
  await page.getByRole('button', { name: /Switch user/ }).click();
  await pickPerson(page, 'Toby');
  const activity = page.locator('#k-activity').filter({ hasText: 'Sweep the porch' });
  await expect(activity).toContainText('The step by the door is still dusty.');
});

test('a note typed in the box rides along with an approve', async ({ page }) => {
  await seedPendingChore(page, 'Water the plants');
  await page.reload();
  await pickPerson(page, 'Peter');

  const card = page.locator('#p-pending .parent-card').filter({ hasText: 'Water the plants' });
  await card.locator('.approve-note').fill('Great job, the pots look happy.');
  await card.getByRole('button', { name: /^✓ Approve$/ }).click();
  await expect(page.locator('#ask-modal')).toBeHidden();
  await expect(card).toBeHidden();

  await page.getByRole('button', { name: /Switch user/ }).click();
  await pickPerson(page, 'Toby');
  await expect(page.locator('#k-activity')).toContainText('Great job, the pots look happy.');
});

test('a plain approve goes straight through with no dialog', async ({ page }) => {
  await seedPendingChore(page, 'Fold the towels');
  await page.reload();
  await pickPerson(page, 'Peter');

  const card = page.locator('#p-pending .parent-card').filter({ hasText: 'Fold the towels' });
  await card.getByRole('button', { name: /^✓ Approve$/ }).click();
  await expect(page.locator('#ask-modal')).toBeHidden();
  await expect(card).toBeHidden();
});

// A sent-back elective stays on offer. Rejecting an extra prices the redo
// (in-app modal, after the note); the kid gets a Try-again card on Home with
// the points and the note, and one tap puts the same row back in front of
// the parent, offer intact.
test('a sent-back elective sits with the kid, points on offer, until resubmitted', async ({ page }) => {
  await page.evaluate(async () => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    await post({ action: 'addExtra', kidId: 'ollie', personId: 'ollie', pin: '1234', title: 'Washed the car' });
  });
  await page.reload();
  await pickPerson(page, 'Peter');

  const card = page.locator('#p-pending .parent-card').filter({ hasText: 'Washed the car' });
  await card.locator('.approve-note').fill('Still soapy \u2014 rinse it and show me.');
  await card.getByRole('button', { name: /Try again/ }).click();

  // The pricing step, in the app's own modal.
  await expect(page.locator('#ask-modal')).toBeVisible();
  await expect(page.locator('#ask-title')).toContainText(/Worth how many points/);
  await page.locator('#ask-input').fill('15');
  await page.locator('#ask-ok').click();
  await expect(card).toBeHidden();

  // The kid's side: a Try-again card with the offer and the note.
  await page.getByRole('button', { name: /Switch user/ }).click();
  await pickPerson(page, 'Ollie');
  const redo = page.locator('#k-redo .task', { hasText: 'Washed the car' });
  await expect(redo).toBeVisible();
  await expect(redo).toContainText('15 pts');
  await expect(redo).toContainText('Still soapy \u2014 rinse it and show me.');
  // And it also reads as sent back in Recent activity, by name.
  await expect(page.locator('#k-activity .task', { hasText: 'Washed the car' })).toBeVisible();

  // One tap resubmits; the card leaves Home.
  await redo.getByRole('button', { name: /check again/i }).click();
  await expect(redo).toBeHidden();

  // Back in front of the parent, offer intact. (The kid header's switch has
  // its own accessible name, "Switch to a different person".)
  await page.getByRole('button', { name: /Switch/ }).first().click();
  await pickPerson(page, 'Peter');
  const again = page.locator('#p-pending .parent-card').filter({ hasText: 'Washed the car' });
  await expect(again).toBeVisible();
  await expect(again).toContainText('15 pts');

  // Tidy: approve it so later premises hold.
  await again.getByRole('button', { name: /^\u2713 Approve/ }).click();
  await expect(page.locator('#ask-modal')).toBeVisible();
  await page.locator('#ask-ok').click();
  await expect(again).toBeHidden();
});

// The pinned shell suppresses the browser's own pull-to-refresh, so the app
// provides its own: pull from the top of a scroll area, release past the
// threshold, and it refreshes. A short pull snaps back and does nothing.
test('pull down far enough refreshes; a short pull does not', async ({ page }) => {
  await pickPerson(page, 'Toby');
  await expect(page.locator('.kid-main .ptr-pill')).toHaveCount(1);
  await expect(page.locator('.parent-main .ptr-pill')).toHaveCount(1);

  const pullResult = await page.evaluate(async () => {
    const main = document.querySelector('.kid-main');
    const results = {};
    const orig = window.refresh;
    let hit = false;
    window.refresh = async () => { hit = true; };
    const send = (type, y) => {
      const t = new Touch({ identifier: 1, target: main, clientX: 100, clientY: y });
      main.dispatchEvent(new TouchEvent(type, {
        touches: type === 'touchend' ? [] : [t],
        changedTouches: [t],
        bubbles: true,
        cancelable: true,
      }));
    };
    // Long pull: past the threshold.
    send('touchstart', 100);
    send('touchmove', 160);
    send('touchmove', 320);
    send('touchend', 320);
    await new Promise((r) => setTimeout(r, 80));
    results.longPull = hit;
    // Short pull: under the threshold.
    hit = false;
    send('touchstart', 100);
    send('touchmove', 140);
    send('touchend', 140);
    await new Promise((r) => setTimeout(r, 80));
    results.shortPull = hit;
    window.refresh = orig;
    return results;
  });
  expect(pullResult.longPull, 'a long pull must refresh').toBe(true);
  expect(pullResult.shortPull, 'a short pull must not refresh').toBe(false);
});

// #164: editing a task is the allocate form in edit mode - prefilled, Save
// changes, Cancel - never a chain of browser prompts.
test('editing a task drives the allocate form, not prompts', async ({ page }) => {
  await page.evaluate(async () => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    await post({
      action: 'addTask', parentId: 'peter', parentPin: '1234',
      kidId: 'toby', title: 'Brush the dog', points: 3, cycle: 'daily',
    });
  });
  await page.reload();
  await pickPerson(page, 'Peter');
  await page.evaluate(() => {
    window.prompt = () => { throw new Error('native prompt used by the task editor'); };
  });
  await page.getByRole('button', { name: /^Tasks$/i }).first().click();

  const row = page.locator('#p-tasks .parent-list-row', { hasText: 'Brush the dog' });
  await row.getByRole('button', { name: 'Edit' }).click();

  await expect(page.locator('#p-title')).toHaveValue('Brush the dog');
  await expect(page.locator('#p-task-submit')).toHaveText('Save changes');
  await expect(page.locator('#p-task-cancel')).toBeVisible();

  await page.locator('#p-title').fill('Brush the cat');
  await page.locator('#p-points').fill('7');
  await page.locator('#p-task-submit').click();

  await expect(page.locator('#p-task-submit')).toHaveText('Allocate task');
  await expect(page.locator('#p-tasks')).toContainText('Brush the cat');
  await expect(page.locator('#p-tasks .parent-list-row', { hasText: 'Brush the cat' })).toContainText('7 pts');

  // Tidy: remove the task so later premises hold.
  await page.evaluate(async () => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    const state = await post({ action: 'state' });
    const task = state.tasks.find((t) => t.title === 'Brush the cat');
    if (task) await post({ action: 'deleteTask', parentId: 'peter', parentPin: '1234', taskId: task.id });
  });
});

// Same pattern for rewards.
test('editing a reward drives the add-reward form, not prompts', async ({ page }) => {
  await pickPerson(page, 'Peter');
  await page.evaluate(() => {
    window.prompt = () => { throw new Error('native prompt used by the reward editor'); };
  });
  await page.getByRole('button', { name: /^Rewards$/i }).first().click();

  const row = page.locator('#p-rewards .parent-card').first();
  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(page.locator('#p-reward-submit')).toHaveText('Save changes');
  await expect(page.locator('#p-reward-cancel')).toBeVisible();
  const title = await page.locator('#p-reward-title').inputValue();
  expect(title.length).toBeGreaterThan(0);

  // Cancel restores add mode without touching the reward.
  await page.locator('#p-reward-cancel').click();
  await expect(page.locator('#p-reward-submit')).toHaveText('Add reward');
  await expect(page.locator('#p-reward-title')).toHaveValue('');
});

// #174. The app installs on desktops. With no maximum width a task row
// stretched to ~1900px to hold thirty characters, at phone type scale.
//
// Checked at every breakpoint the design system names, because the failure is
// silent - nothing errors, it just reads as a stretched phone page.
const BREAKPOINTS = [
  { w: 360, h: 780, label: 'small phone' },
  { w: 430, h: 932, label: 'large phone' },
  { w: 768, h: 1024, label: 'tablet' },
  { w: 1280, h: 800, label: 'laptop' },
  { w: 1920, h: 1080, label: 'wide' },
];

for (const bp of BREAKPOINTS) {
  test(`nothing scrolls sideways at ${bp.w}px (${bp.label})`, async ({ page }) => {
    await page.setViewportSize({ width: bp.w, height: bp.h });
    await pickPerson(page, 'Ollie');

    for (const tab of ['home', 'missions', 'rewards', 'leaderboard', 'calendar']) {
      await page.locator(`#tabbtn-${tab}`).click();
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflows, `${tab} tab overflows at ${bp.w}px`).toBe(false);
    }
  });
}

// Emoji icons never tint, so colour alone cannot say which tab you are on:
// the active tab carries a pill behind its icon (the Material bottom-nav
// convention), and it must follow a tab switch.
test('the active tab wears a pill behind its icon, and it moves on switch', async ({ page }) => {
  await pickPerson(page, 'Toby');

  // The pill fades via a CSS transition, so poll on its settled alpha
  // rather than reading mid-fade: > 0.5 is worn, < 0.05 is bare.
  const iconAlpha = (tab) => page.locator(`#tabbtn-${tab} .tab-icon`)
    .evaluate((el) => {
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg.match(/rgba?\([\d\s,]+?(?:,\s*([\d.]+))?\)/);
      return m && m[1] !== undefined ? Number(m[1]) : (bg === 'rgba(0, 0, 0, 0)' ? 0 : 1);
    });

  await expect.poll(() => iconAlpha('home')).toBeGreaterThan(0.5);
  await expect.poll(() => iconAlpha('missions')).toBeLessThan(0.05);

  await page.locator('#tabbtn-missions').click();
  await expect.poll(() => iconAlpha('missions')).toBeGreaterThan(0.5);
  await expect.poll(() => iconAlpha('home')).toBeLessThan(0.05);
});

test('content is capped and centred on a wide screen, not stretched', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await pickPerson(page, 'Ollie');

  // 72rem at the 112.5% root of the wide breakpoint is ~1296px. The assertion
  // that matters is simply that it is nowhere near the 1920 viewport.
  const sheetWidth = await page.locator('.home-content-sheet').evaluate((el) => el.clientWidth);
  expect(sheetWidth).toBeLessThan(1500);

  // Centred, not left-aligned: equal gap either side, within a pixel.
  const box = await page.locator('.home-content-sheet').boundingBox();
  const rightGap = 1920 - (box.x + box.width);
  expect(Math.abs(box.x - rightGap)).toBeLessThanOrEqual(1);

  // And the width is actually used: Today and This Week sit side by side.
  const today = await page.locator('#k-glance-today').boundingBox();
  const week = await page.locator('#k-glance-week').boundingBox();
  expect(week.x).toBeGreaterThan(today.x + today.width - 1);
});

test('the parent approval list goes multi-column on a wide screen', async ({ page }) => {
  await page.evaluate(async () => {
    const post = (b) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
    }).then((r) => r.json());
    for (const t of ['Grid one', 'Grid two', 'Grid three']) {
      await post({ action: 'addTask', parentId: 'peter', parentPin: '1234', kidId: 'toby', title: t, points: 1, cycle: 'oneoff' });
    }
    const st = await post({ action: 'state' });
    for (const t of st.tasks.filter((x) => x.title.startsWith('Grid '))) {
      await post({ action: 'completeTask', personId: 'toby', pin: '1234', taskId: t.id });
    }
  });

  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.reload();
  await pickPerson(page, 'Peter');

  const cards = page.locator('#p-pending > .card');
  expect(await cards.count()).toBeGreaterThanOrEqual(3);

  // Two cards sharing a row is the whole point - one column would put every
  // card at the same x, each one stretched across the screen.
  const first = await cards.nth(0).boundingBox();
  const second = await cards.nth(1).boundingBox();
  expect(second.x).toBeGreaterThan(first.x);
  expect(first.width).toBeLessThan(800);
});

// Photo avatars and the splash artwork. The failure mode here is silent: a
// wrong path leaves an <img> that renders as nothing, and every source-level
// check still passes because the markup is correct. These assert the bytes
// actually arrived by reading naturalWidth.
test('everyone has a real photo avatar on the picker, and they load', async ({ page }) => {
  // All four, not just the kids. Kids on photos beside parents on generic emoji
  // read as two different kinds of account rather than four people.
  for (const name of ['Peter', 'Tymanda', 'Toby', 'Ollie']) {
    const tile = page.locator('.who-tile').filter({ hasText: name });
    const img = tile.locator('img.avatar-photo');
    await expect(img).toHaveCount(1);
    const loaded = await img.evaluate((el) => el.complete && el.naturalWidth > 0);
    expect(loaded, `${name}'s avatar did not load`).toBe(true);
  }
});

test('the kid header carries the photo through after signing in', async ({ page }) => {
  await pickPerson(page, 'Toby');
  const img = page.locator('#k-avatar img.avatar-photo');
  await expect(img).toHaveCount(1);
  const loaded = await img.evaluate((el) => el.complete && el.naturalWidth > 0);
  expect(loaded).toBe(true);
  // The header uses the tighter head crop, not the chest-up tile - at ~40px the
  // tile is an unreadable smudge.
  await expect(img).toHaveAttribute('src', /head-/);
});

// Every head crop should be a face at header size. Toby's and Ollie's were the
// whole ring shrunk into the square instead - a small face with a coloured
// border round it, and Ollie's was off-centre with the cockatoo taking half
// the frame. This checks the file, not the CSS: a wide crop cannot be rescued
// downstream.
test('every head crop is framed on the face, not the whole badge', async ({ page }) => {
  const heads = ['toby', 'ollie', 'peter', 'tymanda'];
  for (const who of heads) {
    const res = await page.request.get(`/img/head-${who}.webp`);
    expect(res.status(), `head-${who}.webp should exist`).toBe(200);
  }
  // Square, and the same size for all four, so none of them renders softer or
  // sharper than the others in the same row.
  const sizes = await Promise.all(heads.map((who) => page.evaluate((name) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(`${img.naturalWidth}x${img.naturalHeight}`);
    img.onerror = () => resolve('failed');
    img.src = `img/head-${name}.webp`;
  }), who)));
  expect(new Set(sizes).size, `head crops differ in size: ${sizes.join(', ')}`).toBe(1);
  expect(sizes[0]).toBe('96x96');
});

// A crown said "a parent". The header can say which one, and everyone else in
// this app is already represented by their photo.
// Allocation used to offer "every day", "once a week" and "one-off", and
// "once a week" silently meant whichever weekday the chore happened to be
// created on - real recurrence that nobody could see or choose. A chore that
// belongs on Mon/Wed/Fri had no way to be expressed.
test('a chore can be set to particular weekdays, and lands on exactly those', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());

    await post({
      action: 'addTask', parentId: 'peter', parentPin: '1234',
      kidId: 'toby', title: 'Bins out', points: 4,
      cycle: 'weekly', days: [1, 3, 5],
    });
    const state = await post({ action: 'state' });
    const task = state.tasks.find((t) => t.title === 'Bins out');

    // Two clear weeks, so the pattern has to repeat rather than fire once.
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - from.getUTCDay() + 1);
    const to = new Date(from);
    to.setUTCDate(to.getUTCDate() + 13);
    const cal = await post({
      action: 'calendar', parentId: 'peter', parentPin: '1234',
      start: from.toISOString(), end: to.toISOString(),
    });
    const mine = (cal.items || []).filter((i) => i.taskId === task.id);
    // The expectation the server enforces: matching weekdays within the
    // range, but never before the chore's creation day (its anchor). The
    // old hardcoded 6 was only right when this ran on a Monday.
    let expected = 0;
    const anchor = new Date(`${task.createdAt}T00:00:00Z`);
    for (let day = new Date(from); day.getTime() <= to.getTime(); day.setUTCDate(day.getUTCDate() + 1)) {
      if (day.getTime() >= anchor.getTime() && [1, 3, 5].includes(day.getUTCDay())) expected += 1;
    }
    return {
      days: task.days,
      error: cal.error || null,
      ok: cal.ok === true,
      weekdays: [...new Set(mine.map((i) => new Date(i.occurrenceAt).getUTCDay()))].sort(),
      count: mine.length,
      expected,
    };
  });

  expect(result.error, 'the calendar call should succeed').toBe(null);
  expect(result.ok, 'the calendar call should succeed').toBe(true);
  expect(result.days, 'the chosen days come back on the task').toEqual([1, 3, 5]);
  expect(result.weekdays, 'it lands on Mon, Wed and Fri and nothing else').toEqual([1, 3, 5]);
  expect(result.expected, 'the range holds at least a week of them').toBeGreaterThanOrEqual(3);
  expect(result.count, 'exactly the anchored occurrences in range').toBe(result.expected);
});

// A chore on Mon/Wed/Fri is due on each of them. Matching completions by week -
// which is what the old "once a week" needed - would mark Wednesday done
// because Monday was. Legacy chores carry no days and must keep the old rule.
test('a completion counts for its own day, not the whole week', async ({ page }) => {
  await pickPerson(page, 'Peter');
  const verdict = await page.evaluate(() => {
    state.completions = [{ taskId: 'bins', status: 'approved', date: '2026-08-24' }];
    const at = (days, date) => !!parentCalendarLiveCompletion({
      kind: 'chore', taskId: 'bins', cycle: 'weekly', days, occurrenceDate: date,
    });
    return {
      namedMonday:    at([1, 3, 5], '2026-08-24'),
      namedWednesday: at([1, 3, 5], '2026-08-26'),
      legacyWednesday: at(null, '2026-08-26'),
    };
  });
  expect(verdict.namedMonday, 'Monday is done').toBe(true);
  expect(verdict.namedWednesday, 'Wednesday is not done just because Monday was').toBe(false);
  expect(verdict.legacyWednesday, 'a chore with no named days keeps the weekly rule').toBe(true);
});

// Windows are what make the points real: submit before the close or they are
// gone for the day. The server is the only clock - the harness pins household
// time to ~noon, so 'morning' has always shut and 'evening' is always open,
// whatever hour CI runs at.
test('a chore states its window and stake, and a shut window reads as missed', async ({ page }) => {
  await page.evaluate(async () => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    await post({
      action: 'addTask', parentId: 'peter', parentPin: '1234',
      kidId: 'toby', title: 'Feed the fish', points: 2, cycle: 'daily', windowId: 'evening',
    });
    await post({
      action: 'addTask', parentId: 'peter', parentPin: '1234',
      kidId: 'toby', title: 'Make the bed', points: 3, cycle: 'daily', windowId: 'morning',
    });
  });
  // The page fetched state before these chores existed; sign-in renders from
  // that cache rather than refetching.
  await page.reload();
  await pickPerson(page, 'Toby');
  // Daily chores render on the Home glance, fed by the calendar call - give it
  // a beat rather than racing the fetch.

  // Open window: the row names its stake and can be ticked.
  const open = page.locator('.task', { hasText: 'Feed the fish' }).first();
  await expect(open).toBeVisible();
  await expect(open).toContainText(/closes 9\s?pm/i);
  await expect(open.locator('.tick')).toBeEnabled();

  // Shut window: greyed, says missed, tick disabled, points struck through.
  const missed = page.locator('.task.missed', { hasText: 'Make the bed' }).first();
  await expect(missed).toBeVisible();
  await expect(missed).toContainText(/missed/i);
  await expect(missed.locator('.tick')).toBeDisabled();
});

// The refusal is the API's, not just the row's - a stale page that still shows
// a tick cannot sneak a completion past a shut window.
test('a shut window refuses the completion at the API', async ({ page }) => {
  const verdict = await page.evaluate(async () => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    await post({
      action: 'addTask', parentId: 'peter', parentPin: '1234',
      kidId: 'ollie', title: 'Sweep the step', points: 2, cycle: 'daily', windowId: 'morning',
    });
    const state = await post({ action: 'state' });
    const task = state.tasks.find((t) => t.title === 'Sweep the step');
    const refusal = await post({ action: 'completeTask', taskId: task.id, personId: 'ollie', pin: '1234' });
    // Retire the chore: the store is shared across the run, and a later
    // test's premise is that Ollie has nothing on today.
    await post({ action: 'deleteTask', taskId: task.id, parentId: 'peter', parentPin: '1234' });
    return refusal;
  });
  expect(verdict.ok).toBe(false);
  expect(verdict.windowClosed).toBe(true);
  expect(verdict.error).toMatch(/window closed/i);
});

// A miss reaches the parent's Today view as a pill and a tag, not silence.
test('a missed chore shows on the parent\u2019s today view', async ({ page }) => {
  await page.evaluate(async () => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    // A chore in the morning window (shut - the harness pins ~noon), then the
    // sweep. This drives the real recordMisses through the real store.
    await post({
      action: 'addTask', parentId: 'peter', parentPin: '1234',
      kidId: 'ollie', title: 'Feed the chickens', points: 4, cycle: 'daily', windowId: 'morning',
    });
    await post({ action: '__sweepMisses' });
  });

  // The page fetched state before the chore and the sweep existed.
  await page.reload();
  await pickPerson(page, 'Peter');
  const ollieCard = page.locator('#p-approvals-today-by-kid .parent-card', { hasText: 'Ollie' });
  await expect(ollieCard).toBeVisible();
  await expect(ollieCard.locator('.pill.bad')).toContainText(/missed/i);
  const row = ollieCard.locator('.parent-list-row', { hasText: 'Feed the chickens' });
  await expect(row.locator('.tag.missed')).toContainText(/missed/i);

  // The store is shared across the whole run, and a later test's premise is
  // that Ollie has nothing on. Retire the chore (the miss row it left is
  // dated today and counted from calendar items, so it goes quiet with it).
  await page.evaluate(async () => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    const fresh = await post({ action: 'state' });
    const chore = fresh.tasks.find((t) => t.title === 'Feed the chickens');
    if (chore) await post({ action: 'deleteTask', taskId: chore.id, parentId: 'peter', parentPin: '1234' });
  });
});

// The soccer case, rendered: the kid sees their prep list on the event, ticks
// it, and Packed only unlocks when everything is ticked. This is the surface
// the original prepLists[kidId] lookup bug kept blank - that code had never
// once run.
// Pete's screenshot: the flat calendar emoji hardcodes "JUL 17" in its
// artwork on Samsung/Apple, and with no real date anywhere the app appeared
// to claim the wrong day. The header now prints the actual date, and a
// submitted chore reads as dealt-with - struck through - rather than
// looking indistinguishable from still-to-do.
// The add form could make an event weekly; the edit flow could not - so a
// one-off could never be promoted once created. Edit now reuses the add form
// (prefilled, Save/Cancel, native pickers); this drives it and asserts the
// server ends up with recurrence set.
test('editing a one-off event can make it weekly', async ({ page }) => {
  const eventId = await page.evaluate(async () => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    const made = await post({
      action: 'addPlanningItem', parentId: 'peter', parentPin: '1234',
      type: 'event', title: 'Winter season opener', personId: 'ollie',
      startAt: new Date(Date.now() + 3 * 86400000).toISOString(),
    });
    return made.item.id;
  });

  await page.reload();
  await pickPerson(page, 'Peter');
  await page.getByRole('button', { name: /calendar/i }).first().click();

  // The edit flow is the real form now - prefilled, native pickers, no
  // browser prompts. Any prompt() firing is a regression.
  await page.evaluate(() => {
    window.prompt = () => { throw new Error('native prompt used by the edit flow'); };
  });
  await page.evaluate((id) => window.parentEditPlanningItem(id), eventId);

  // Prefilled, in edit mode, with the weekday echoed under Starts.
  await expect(page.locator('#p-plan-title')).toHaveValue('Winter season opener');
  await expect(page.locator('#p-plan-submit')).toHaveText('Save changes');
  await expect(page.locator('#p-plan-cancel')).toBeVisible();
  await expect(page.locator('#p-plan-start-echo')).toContainText(/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/);

  await page.locator('#p-plan-repeat').check();
  await page.locator('#p-plan-submit').click();

  // The form resets back to add mode after a save.
  await expect(page.locator('#p-plan-submit')).toHaveText('Add to calendar');
  await expect(page.locator('#p-plan-cancel')).toBeHidden();

  await expect.poll(async () => page.evaluate(async (id) => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    const cal = await post({
      action: 'calendar', parentId: 'peter', parentPin: '1234',
      start: new Date(Date.now() - 86400000).toISOString(),
      end: new Date(Date.now() + 20 * 86400000).toISOString(),
    });
    const rows = (cal.items || []).filter((i) => i.id === id);
    return rows.length ? rows[0].recurrence + ':' + rows.length : null;
  }, eventId)).toBe('weekly:3');

  await page.evaluate(async (id) => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    await post({ action: 'deletePlanningItem', planningItemId: id, parentId: 'peter', parentPin: '1234' });
  }, eventId);
});

test('the Today header shows the real date, and a submitted chore is struck through', async ({ page }) => {
  await page.evaluate(async () => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    await post({
      action: 'addTask', parentId: 'peter', parentPin: '1234',
      kidId: 'toby', title: 'Sweep the porch', points: 2, cycle: 'daily',
    });
  });
  await page.reload();
  await pickPerson(page, 'Toby');

  const expected = new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  await expect(page.locator('#k-today-date')).toHaveText(expected);

  const row = page.locator('.task', { hasText: 'Sweep the porch' }).first();
  await expect(row).toBeVisible();
  const before = await row.locator('.title').evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(before).not.toContain('line-through');
  await row.locator('.tick').click();
  await expect(row).toContainText(/waiting for a grown-up/i);
  const after = await row.locator('.title').evaluate((el) => getComputedStyle(el).textDecorationLine);
  expect(after, 'a submitted chore should be struck through').toContain('line-through');
});

test('a kid can tick their prep list and confirm packed', async ({ page }) => {
  const eventId = await page.evaluate(async () => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    const state = await post({ action: 'state' });
    // Two local days ahead, with the deadline overridden to tonight: prep
    // only opens on the day it is due, and the harness pins local time to
    // ~noon, so now+8h is this evening - open, not yet closed.
    const start = new Date(new Date(state.today + 'T12:00:00Z').getTime() + 2 * 86400000);
    const made = await post({
      action: 'addPlanningItem', parentId: 'peter', parentPin: '1234',
      type: 'event', title: 'Soccer match', personId: 'ollie',
      startAt: start.toISOString(),
      prepDueBy: new Date(Date.now() + 8 * 3600000).toISOString(),
      prepLists: [{ personId: 'ollie', points: 10, items: [{ text: 'boots' }, { text: 'shin pads' }] }],
    });
    return made.item.id;
  });

  await page.reload();
  await pickPerson(page, 'Ollie');

  const card = page.locator('.task', { hasText: 'Soccer match' }).first();
  await expect(card).toBeVisible();
  await expect(card.locator('.prep-item')).toHaveCount(2);

  // Appy, not wordy: both facts sit at the top of the card as pills - the
  // event chip (day + time) and the amber deadline chip - not a sentence
  // buried under the checklist.
  // The event chip carries a weekday and a time - whichever day the test's
  // two-days-out fixture lands on.
  const chips = card.locator('.event-chips .pill');
  await expect(chips.first()).toContainText(/🗓️ \w{3} \d{1,2}:\d{2}/);
  const deadlineChip = card.locator('.event-chips .pill.warn');
  await expect(deadlineChip).toContainText(/by /);
  await expect(card.locator('.event-chips .pill', { hasText: /⭐ 10/ })).toHaveCount(1);
  await expect(card).not.toContainText(/Pack in time/);

  const packed = card.getByRole('button', { name: /packed/i });
  await expect(packed).toBeDisabled();
  // And a disabled Packed must look disabled - it rendered fully opaque and
  // pressable with nothing ticked.
  const dimmed = await packed.evaluate((el) => Number(getComputedStyle(el).opacity) < 0.7);
  expect(dimmed, 'disabled Packed should be visibly dimmed').toBe(true);

  await card.locator('.prep-item input').nth(0).check();
  await card.locator('.prep-item input').nth(1).check();
  await expect(packed).toBeEnabled();
  await packed.click();

  // The confirmation is a completion pending the parent, worth the list.
  await expect.poll(async () => page.evaluate(async (id) => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    const fresh = await post({ action: 'state' });
    // Ids carry the occurrence date now that events can repeat weekly.
    const row = fresh.completions.find((c) =>
      c.id.startsWith('prep-' + id + '-') && c.id.endsWith('-ollie') && !c.id.startsWith('prep-miss-'));
    return row ? row.status + ':' + row.points : null;
  }, eventId)).toBe('pending:10');

  // Tidy: retire the event so later tests' premises hold.
  await page.evaluate(async (id) => {
    const real = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    await real({ action: 'deletePlanningItem', planningItemId: id, parentId: 'peter', parentPin: '1234' });
  }, eventId);
});

// Thursday's "uniform on" is a Thursday action, not a Tuesday one: prep only
// opens on the day it is due. An event two days out (default night-before
// deadline: due tomorrow) must render locked today, saying when it opens.
test('prep days away is locked until its due day', async ({ page }) => {
  const eventId = await page.evaluate(async () => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    const state = await post({ action: 'state' });
    const start = new Date(new Date(state.today + 'T12:00:00Z').getTime() + 2 * 86400000);
    const made = await post({
      action: 'addPlanningItem', parentId: 'peter', parentPin: '1234',
      type: 'event', title: 'Scouts night', personId: 'toby',
      startAt: start.toISOString(),
      prepLists: [{ personId: 'toby', points: 3, items: [{ text: 'Uniform on' }] }],
    });
    return made.item.id;
  });

  await page.reload();
  await pickPerson(page, 'Toby');

  const card = page.locator('.task', { hasText: 'Scouts night' }).first();
  await expect(card).toBeVisible();
  await expect(card.locator('.event-chips .pill', { hasText: /🔒 Opens/ })).toHaveCount(1);
  await expect(card.locator('.event-chips .pill.warn')).toHaveCount(0);
  await expect(card.locator('.prep-item input').first()).toBeDisabled();
  await expect(card.getByRole('button', { name: /packed/i })).toHaveCount(0);

  await page.evaluate(async (id) => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    await post({ action: 'deletePlanningItem', planningItemId: id, parentId: 'peter', parentPin: '1234' });
  }, eventId);
});

test('Parent HQ is headed by the parent, not a crown', async ({ page }) => {
  await pickPerson(page, 'Peter');
  const title = page.locator('#p-hq-title');
  await expect(title).toContainText('Peter');
  await expect(title).not.toContainText('\u{1F451}');
  const face = title.locator('.hq-face img.avatar-photo');
  await expect(face).toHaveCount(1);
  await expect(face).toHaveAttribute('src', /head-peter/);
  const loaded = await face.evaluate((el) => el.complete && el.naturalWidth > 0);
  expect(loaded).toBe(true);
});

// This previously asserted the artwork sat on the picker's header band. That
// was the mistake: it made the picker's tiles the bottom half of what should be
// a screen of its own. The artwork belongs to #screen-splash and the picker
// keeps its own gradient band.
test('the artwork actually loads rather than falling back to flat brand colour', async ({ page }) => {
  // A 404 leaves the brand-colour fallback, which looks deliberate rather than
  // broken - so the only way to catch it is to fetch the file.
  const status = await page.evaluate(async () => (await fetch('img/hero-splash.webp')).status);
  expect(status).toBe(200);

  // And the old header band is gone, not merely restyled.
  await expect(page.locator('.who-band')).toHaveCount(0);
});

// Existing households were created before the artwork existed. ensureSeeded()
// only creates records when the household is absent, so a changed seed alone
// would leave the live kids on their old placeholder SVGs - the #88 trap.
test('an existing household is migrated onto the photo avatars', async ({ page }) => {
  const emojis = await page.evaluate(async () => {
    const res = await fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'state' }),
    });
    const state = await res.json();
    return Object.fromEntries(state.people.map((p) => [p.id, p.emoji]));
  });
  expect(emojis.toby).toBe('img:toby');
  expect(emojis.ollie).toBe('img:ollie');
  expect(emojis.peter).toBe('img:peter');
  expect(emojis.tymanda).toBe('img:tymanda');
});

// App icons. A PWA icon fails silently - the launcher just shows a letter or a
// generic glyph, and nothing in the app looks wrong. These check the manifest
// still points at files that exist and are the size it claims.
test('every icon the manifest declares actually exists at its stated size', async ({ page }) => {
  const manifest = await page.evaluate(async () => (await fetch('manifest.json')).json());
  expect(manifest.icons.length).toBeGreaterThanOrEqual(4);

  for (const icon of manifest.icons) {
    const res = await page.evaluate(async (src) => {
      const r = await fetch(src);
      return { status: r.status, type: r.headers.get('content-type') };
    }, icon.src);
    expect(res.status, `${icon.src} is missing`).toBe(200);

    if (icon.sizes === 'any') continue;
    const [w, h] = icon.sizes.split('x').map(Number);
    const actual = await page.evaluate((src) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
      img.onerror = () => resolve([0, 0]);
      img.src = src;
    }), icon.src);
    expect(actual, `${icon.src} is not ${icon.sizes}`).toEqual([w, h]);
  }

  // A maskable icon must be full-bleed - the OS crops it to its own shape, so
  // transparent corners come out as holes.
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
});

test('the apple touch icon exists and is the size iOS expects', async ({ page }) => {
  const href = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  expect(href).toBeTruthy();
  const size = await page.evaluate((src) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve([img.naturalWidth, img.naturalHeight]);
    img.onerror = () => resolve([0, 0]);
    img.src = src;
  }), href);
  expect(size).toEqual([180, 180]);
});

// The artwork is the sign-in screen itself. It was, in order: a band at the top
// of the picker (which cut the picture in half), then a separate splash that
// held for two seconds and vanished. Now it is the screen you sign in on, so it
// stays up for as long as it takes someone to choose.
test('the sign-in screen is the artwork, with the faces on it', async ({ page }) => {
  const screen = page.locator('#screen-who');
  await expect(screen).toBeVisible();

  // The artwork is painted by ::after, with ::before behind it as a blurred
  // fill for the letterbox, so read the pseudo-element and not the box.
  const bg = await screen.evaluate((el) => getComputedStyle(el, '::after').backgroundImage);
  expect(bg).toContain('hero-splash.webp');

  // Four faces, in one row, at the foot of the screen - not a grid of cards
  // over the middle of the picture.
  const tiles = page.locator('.who-tile');
  await expect(tiles).toHaveCount(4);
  const boxes = [];
  for (let i = 0; i < 4; i += 1) boxes.push(await tiles.nth(i).boundingBox());
  // Within a couple of pixels, not identical: flex sizing lands on fractional
  // positions and rounding alone can split one row into two apparent values.
  const tops = boxes.map((b) => b.y);
  expect(Math.max(...tops) - Math.min(...tops), 'the faces should share one row')
    .toBeLessThanOrEqual(2);

  // Anchored in a panel at the foot, not floating on the artwork. Loose circles
  // in the sky read as decoration rather than as the way in.
  const view = page.viewportSize();
  expect(Math.min(...tops), 'the row should sit in the panel at the foot')
    .toBeGreaterThan(view.height * 0.6);

  // What this guards is that the panel is ANCHORED to the bottom edge, not
  // floated above it. The first version demanded exact equality and failed at
  // 721 vs 720; widened to 1px it failed again at 1.32px - on a pull request
  // that changed no frontend code at all, so pure runner-to-runner layout
  // rounding. Nudging an epsilon up a pixel each time it fires is the wrong
  // fix. The threshold now has a rationale instead: the smallest spacing
  // token in the design system is 4px (--space-1), so any DELIBERATE gap
  // would measure at least that - anything under it can only be rounding.
  const panel = await page.locator('.who-sheet').boundingBox();
  expect(Math.abs(panel.y + panel.height - view.height), 'the panel should meet the bottom edge')
    .toBeLessThan(4);

  // Every person is the same kind of control: same circle, same ring, same name.
  // Sized from content, an emoji glyph is narrower than a photo and the four
  // came out at different sizes on different baselines.
  // Compared with a tolerance rather than as strings: rounding fractional
  // positions to ints can land two identical circles on different labels and
  // fail a test that has found nothing wrong.
  const circles = await page.locator('.who-tile .tile-emoji').evaluateAll(
    (els) => els.map((e) => {
      const r = e.getBoundingClientRect();
      return { w: r.width, h: r.height, y: r.y };
    }),
  );
  const spread = (key) => Math.max(...circles.map((c) => c[key])) - Math.min(...circles.map((c) => c[key]));
  expect(spread('w'), 'all four avatars should be the same width').toBeLessThanOrEqual(1);
  expect(spread('h'), 'all four avatars should be the same height').toBeLessThanOrEqual(1);
  expect(spread('y'), 'all four avatars should share one baseline').toBeLessThanOrEqual(1);
});

test('the sign-in screen has no prompt text on it', async ({ page }) => {
  await expect(page.locator('#screen-who')).not.toContainText('Who are you');
  // Names are drawn again now there is a panel to hold them.
  await expect(page.locator('.who-tile').filter({ hasText: 'Toby' })).toHaveCount(1);
  await expect(page.locator('.who-tile').filter({ hasText: 'Peter' })).toHaveCount(1);
});

test('there is no separate splash screen to sit through', async ({ page }) => {
  await expect(page.locator('#screen-splash')).toHaveCount(0);
  // Signing in is reachable immediately, not after a timed hold.
  await expect(page.locator('.who-tile').first()).toBeVisible({ timeout: 3000 });
});

// This one shipped cropped, and the test it replaces is why. The artwork is
// 0.449 wide-to-tall - narrower than any real phone - so `cover` scaled it to
// the width and pushed the surplus height off the bottom, which is where the
// ball, the boots and the foreground are. 3% lost on a tall installed phone,
// 20% on an iPhone SE. The old test asserted `cover` at 412x915, and 412x915 is
// 0.450: the single viewport where that crop is invisible. Walking one point is
// not coverage when the failure is a function of the ratio - walk the range.
test('the artwork is never cropped, on any screen', async ({ page }) => {
  const VIEWS = [
    [375, 667, 'iPhone SE'],
    [390, 720, 'iPhone, browser chrome'],
    [412, 780, 'Android, browser chrome'],
    [360, 740, 'Galaxy, installed'],
    [390, 844, 'iPhone, installed'],
    [412, 915, 'Pixel, installed'],
    [768, 1024, 'tablet'],
    [1280, 800, 'laptop, landscape'],
  ];
  for (const [width, height, name] of VIEWS) {
    await page.setViewportSize({ width, height });
    const size = await page.locator('#screen-who').evaluate(
      (el) => getComputedStyle(el, '::after').backgroundSize);
    expect(size, `${name} (${width}x${height}) should show the whole picture`)
      .toBe('contain');
  }
});

// `contain` leaves bars on a squarer screen. They are filled with a blurred,
// over-scanned copy of the artwork so its own colours reach the edge, rather
// than a slab of flat brand purple beside the picture.
test('the letterbox is filled with the artwork, not a flat slab', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const fill = await page.locator('#screen-who').evaluate((el) => {
    const s = getComputedStyle(el, '::before');
    return { image: s.backgroundImage, size: s.backgroundSize, filter: s.filter };
  });
  expect(fill.image, 'the fill should be the artwork itself').toContain('hero-splash.webp');
  expect(fill.size).toBe('cover');
  expect(fill.filter, 'the fill should be blurred, not a second sharp copy').toContain('blur');
});

// #183 capped these with max-width and auto margins. .who-sheet is a flex item
// in a column container, where auto cross-axis margins override align-self:
// stretch - so it collapsed to its content width and the picker rendered 273px
// wide on a 412px phone.
test('the sign-in bar spans the phone screen rather than collapsing to its content', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  const sheet = await page.locator('.who-sheet').boundingBox();
  expect(Math.round(sheet.width)).toBe(412);
  expect(Math.round(sheet.x)).toBe(0);
});

// Twice now the sign-in bar has drifted back into being a box sitting on the
// artwork - first a solid coloured panel, then a frosted one. What draws the
// box is an edge: a flat fill, a blur boundary or a hairline along the top all
// give the eye a line to find, at any opacity. The bar is a gradient that fades
// out upwards instead, so there is no edge to see. This guards the shape of the
// thing rather than an exact colour, which is free to be retuned.
test('the sign-in bar is a fading scrim, not a panel with an edge', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  const style = await page.locator('.who-sheet').evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      image: s.backgroundImage,
      colour: s.backgroundColor,
      topBorder: s.borderTopWidth,
      blur: s.backdropFilter || s.webkitBackdropFilter,
    };
  });
  expect(style.image, 'the bar should be a gradient').toContain('gradient');
  expect(style.colour, 'no flat fill under the gradient').toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  expect(parseFloat(style.topBorder), 'no hairline along the top').toBe(0);
  expect(style.blur || 'none', 'no blur boundary').toBe('none');

  // And it stays a thin strip: a tenth of the screen or so, not a fifth.
  const sheet = await page.locator('.who-sheet').boundingBox();
  expect(sheet.height / 915, 'the bar should stay under an eighth of the screen')
    .toBeLessThan(0.125);
});

// "Appy not wordy". Parent HQ reported zero with a four-line empty state, three
// times on one screen, and put "Today's chores overview" under every kid's name.
// Status is a colour and two words now.
test('a kid card reports status as pills, not paragraphs', async ({ page }) => {
  await page.evaluate(async () => {
    const post = (b) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
    }).then((r) => r.json());
    await post({ action: 'addTask', parentId: 'peter', parentPin: '1234', kidId: 'toby', title: 'Pill check chore', points: 3, cycle: 'daily' });
    const st = await post({ action: 'state' });
    const t = st.tasks.find((x) => x.title === 'Pill check chore');
    await post({ action: 'completeTask', personId: 'toby', pin: '1234', taskId: t.id });
  });
  await page.reload();
  await pickPerson(page, 'Peter');

  const cards = page.locator('#p-approvals-today-by-kid .parent-card');
  const toby = cards.filter({ hasText: 'Toby' });
  await expect(toby.locator('.pill.warn')).toContainText(/\d+ pending/);
  // No "N chores" total pill: with a single chore it read as the same thing
  // counted twice. The breakdown pills carry the whole story.
  await expect(toby.locator('.pill', { hasText: /chore/ })).toHaveCount(0);

  // The pill describes the kid's day, not the parent's inbox: with a chore
  // pending there is no green pill, and a kid with an untouched chore says
  // "to do" rather than "All caught up" beside a Not started row.
  await expect(toby.locator('.pill.good')).toHaveCount(0);
  const ollie = cards.filter({ hasText: 'Ollie' });
  const ollieText = await ollie.textContent();
  expect(/All caught up/.test(ollieText || '')).toBe(false);

  // The filler subtitle is gone from every card.
  await expect(page.locator('#p-approvals-today-by-kid')).not.toContainText('chores overview');
});

test('a kid with nothing on gets one pill, not an empty state', async ({ page }) => {
  await pickPerson(page, 'Peter');
  const ollie = page.locator('#p-approvals-today-by-kid .parent-card').filter({ hasText: 'Ollie' });
  // "Nothing on today", stated once - not a green "caught up" claim, and not
  // an emoji-and-two-sentences block explaining that zero means zero.
  await expect(ollie.locator('.pill.neutral')).toContainText('Nothing on today');
  await expect(ollie.locator('.empty')).toHaveCount(0);
});

// The strip counted chores only, so a kid with a scout hike on today read
// "Nothing on today" while the calendar showed the hike on the same day.
test('an event on today shows on that kid\u2019s today strip, matching the calendar', async ({ page }) => {
  const title = 'Smoke Hike ' + Date.now();
  await page.evaluate(async (eventTitle) => {
    const startAt = new Date();
    startAt.setHours(16, 0, 0, 0);
    await fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'addPlanningItem', parentId: 'peter', parentPin: '1234',
        type: 'event', title: eventTitle, startAt: startAt.toISOString(), personId: 'toby',
      }),
    });
  }, title);
  await page.reload();
  await pickPerson(page, 'Peter');

  const toby = page.locator('#p-approvals-today-by-kid .parent-card').filter({ hasText: 'Toby' });
  await expect(toby).toContainText(title);
  await expect(toby).not.toContainText('Nothing on today');
});

// Zero is stated once, on the tile - the card containers below stay empty
// rather than adding a pill or a paragraph to repeat it.
test('empty waiting sections are a zero on the tile, not filler text', async ({ page }) => {
  await pickPerson(page, 'Peter');
  await expect(page.locator('#p-stat-rewards .stat-num')).toHaveText('0');
  await expect(page.locator('#p-reward-requests')).toBeEmpty();
  await expect(page.locator('#p-tab-approvals')).not.toContainText('will show up here');
});

// The kids have photos now; the approval card was still drawing the emoji
// fallback while the cards right below it showed the real face.
test('approval cards use the kid photo, matching the cards below', async ({ page }) => {
  await page.evaluate(async () => {
    const post = (b) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
    }).then((r) => r.json());
    await post({ action: 'addTask', parentId: 'peter', parentPin: '1234', kidId: 'toby', title: 'Face check chore', points: 1, cycle: 'oneoff' });
    const st = await post({ action: 'state' });
    const t = st.tasks.find((x) => x.title === 'Face check chore');
    await post({ action: 'completeTask', personId: 'toby', pin: '1234', taskId: t.id });
  });
  await page.reload();
  await pickPerson(page, 'Peter');

  const card = page.locator('#p-pending .parent-card').filter({ hasText: 'Face check chore' });
  await expect(card.locator('img.avatar-photo')).toHaveCount(1);
});

// Calendar. Replaces Day/Week/Month chips with one month you arrow through, a
// pinned "this week" strip, and an agenda that expands inline on the same
// screen. Dots are coloured per PERSON, which is what removes the need for a
// legend - the colour already means something from the avatars and cards.
async function seedCalendar(page) {
  await page.evaluate(async () => {
    const post = (b) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
    }).then((r) => r.json());
    const at = (offset, hour) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      d.setHours(hour, 0, 0, 0);
      return d.toISOString();
    };
    await post({ action: 'addPlanningItem', parentId: 'peter', parentPin: '1234', type: 'event', title: 'Soccer match', startAt: at(2, 10), personId: 'ollie' });
    await post({ action: 'addPlanningItem', parentId: 'peter', parentPin: '1234', type: 'event', title: 'Dentist', startAt: at(2, 14), personId: 'toby' });
  });
  await page.reload();
}

async function openParentCalendar(page) {
  await pickPerson(page, 'Peter');
  await page.getByRole('button', { name: /^Calendar$/ }).first().click();
  await expect(page.locator('#p-calendar-grid .cal-cell').first()).toBeVisible();
}

test('the calendar is one month you arrow through, not a view switcher', async ({ page }) => {
  await openParentCalendar(page);

  // The old Day/Week/Month chips are gone, not restyled.
  await expect(page.locator('#p-calendar-view-day')).toHaveCount(0);
  await expect(page.locator('#p-calendar-view-month')).toHaveCount(0);

  const label = page.locator('#p-calendar-range');
  const start = await label.textContent();
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect(label).not.toHaveText(start);
  await page.getByRole('button', { name: 'Previous month' }).click();
  await expect(label).toHaveText(start);
});

test('a this-week strip is pinned above the grid, with no tapping needed', async ({ page }) => {
  await openParentCalendar(page);
  await expect(page.locator('#p-calendar-week .cal-chip')).toHaveCount(7);

  // It is above the month grid, and it moves independently of the month.
  const strip = await page.locator('#p-calendar-week').boundingBox();
  const grid = await page.locator('#p-calendar-grid').boundingBox();
  expect(strip.y).toBeLessThan(grid.y);

  const first = await page.locator('#p-calendar-week .cal-chip-num').first().textContent();
  await page.getByRole('button', { name: 'Next week' }).click();
  await expect(page.locator('#p-calendar-week .cal-chip-num').first()).not.toHaveText(first);
});

test('dots are coloured per person, and there is no legend', async ({ page }) => {
  await seedCalendar(page);
  await openParentCalendar(page);

  // Two people have something on the same day, so that day carries two dots in
  // two different colours. One dot per person, not per item.
  const busy = page.locator('#p-calendar-grid .cal-cell').filter({ has: page.locator('.cal-dot') });
  expect(await busy.count()).toBeGreaterThan(0);

  const colours = await page.locator('#p-calendar-grid .cal-cell .cal-dot').evaluateAll(
    (els) => [...new Set(els.map((e) => e.style.background))],
  );
  expect(colours.length, 'different people should get different dot colours').toBeGreaterThan(1);

  await expect(page.locator('#p-tab-calendar')).not.toContainText(/legend/i);
});

// The prep-list controls were defined but never rendered - every checklist
// in production had been created by the seed, and a parent had no way to
// build one in the app. Event rows in the agenda now carry a Checklist
// toggle that opens the lists and the add/set-points controls.
test('a parent can open an event checklist and add a prep item', async ({ page }) => {
  await seedCalendar(page);

  // #164: adding a prep item is an inline row in the kid's own section - no
  // dialogs of any kind. A native prompt firing is a regression.
  page.on('dialog', (dialog) => dialog.dismiss());

  await openParentCalendar(page);
  // Select the seeded day directly: in the full suite, earlier tests leave
  // chores dotting today, so "first busy cell" can land on a day with no
  // events at all. Day-tapping itself is covered by the agenda test below.
  await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    parentCalendarSelectedDay = d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');
    renderParentCalendar();
  });

  const agenda = page.locator('#p-calendar-agenda');
  await agenda.getByRole('button', { name: /Checklist/ }).first().click();
  const wrap = agenda.locator('.cal-checklist-wrap');
  await expect(wrap).toBeVisible();

  // Type into Ollie's own section and hit its Add - no which-kid dialog.
  const ollieInput = wrap.locator('input[id^="prep-add-"][id$="-ollie"]');
  await ollieInput.fill('Bring a hat');
  await wrap.locator('input[id^="prep-add-"][id$="-ollie"] + button').click();
  await expect(wrap).toContainText('Bring a hat');
  await expect(wrap.getByRole('button', { name: /Set pts/ }).first()).toBeVisible();
});

test('tapping a day expands its agenda inline, without leaving the screen', async ({ page }) => {
  await seedCalendar(page);
  await openParentCalendar(page);

  await expect(page.locator('#p-calendar-agenda')).toContainText('Tap a day');

  const busy = page.locator('#p-calendar-grid .cal-cell').filter({ has: page.locator('.cal-dot') }).first();
  await busy.click();

  // Same screen: the grid is still there, with the agenda under it.
  await expect(page.locator('#p-calendar-grid')).toBeVisible();
  const agenda = page.locator('#p-calendar-agenda');
  await expect(agenda).not.toContainText('Tap a day');
  const grid = await page.locator('#p-calendar-grid').boundingBox();
  const box = await agenda.boundingBox();
  expect(box.y).toBeGreaterThan(grid.y);

  // Tapping the open day again closes it, so the grid never gets stuck open.
  await busy.click();
  await expect(agenda).toContainText('Tap a day');
});

// ───────────────────────── Email proposals (#41) ─────────────────────────

// Drives the real ingest route with the harness key, exactly as the email
// Function will. Distinct externalRefs per test: the store lives for the
// whole run and same-email ingests are deliberately idempotent.
//
// And distinct per RUN, which is why the suffix exists. The database is the
// live one and outlives the run, so a fixed ref meant the second run's ingest
// found the first run's approved item and returned a duplicate instead of a
// fresh card - leaving the approve test clicking a card that was not there and
// looking for a calendar row dated days earlier.
let proposalSeq = 0;
async function seedProposal(page, overrides) {
  proposalSeq += 1;
  const unique = `${overrides.externalRef}-${Date.now()}-${proposalSeq}`;
  overrides = { ...overrides, externalRef: unique };
  return page.evaluate(async (extra) => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    const start = new Date();
    start.setDate(start.getDate() + 2);
    start.setHours(9, 0, 0, 0);
    return post(Object.assign({
      action: 'ingestEmailItem', ingestKey: 'smoke-ingest-key',
      classification: 'kid-choice', type: 'event',
      startAt: start.toISOString(),
    }, extra));
  }, overrides);
}

test('an email proposal reaches the parent queue with its payment details', async ({ page }) => {
  await seedProposal(page, {
    externalRef: 'smoke-email-hike', title: 'Smoke Track Hike', personId: 'ollie',
    summary: 'Overnight hike with the unit.',
    payments: [{ description: 'Hike fee', amount: '$5', bank: 'Westpac', bsb: '036-022', account: '624871', reference: 'Ollie' }],
  });
  await page.reload();
  await pickPerson(page, 'Peter');

  const tile = page.locator('#p-stat-proposals .stat-num');
  await expect(tile).not.toHaveText('0');

  const card = page.locator('#p-proposals .parent-card').filter({ hasText: 'Smoke Track Hike' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('waiting on Ollie');
  await expect(card).toContainText('Hike fee — $5');
  await expect(card).toContainText('BSB: 036-022');
  // The deadline the parent can adjust is a real input, prefilled or not.
  await expect(card.locator('input.proposal-due')).toBeVisible();
});

test('a kid can put a hand up, and the parent card shows it', async ({ page }) => {
  await seedProposal(page, {
    externalRef: 'smoke-email-camp', title: 'Smoke Scout Camp', personId: 'toby',
  });
  await page.reload();
  await pickPerson(page, 'Toby');

  const kidCard = page.locator('#k-proposals .task').filter({ hasText: 'Smoke Scout Camp' });
  await expect(kidCard).toBeVisible();
  await kidCard.getByRole('button', { name: /I want to go/ }).click();
  await expect(kidCard).toContainText('You said yes');

  await page.getByRole('button', { name: /Switch/ }).click();
  await pickPerson(page, 'Peter');
  const parentCard = page.locator('#p-proposals .parent-card').filter({ hasText: 'Smoke Scout Camp' });
  await expect(parentCard).toContainText('wants to go');
});

test('an email that names no kid is offered to both of them', async ({ page }) => {
  await seedProposal(page, {
    externalRef: 'smoke-email-both', title: 'Smoke Holiday Workshop', personId: null,
  });
  await page.reload();
  await pickPerson(page, 'Toby');
  await expect(page.locator('#k-proposals .task').filter({ hasText: 'Smoke Holiday Workshop' }))
    .toBeVisible();

  await page.getByRole('button', { name: /Switch/ }).click();
  await pickPerson(page, 'Ollie');
  const ollieCard = page.locator('#k-proposals .task').filter({ hasText: 'Smoke Holiday Workshop' });
  await expect(ollieCard).toBeVisible();
  await ollieCard.getByRole('button', { name: /Not for me/ }).click();
  await expect(ollieCard).toContainText('not this time');

  // Ollie passing leaves it live for Toby, and the parents still see it.
  await page.getByRole('button', { name: /Switch/ }).click();
  await pickPerson(page, 'Peter');
  const parentCard = page.locator('#p-proposals .parent-card').filter({ hasText: 'Smoke Holiday Workshop' });
  await expect(parentCard).toContainText('Either kid');
  await expect(parentCard).toContainText('waiting on Toby');
});

test('approving a proposal puts it on the calendar, badged as from email', async ({ page }) => {
  await seedProposal(page, {
    externalRef: 'smoke-email-fair', title: 'Smoke School Fair', personId: 'ollie',
  });
  await page.reload();
  await pickPerson(page, 'Peter');

  const card = page.locator('#p-proposals .parent-card').filter({ hasText: 'Smoke School Fair' });
  await card.getByRole('button', { name: /Approve/ }).click();
  await expect(card).toBeHidden();

  await page.getByRole('button', { name: /^Calendar$/ }).first().click();
  await expect(page.locator('#p-calendar-grid .cal-cell').first()).toBeVisible();
  const agenda = page.locator('#p-calendar-agenda');
  const row = agenda.locator('.parent-list-row').filter({ hasText: 'Smoke School Fair' });
  // A background refresh re-enters the loading state and blanks the agenda,
  // which can land between choosing the day and reading it. Choose and read as
  // one retried step rather than assuming the first attempt survives.
  await expect(async () => {
    await page.evaluate(() => {
      const d = new Date();
      d.setDate(d.getDate() + 2);
      parentCalendarSelectedDay = d.getFullYear() + '-'
        + String(d.getMonth() + 1).padStart(2, '0') + '-'
        + String(d.getDate()).padStart(2, '0');
      renderParentCalendar();
    });
    await expect(row).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20000 });
  await expect(row).toContainText('📧 from email');
});

test('declining a proposal removes it and publishes nothing', async ({ page }) => {
  await seedProposal(page, {
    externalRef: 'smoke-email-disco', title: 'Smoke School Disco', personId: 'ollie',
  });
  await page.reload();
  await pickPerson(page, 'Peter');

  const card = page.locator('#p-proposals .parent-card').filter({ hasText: 'Smoke School Disco' });
  await card.getByRole('button', { name: /Decline/ }).click();
  // The in-app confirm, never a native dialog.
  await page.locator('#ask-modal').getByRole('button', { name: /Decline/ }).click();
  await expect(card).toBeHidden();

  await page.getByRole('button', { name: /^Calendar$/ }).first().click();
  await expect(page.locator('#p-calendar-grid .cal-cell').first()).toBeVisible();
  await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    parentCalendarSelectedDay = d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');
    renderParentCalendar();
  });
  await expect(page.locator('#p-calendar-agenda')).not.toContainText('Smoke School Disco');
});

test('a parent-direct email never asks the kid', async ({ page }) => {
  await seedProposal(page, {
    externalRef: 'smoke-email-ipad', title: 'Smoke iPad Payment',
    classification: 'parent-direct', personId: 'toby',
  });
  await page.reload();
  await pickPerson(page, 'Toby');
  await expect(page.locator('#k-proposals')).not.toContainText('Smoke iPad Payment');

  await page.getByRole('button', { name: /Switch/ }).click();
  await pickPerson(page, 'Peter');
  const card = page.locator('#p-proposals .parent-card').filter({ hasText: 'Smoke iPad Payment' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('needs a parent');
  await expect(card).not.toContainText('waiting on');
});

// #244: on a phone-width screen the agenda row's three action buttons crushed
// the text column to nothing and rendered over the title. The row must wrap:
// buttons drop below the details when there is no room beside them.
test('agenda action buttons never sit over the event title on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  await seedCalendar(page);
  await openParentCalendar(page);
  await page.evaluate(() => {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    parentCalendarSelectedDay = d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');
    renderParentCalendar();
  });

  // seedCalendar has run for several earlier tests by now, so the day holds
  // one 'Soccer match' per run of it - any single row will do.
  const row = page.locator('#p-calendar-agenda .parent-list-row').filter({ hasText: 'Soccer match' }).first();
  const title = row.locator('.parent-list-title');
  await expect(title).toBeVisible();
  const titleBox = await title.boundingBox();
  for (const name of [/Checklist/, /^Edit$/, /^Delete$/]) {
    const btn = row.getByRole('button', { name });
    await expect(btn).toBeVisible();
    const btnBox = await btn.boundingBox();
    const overlaps = !(
      btnBox.x >= titleBox.x + titleBox.width
      || btnBox.x + btnBox.width <= titleBox.x
      || btnBox.y >= titleBox.y + titleBox.height
      || btnBox.y + btnBox.height <= titleBox.y
    );
    expect(overlaps, `button ${name} must not cover the title`).toBe(false);
  }

  // The text column keeps a readable width - before the fix the time/who line
  // stacked one character per line.
  const subBox = await row.locator('.sub').first().boundingBox();
  expect(subBox.width).toBeGreaterThan(120);
});
