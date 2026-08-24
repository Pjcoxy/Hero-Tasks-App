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

  await expect(page.getByRole('heading', { name: /^📅 Today$/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /This Week/ })).toBeVisible();

  // Both must resolve to real content or a real empty state - never a permanent
  // skeleton, which is what a broken fetch looks like.
  await expect(page.locator('#k-glance-today')).not.toBeEmpty();
  await expect(page.locator('#k-glance-week')).not.toBeEmpty();
  await expect(page.locator('#k-glance-today .glance-skel')).toHaveCount(0);
  await expect(page.locator('#k-glance-week .glance-skel')).toHaveCount(0);
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
// the top of it, not below two sections of context.
test('Approvals opens with what is waiting on the parent, at the top', async ({ page }) => {
  await pickPerson(page, 'Peter');

  const headings = await page.locator('#p-tab-approvals .parent-section-title').allTextContents();
  expect(headings[0]).toMatch(/Awaiting your approval/);
  expect(headings[1]).toMatch(/Reward requests/);
  expect(headings.slice(2).join(' ')).toMatch(/Today, by kid/);
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

test('declining asks why, and the reason reaches the kid', async ({ page }) => {
  await seedPendingChore(page, 'Sweep the porch');
  await page.reload();
  await pickPerson(page, 'Peter');

  const card = page.locator('#p-pending .parent-card').filter({ hasText: 'Sweep the porch' });
  await card.getByRole('button', { name: /Nope/ }).click();

  // The dialog must be the in-app one, and it must ask for the fix.
  await expect(page.locator('#ask-modal')).toBeVisible();
  await expect(page.locator('#ask-title')).toContainText('get this approved');

  // Sending it back empty must not go through.
  await page.locator('#ask-ok').click();
  await expect(page.locator('#toast')).toContainText('Tell them what to fix');
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: /Nope/ }).click();
  await page.locator('#ask-input').fill('The step by the door is still dusty.');
  await page.locator('#ask-ok').click();
  await expect(card).toBeHidden();

  // Now the part that matters: the kid can read it on their own screen.
  await page.getByRole('button', { name: /Switch user/ }).click();
  await pickPerson(page, 'Toby');
  const activity = page.locator('#k-activity').filter({ hasText: 'Sweep the porch' });
  await expect(activity).toContainText('The step by the door is still dusty.');
});

test('approving can carry a note, and the fast path still needs one tap', async ({ page }) => {
  await seedPendingChore(page, 'Water the plants');
  await page.reload();
  await pickPerson(page, 'Peter');

  const card = page.locator('#p-pending .parent-card').filter({ hasText: 'Water the plants' });
  // The aria-label is the accessible name, so match on that rather than the
  // visible "💬 With note" - they deliberately differ.
  await card.getByRole('button', { name: /approve with a note/i }).click();
  await page.locator('#ask-input').fill('Great job, the pots look happy.');
  await page.locator('#ask-ok').click();
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
    return {
      days: task.days,
      error: cal.error || null,
      ok: cal.ok === true,
      weekdays: [...new Set(mine.map((i) => new Date(i.occurrenceAt).getUTCDay()))].sort(),
      count: mine.length,
    };
  });

  expect(result.error, 'the calendar call should succeed').toBe(null);
  expect(result.ok, 'the calendar call should succeed').toBe(true);
  expect(result.days, 'the chosen days come back on the task').toEqual([1, 3, 5]);
  expect(result.weekdays, 'it lands on Mon, Wed and Fri and nothing else').toEqual([1, 3, 5]);
  expect(result.count, 'three days a week, across two weeks').toBe(6);
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

// The family view: yesterday, per kid, from the recorded facts. Until misses
// were recorded there was nothing truthful this panel could have said - every
// morning looked identical however the day before went. Yesterday-dated rows
// cannot be created through the real routes (the API stamps today), so this
// drives the real renderer over planted records - the same lexical `state`
// the page itself renders from.
test('yesterday shows each kid\u2019s done and missed, from the records', async ({ page }) => {
  await pickPerson(page, 'Peter');
  await page.evaluate(() => {
    const y = new Date(new Date(state.today + 'T12:00:00Z').getTime() - 86400000)
      .toISOString().slice(0, 10);
    state.completions.push(
      { id: 'y1', taskId: 't-veg', kidId: 'toby', title: 'Water the veggies', points: 3, date: y, status: 'approved' },
      { id: 'y2', taskId: 't-bins', kidId: 'toby', title: 'Bins out', points: 5, date: y, status: 'missed' },
    );
    renderParentYesterday();
  });

  const tobyCard = page.locator('#p-yesterday .parent-card', { hasText: 'Toby' });
  await expect(tobyCard).toBeVisible();
  await expect(tobyCard.locator('.pill.good')).toContainText('1 done');
  await expect(tobyCard.locator('.pill.bad')).toContainText('1 missed');
  await expect(tobyCard.locator('.parent-list-row', { hasText: 'Bins out' }).locator('.tag.missed'))
    .toContainText(/missed/i);
  await expect(tobyCard.locator('.parent-list-row', { hasText: 'Water the veggies' }).locator('.tag.approved'))
    .toContainText(/done/i);
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
test('a kid can tick their prep list and confirm packed', async ({ page }) => {
  const eventId = await page.evaluate(async () => {
    const post = (body) => fetch('https://herotasks-func-dev.azurewebsites.net/api/hero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    const state = await post({ action: 'state' });
    // Two local days ahead, so the night-before deadline cannot be shut
    // whatever hour this runs.
    const start = new Date(new Date(state.today + 'T12:00:00Z').getTime() + 2 * 86400000);
    const made = await post({
      action: 'addPlanningItem', parentId: 'peter', parentPin: '1234',
      type: 'event', title: 'Soccer match', personId: 'ollie',
      startAt: start.toISOString(),
      prepLists: [{ personId: 'ollie', points: 10, items: [{ text: 'boots' }, { text: 'shin pads' }] }],
    });
    return made.item.id;
  });

  await page.reload();
  await pickPerson(page, 'Ollie');

  const card = page.locator('.task', { hasText: 'Soccer match' }).first();
  await expect(card).toBeVisible();
  await expect(card.locator('.prep-item')).toHaveCount(2);

  const packed = card.getByRole('button', { name: /packed/i });
  await expect(packed).toBeDisabled();

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
    const row = fresh.completions.find((c) => c.id === 'prep-' + id + '-ollie');
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
  await expect(toby.locator('.pill.neutral')).toContainText(/chore/);

  // The filler subtitle is gone from every card.
  await expect(page.locator('#p-approvals-today-by-kid')).not.toContainText('chores overview');
});

test('a kid with nothing on gets one pill, not an empty state', async ({ page }) => {
  await pickPerson(page, 'Peter');
  const ollie = page.locator('#p-approvals-today-by-kid .parent-card').filter({ hasText: 'Ollie' });
  await expect(ollie.locator('.pill.good')).toContainText('All caught up');
  // No emoji-and-two-sentences block explaining that zero means zero.
  await expect(ollie.locator('.empty')).toHaveCount(0);
});

test('empty parent sections are a pill, not a paragraph', async ({ page }) => {
  await pickPerson(page, 'Peter');
  await expect(page.locator('#p-reward-requests .pill')).toContainText('0 requests');
  await expect(page.locator('#p-reward-requests')).not.toContainText('will show up here');
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
