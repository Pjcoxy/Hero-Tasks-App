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

  await page.locator('#k-goal-carousel .goal-card').nth(1).click();

  await expect(page.locator('#tab-rewards')).toBeVisible();
  await expect(page.locator('#tab-home')).toBeHidden();

  // The row it landed on must be the prize that was tapped, and it must be the
  // one in view - not just present somewhere in the list.
  const row = page.locator('#k-rewards .task').filter({ hasText: "Ice cream from McDonald's" });
  await expect(row).toBeVisible();
  await expect(row).toBeInViewport();
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
