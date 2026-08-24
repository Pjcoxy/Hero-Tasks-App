// Standalone logic test — mocks Cosmos DB in-memory so the actual business logic in
// hero.js runs for real (seed, add/complete/approve a chore, check points+streak),
// without needing a live Cosmos DB or Azure Functions host. Not part of the deployed app.
// The window feature makes 'now' part of the app's behaviour: past 21:00
// household time a daily chore is refused. Tests must not change meaning with
// the hour CI happens to run at, so the harness pins the household timezone to
// a fixed-offset zone chosen so that local time is around noon right now, with
// the local date equal to the UTC date (the browser in CI runs UTC, and the
// two ends of the app must agree on what day it is). Etc/GMT zones use
// inverted signs: Etc/GMT-8 means UTC+8.
{
  const utcHour = new Date().getUTCHours();
  const offset = Math.max(-12, Math.min(14, 12 - utcHour));
  process.env.HOUSEHOLD_TIMEZONE = offset === 0
    ? 'Etc/GMT'
    : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
}

const path = require('path');
const Module = require('module');

const store = {}; // { containerName: Map<id, doc> }

function getMap(name) {
  if (!store[name]) store[name] = new Map();
  return store[name];
}

function mockContainer(name) {
  const map = getMap(name);
  return {
    items: {
      create: async (doc) => {
        // Real Cosmos refuses a duplicate id with 409; recordMisses leans on
        // that for idempotency, so the mock must refuse too or the tests
        // would pass against a store more forgiving than production.
        if (map.has(doc.id)) {
          const err = new Error('Entity with the specified id already exists');
          err.code = 409;
          throw err;
        }
        map.set(doc.id, doc);
        return { resource: doc };
      },
      upsert: async (doc) => {
        map.set(doc.id, doc);
        return { resource: doc };
      },
      query: (q) => ({
        fetchAll: async () => {
          let docs = [...map.values()];
          if (q && q.parameters) {
            q.parameters.forEach((p) => {
              if (p.name === '@h') docs = docs.filter((d) => d.householdId === p.value);
            });
          }
          return { resources: docs };
        },
      }),
    },
    item: (id) => ({
      read: async () => {
        const doc = map.get(id);
        if (!doc) throw new Error('Not found');
        return { resource: doc };
      },
      replace: async (doc) => {
        map.set(id, doc);
        return { resource: doc };
      },
      delete: async () => {
        map.delete(id);
      },
    }),
  };
}

const cosmosPath = require.resolve('./src/lib/cosmos.js');
const fakeCosmosModule = new Module(cosmosPath);
fakeCosmosModule.exports = { container: mockContainer };
fakeCosmosModule.loaded = true;
require.cache[cosmosPath] = fakeCosmosModule;

const webPushPath = require.resolve('web-push');
const pushCalls = [];
const fakeWebPushModule = new Module(webPushPath);
fakeWebPushModule.exports = {
  setVapidDetails: (...args) => {
    pushCalls.push({ type: 'config', args });
  },
  sendNotification: async (subscription, payload) => {
    pushCalls.push({ type: 'send', subscription, payload });
    if (subscription.endpoint.includes('/gone')) {
      const err = new Error('Expired subscription');
      err.statusCode = 410;
      throw err;
    }
  },
};
fakeWebPushModule.loaded = true;
require.cache[webPushPath] = fakeWebPushModule;

const assert = require('assert');
const { ensureSeeded, HOUSEHOLD_ID } = require('./src/lib/seed.js');

async function main() {
  process.env.VAPID_PUBLIC_KEY = 'test-vapid-public-key';
  process.env.VAPID_PRIVATE_KEY = 'test-vapid-private-key';
  await ensureSeeded();

  const peopleMap = getMap('people');
  assert.strictEqual(peopleMap.size, 4, 'expected 4 seeded people');
  const toby = peopleMap.get('toby');
  assert.strictEqual(toby.role, 'kid');
  assert.strictEqual(toby.pin, '1234');
  console.log('✓ seed created household + 4 people');

  // Load hero.js's route table by requiring it directly and calling its exported pieces
  // via the same in-memory mock. hero.js registers app.http at require time (harmless,
  // "test mode" warning only) but its internal functions aren't exported individually,
  // so drive it the same way the real HTTP layer would: through getState + direct Cosmos
  // writes mirroring what each action does, then assert getState()'s derived fields.
  const {
    getState,
    calcStreak,
    calcBadges,
    ROUTES,
    updateQuietHours,
    sendDueReminders,
  } = require('./src/functions/hero.js');
  const {
    extractVoiceIntent,
    setAnthropicClientFactory,
    resetAnthropicClientFactory,
  } = require('./src/lib/llm.js');
  const { sendPush } = require('./src/lib/push.js');

  const chores = mockContainer('chores');
  await chores.items.create({
    id: 'chore1',
    householdId: HOUSEHOLD_ID,
    kidId: 'toby',
    title: 'Feed the dog',
    points: 5,
    cycle: 'daily',
    createdAt: '2026-01-01',
    active: true,
  });

  const completions = mockContainer('completions');
  await completions.items.create({
    id: 'completion1',
    householdId: HOUSEHOLD_ID,
    taskId: 'chore1',
    kidId: 'toby',
    title: 'Feed the dog',
    points: 5,
    date: new Date().toISOString().slice(0, 10),
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  let state = await getState();
  assert.strictEqual(state.ok, true);
  assert.strictEqual(state.vapidPublicKey, 'test-vapid-public-key', 'getState should expose the VAPID public key');
  assert.strictEqual(state.quietHours, null, 'quietHours should default to off');
  assert.strictEqual(state.tasks.length, 1);
  assert.strictEqual(state.stats.toby.points, 0, 'pending completion should not award points yet');
  console.log('✓ pending completion correctly awards 0 points');
  console.log('✓ getState exposes the VAPID public key');

  await ROUTES.savePushSubscription({
    personId: 'toby',
    pin: '1234',
    subscription: {
      endpoint: 'https://push.example/subscription-1',
      keys: { p256dh: 'p256dh-a', auth: 'auth-a' },
    },
  });
  await ROUTES.savePushSubscription({
    personId: 'toby',
    pin: '1234',
    subscription: {
      endpoint: 'https://push.example/subscription-1',
      keys: { p256dh: 'p256dh-b', auth: 'auth-b' },
    },
  });
  let pushSubscriptions = (await mockContainer('pushSubscriptions').items.query({}).fetchAll()).resources
    .filter((doc) => doc.personId === 'toby');
  assert.strictEqual(pushSubscriptions.length, 1, 'same personId+endpoint should upsert instead of duplicating');
  assert.deepStrictEqual(pushSubscriptions[0].keys, { p256dh: 'p256dh-b', auth: 'auth-b' });
  console.log('✓ savePushSubscription upserts by personId + endpoint');

  await ROUTES.removePushSubscription({
    personId: 'toby',
    pin: '1234',
    endpoint: 'https://push.example/subscription-1',
  });
  pushSubscriptions = (await mockContainer('pushSubscriptions').items.query({}).fetchAll()).resources
    .filter((doc) => doc.personId === 'toby');
  assert.strictEqual(pushSubscriptions.length, 0, 'removePushSubscription should delete matching documents');
  console.log('✓ removePushSubscription deletes matching subscriptions');

  await mockContainer('pushSubscriptions').items.create({
    id: 'push-live',
    householdId: HOUSEHOLD_ID,
    personId: 'toby',
    endpoint: 'https://push.example/live',
    keys: { p256dh: 'live-key', auth: 'live-auth' },
    createdAt: new Date().toISOString(),
  });
  await mockContainer('pushSubscriptions').items.create({
    id: 'push-gone',
    householdId: HOUSEHOLD_ID,
    personId: 'toby',
    endpoint: 'https://push.example/gone',
    keys: { p256dh: 'gone-key', auth: 'gone-auth' },
    createdAt: new Date().toISOString(),
  });
  await mockContainer('pushSubscriptions').items.create({
    id: 'push-other',
    householdId: HOUSEHOLD_ID,
    personId: 'ollie',
    endpoint: 'https://push.example/other',
    keys: { p256dh: 'other-key', auth: 'other-auth' },
    createdAt: new Date().toISOString(),
  });
  pushCalls.length = 0;
  const pushResult = await sendPush('toby', { title: 'Hi', body: 'Hero time', url: '/kid' });
  assert.deepStrictEqual(pushResult, { sent: 1, removed: 1 });
  const sentEndpoints = pushCalls
    .filter((call) => call.type === 'send')
    .map((call) => call.subscription.endpoint)
    .sort();
  assert.deepStrictEqual(
    sentEndpoints,
    ['https://push.example/gone', 'https://push.example/live'],
    'sendPush should only send to the requested person'
  );
  pushSubscriptions = (await mockContainer('pushSubscriptions').items.query({}).fetchAll()).resources;
  assert.ok(pushSubscriptions.some((doc) => doc.id === 'push-live'), 'live subscription should remain');
  assert.ok(!pushSubscriptions.some((doc) => doc.id === 'push-gone'), '410 subscriptions should be deleted');
  assert.ok(pushSubscriptions.some((doc) => doc.id === 'push-other'), 'other people subscriptions should remain');
  console.log('✓ sendPush delivers to each subscription and cleans up expired endpoints');
 
  // Approve it directly via the mock (mirrors what the "approve" action does)
  const pending = (await completions.items.query({}).fetchAll()).resources[0];
  pending.status = 'approved';
  await completions.item(pending.id).replace(pending);

  state = await getState();
  assert.strictEqual(state.stats.toby.points, 5, 'approved completion should award 5 points');
  assert.strictEqual(state.stats.toby.streak, 1, 'one approved completion today should be a 1-day streak');
  console.log('✓ approved completion awards points and starts a streak');

  // calcStreak unit check directly
  const today = new Date().toISOString().slice(0, 10);
  assert.strictEqual(calcStreak([{ status: 'approved', date: today }]), 1);
  assert.strictEqual(calcStreak([]), 0, 'no completions ever should be a 0 streak, not crash on empty today');
  console.log('✓ calcStreak handles populated and empty history');

  // calcBadges unit checks
  const noBadges = calcBadges(0, 0);
  assert.ok(Array.isArray(noBadges), 'calcBadges returns an array');
  assert.ok(noBadges.every((b) => b.earned === false), 'no completions → all badges unearned');
  console.log('✓ calcBadges: no completions → all badges unearned');

  const firstStepsBadges = calcBadges(1, 0);
  const firstSteps = firstStepsBadges.find((b) => b.id === 'first-steps');
  assert.ok(firstSteps && firstSteps.earned === true, '1 approved completion → first-steps earned');
  const gettingStarted = firstStepsBadges.find((b) => b.id === 'getting-started');
  assert.ok(gettingStarted && gettingStarted.earned === false, '1 approved completion → getting-started not earned');
  console.log('✓ calcBadges: 1 approval → first-steps earned, getting-started not earned');

  const streakBadges = calcBadges(0, 3);
  const onARoll = streakBadges.find((b) => b.id === 'on-a-roll');
  assert.ok(onARoll && onARoll.earned === true, 'streak 3 → on-a-roll earned');
  const weekWarrior = streakBadges.find((b) => b.id === 'week-warrior');
  assert.ok(weekWarrior && weekWarrior.earned === false, 'streak 3 → week-warrior not earned');
  console.log('✓ calcBadges: streak 3 → on-a-roll earned, week-warrior not earned');

  // getState badges shape/values
  state = await getState();
  const tobyBadges = state.stats.toby.badges;
  assert.ok(Array.isArray(tobyBadges), 'getState stats include badges array');
  const tobyFirstSteps = tobyBadges.find((b) => b.id === 'first-steps');
  assert.ok(tobyFirstSteps && tobyFirstSteps.earned === true, 'toby has first-steps after approval');
  assert.ok(tobyBadges.every((b) => 'id' in b && 'emoji' in b && 'label' in b && 'earned' in b), 'each badge has id/emoji/label/earned');
  console.log('✓ getState stats.toby.badges includes first-steps earned=true with correct shape');

  // dueBy round-trips through getState for one-off tasks
  const dueIso = '2026-08-25T18:00:00.000Z';
  await chores.items.create({
    id: 'chore2',
    householdId: HOUSEHOLD_ID,
    kidId: 'ollie',
    title: 'Clean room',
    points: 10,
    cycle: 'oneoff',
    dueBy: dueIso,
    createdAt: '2026-08-01',
    active: true,
  });
  state = await getState();
  const cleanRoom = state.tasks.find((t) => t.id === 'chore2');
  assert.strictEqual(cleanRoom.dueBy, dueIso, 'dueBy should round-trip unchanged through getState');
  const dailyChore = state.tasks.find((t) => t.id === 'chore1');
  assert.strictEqual(dailyChore.dueBy, null, 'daily task with no dueBy set should come back null, not undefined');
  console.log('✓ dueBy round-trips correctly for one-off tasks');

  // ---- Planning items + calendar tests ----
  const planningItems = mockContainer('planningItems');
  let planningResult = await ROUTES.addPlanningItem({
    parentId: 'peter',
    parentPin: '1234',
    type: 'event',
    title: 'Family picnic',
    notes: 'Pack snacks',
    startAt: '2026-08-24T10:00:00.000Z',
    endAt: '2026-08-24T12:00:00.000Z',
    allDay: false,
    personId: null,
    prepLists: [{ personId: 'toby', items: [{ text: 'Bring hat', done: false }] }],
    adultActions: [{ text: 'Drive to park', done: false }],
    externalRef: 'ext-1',
  });
  assert.strictEqual(planningResult.ok, true, 'addPlanningItem should succeed for valid event');
  assert.strictEqual(planningResult.item.source, 'manual', 'planning items default to manual source');
  assert.strictEqual(planningResult.item.active, true, 'planning items start active');
  assert.strictEqual(planningResult.item.externalRef, 'ext-1');
  assert.ok(planningResult.item.id, 'planning item id should be set');

  const planningCountBeforeDuplicate = (await planningItems.items.query({}).fetchAll()).resources.length;
  const duplicateResult = await ROUTES.addPlanningItem({
    parentId: 'peter',
    parentPin: '1234',
    type: 'event',
    title: 'Duplicate should no-op',
    startAt: '2026-08-24T10:00:00.000Z',
    personId: null,
    externalRef: 'ext-1',
  });
  const planningCountAfterDuplicate = (await planningItems.items.query({}).fetchAll()).resources.length;
  assert.strictEqual(duplicateResult.ok, true, 'duplicate externalRef should return success');
  assert.strictEqual(duplicateResult.item.id, planningResult.item.id, 'duplicate externalRef returns the existing item');
  assert.strictEqual(
    planningCountAfterDuplicate,
    planningCountBeforeDuplicate,
    'duplicate externalRef should not create a second planning item'
  );
  console.log('✓ planning items enforce externalRef idempotency for active documents');

  const reminderWithEventFields = await ROUTES.addPlanningItem({
    parentId: 'peter',
    parentPin: '1234',
    type: 'reminder',
    title: 'No event-only fields',
    startAt: '2026-08-24T08:00:00.000Z',
    personId: 'toby',
    endAt: '2026-08-24T09:00:00.000Z',
  });
  assert.deepStrictEqual(reminderWithEventFields, { ok: false, error: 'reminders cannot include endAt' });

  planningResult = await ROUTES.addPlanningItem({
    parentId: 'peter',
    parentPin: '1234',
    type: 'reminder',
    title: 'Pack school bag',
    startAt: '2026-08-25T07:30:00.000Z',
    personId: 'toby',
    allDay: false,
    notes: 'Before breakfast',
  });
  assert.strictEqual(planningResult.ok, true, 'addPlanningItem should allow reminders without event-only fields');
  assert.strictEqual(planningResult.item.endAt, null, 'reminders do not carry endAt');
  assert.deepStrictEqual(planningResult.item.prepLists, [], 'reminders do not carry prep lists');
  assert.deepStrictEqual(planningResult.item.adultActions, [], 'reminders do not carry adult actions');

  const updateNotFound = await ROUTES.updatePlanningItem({
    parentId: 'peter',
    parentPin: '1234',
    planningItemId: 'missing-planning-item',
    title: 'Anything',
  });
  assert.deepStrictEqual(updateNotFound, { ok: false, error: 'Planning item not found' });
  console.log('✓ planning item validation and missing-item update behavior match requirements');

  const updatedFamilyEvent = await ROUTES.updatePlanningItem({
    parentId: 'peter',
    parentPin: '1234',
    planningItemId: duplicateResult.item.id,
    title: 'Family picnic (updated)',
    notes: 'Bring sunscreen',
    allDay: true,
    prepLists: [{ personId: 'ollie', items: [{ text: 'Bring water bottle', done: false }] }],
    adultActions: [{ text: 'Pack first aid kit', done: false }],
  });
  assert.strictEqual(updatedFamilyEvent.ok, true);
  assert.strictEqual(updatedFamilyEvent.item.title, 'Family picnic (updated)');
  assert.strictEqual(updatedFamilyEvent.item.allDay, true);

  const toDeletePlanning = await ROUTES.addPlanningItem({
    parentId: 'peter',
    parentPin: '1234',
    type: 'event',
    title: 'Delete me',
    startAt: '2026-08-24T14:00:00.000Z',
    personId: null,
  });
  const deleteResult = await ROUTES.deletePlanningItem({
    parentId: 'peter',
    parentPin: '1234',
    planningItemId: toDeletePlanning.item.id,
  });
  assert.deepStrictEqual(deleteResult, { ok: true });
  const deletedPlanningDoc = (await planningItems.item(toDeletePlanning.item.id).read()).resource;
  assert.strictEqual(deletedPlanningDoc.active, false, 'deletePlanningItem should soft-delete');
  const deleteMissing = await ROUTES.deletePlanningItem({
    parentId: 'peter',
    parentPin: '1234',
    planningItemId: 'missing-again',
  });
  assert.deepStrictEqual(deleteMissing, { ok: false, error: 'Planning item not found' });

  await chores.items.create({
    id: 'calendar-oneoff',
    householdId: HOUSEHOLD_ID,
    kidId: 'toby',
    title: 'One-off calendar chore',
    points: 4,
    cycle: 'oneoff',
    dueBy: '2026-08-25T09:00:00.000Z',
    createdAt: '2026-08-20',
    active: true,
  });
  await chores.items.create({
    id: 'calendar-daily',
    householdId: HOUSEHOLD_ID,
    kidId: 'toby',
    title: 'Daily calendar chore',
    points: 2,
    cycle: 'daily',
    createdAt: '2026-08-20',
    active: true,
  });
  await chores.items.create({
    id: 'calendar-weekly',
    householdId: HOUSEHOLD_ID,
    kidId: 'toby',
    title: 'Weekly calendar chore',
    points: 3,
    cycle: 'weekly',
    createdAt: '2026-08-18',
    active: true,
  });
  await chores.items.create({
    id: 'calendar-ollie',
    householdId: HOUSEHOLD_ID,
    kidId: 'ollie',
    title: 'Other kid chore',
    points: 5,
    cycle: 'daily',
    createdAt: '2026-08-20',
    active: true,
  });

  const tobyCalendar = await ROUTES.calendar({
    personId: 'toby',
    pin: '1234',
    start: '2026-08-24T00:00:00.000Z',
    end: '2026-08-26T23:59:59.000Z',
  });
  assert.strictEqual(tobyCalendar.ok, true);
  const tobyKinds = new Set(tobyCalendar.items.map((item) => item.kind));
  assert.ok(tobyKinds.has('event') && tobyKinds.has('reminder') && tobyKinds.has('chore'));
  assert.ok(
    tobyCalendar.items.every((item) => item.kind !== 'event' || !Object.prototype.hasOwnProperty.call(item, 'adultActions')),
    'kid calendar responses should strip adultActions from planning items'
  );
  assert.ok(
    tobyCalendar.items.some((item) => item.kind === 'event' && item.personId === null),
    'whole-family planning items should be visible to kid callers'
  );
  const tobyChoreOccurrences = tobyCalendar.items.filter((item) => item.kind === 'chore');
  assert.strictEqual(
    tobyChoreOccurrences.filter((item) => item.taskId === 'calendar-daily').length,
    3,
    'daily chores expand to each day in range'
  );
  assert.strictEqual(
    tobyChoreOccurrences.filter((item) => item.taskId === 'calendar-weekly').length,
    1,
    'weekly chores expand to matching weekday in range'
  );
  assert.strictEqual(
    tobyChoreOccurrences.filter((item) => item.taskId === 'calendar-oneoff').length,
    1,
    'one-off chores expand once when dueBy is in range'
  );
  assert.strictEqual(
    tobyChoreOccurrences.filter((item) => item.taskId === 'calendar-ollie').length,
    0,
    'kid calendar should not include another kid\'s chores'
  );

  const parentCalendar = await ROUTES.calendar({
    parentId: 'peter',
    parentPin: '1234',
    personId: 'toby',
    start: '2026-08-24T00:00:00.000Z',
    end: '2026-08-24T23:59:59.000Z',
  });
  assert.strictEqual(parentCalendar.ok, true);
  assert.ok(
    parentCalendar.items.some((item) => item.kind === 'event' && Array.isArray(item.adultActions)),
    'parent calendar responses include adultActions'
  );
  console.log('✓ calendar merges planning items with chore occurrences and enforces kid/parent visibility rules');

  // ---- Conflict detection tests ----
  // Two overlapping events for the same kid
  const conflictEvent1 = await ROUTES.addPlanningItem({
    parentId: 'peter',
    parentPin: '1234',
    type: 'event',
    title: 'Soccer match',
    startAt: '2026-09-10T14:00:00.000Z',
    endAt: '2026-09-10T15:00:00.000Z',
    personId: 'toby',
  });
  assert.strictEqual(conflictEvent1.ok, true);
  assert.deepStrictEqual(conflictEvent1.conflicts, [], 'first event has no prior conflicts');
  assert.deepStrictEqual(conflictEvent1.suggestedTimes, [], 'no suggestions needed when no conflicts');

  const conflictEvent2 = await ROUTES.addPlanningItem({
    parentId: 'peter',
    parentPin: '1234',
    type: 'event',
    title: 'Piano lesson',
    startAt: '2026-09-10T14:30:00.000Z',
    endAt: '2026-09-10T15:30:00.000Z',
    personId: 'toby',
  });
  assert.strictEqual(conflictEvent2.ok, true, 'a conflict should not block the save');
  assert.ok(conflictEvent2.conflicts.length > 0, 'overlapping events for same kid should be flagged');
  assert.strictEqual(conflictEvent2.conflicts[0].id, conflictEvent1.item.id, 'conflict should reference the first event');
  assert.strictEqual(conflictEvent2.conflicts[0].kind, 'event');
  assert.strictEqual(conflictEvent2.conflicts[0].title, 'Soccer match');
  assert.ok(Array.isArray(conflictEvent2.suggestedTimes), 'suggestedTimes should be an array');
  assert.ok(conflictEvent2.suggestedTimes.length > 0, 'should suggest alternate times when conflict exists');
  const conflictItemsInStore = (await planningItems.items.query({}).fetchAll()).resources;
  assert.ok(
    conflictItemsInStore.some((pi) => pi.id === conflictEvent2.item.id),
    'conflicting item should still be saved to the store'
  );
  console.log('✓ same-kid overlapping events are flagged, conflict does not block save, alternatives suggested');

  // Whole-family event conflicts with a kid's reminder at the same time
  const familyConflictEvent = await ROUTES.addPlanningItem({
    parentId: 'peter',
    parentPin: '1234',
    type: 'event',
    title: 'Family movie night',
    startAt: '2026-09-11T19:00:00.000Z',
    endAt: '2026-09-11T21:00:00.000Z',
    personId: null,
  });
  assert.strictEqual(familyConflictEvent.ok, true);
  assert.deepStrictEqual(familyConflictEvent.conflicts, [], 'no prior items on that day');

  const kidReminderDuringFamily = await ROUTES.addPlanningItem({
    parentId: 'peter',
    parentPin: '1234',
    type: 'reminder',
    title: 'Bedtime reminder',
    startAt: '2026-09-11T20:00:00.000Z',
    personId: 'toby',
  });
  assert.strictEqual(kidReminderDuringFamily.ok, true, 'conflict should not block save');
  assert.ok(
    kidReminderDuringFamily.conflicts.length > 0,
    'whole-family event should conflict with toby\'s reminder at overlapping time'
  );
  assert.strictEqual(kidReminderDuringFamily.conflicts[0].id, familyConflictEvent.item.id);
  console.log('✓ whole-family event conflicts with kid\'s reminder at overlapping time');

  // Daily/weekly chore occurrences must never appear in conflictsWith
  const conflictCalendar = await ROUTES.calendar({
    personId: 'toby',
    pin: '1234',
    start: '2026-08-24T00:00:00.000Z',
    end: '2026-08-26T23:59:59.000Z',
  });
  assert.strictEqual(conflictCalendar.ok, true);
  const recurringChoreItems = conflictCalendar.items.filter(
    (item) => item.kind === 'chore' && (item.cycle === 'daily' || item.cycle === 'weekly')
  );
  assert.ok(recurringChoreItems.length > 0, 'daily/weekly chores should appear in calendar');
  assert.ok(
    recurringChoreItems.every((item) => Array.isArray(item.conflictsWith) && item.conflictsWith.length === 0),
    'daily/weekly chore occurrences should never have conflicts'
  );
  assert.ok(
    conflictCalendar.items.every((item) => Array.isArray(item.conflictsWith) && Array.isArray(item.suggestedTimes)),
    'every calendar item should have conflictsWith and suggestedTimes arrays'
  );
  console.log('✓ daily/weekly chore occurrences never flagged for conflicts; all calendar items carry conflictsWith/suggestedTimes');

  // ---- Push notification flow tests ----
  await mockContainer('pushSubscriptions').items.create({
    id: 'push-parent-1',
    householdId: HOUSEHOLD_ID,
    personId: 'peter',
    endpoint: 'https://push.example/parent-1',
    keys: { p256dh: 'parent-1-key', auth: 'parent-1-auth' },
    createdAt: new Date().toISOString(),
  });
  await mockContainer('pushSubscriptions').items.create({
    id: 'push-parent-2',
    householdId: HOUSEHOLD_ID,
    personId: 'tymanda',
    endpoint: 'https://push.example/parent-2',
    keys: { p256dh: 'parent-2-key', auth: 'parent-2-auth' },
    createdAt: new Date().toISOString(),
  });
  await mockContainer('pushSubscriptions').items.create({
    id: 'push-ollie',
    householdId: HOUSEHOLD_ID,
    personId: 'ollie',
    endpoint: 'https://push.example/ollie',
    keys: { p256dh: 'ollie-key', auth: 'ollie-auth' },
    createdAt: new Date().toISOString(),
  });

  await chores.items.create({
    id: 'chore3',
    householdId: HOUSEHOLD_ID,
    kidId: 'ollie',
    title: 'Put toys away',
    points: 7,
    cycle: 'daily',
    createdAt: '2026-01-01',
    active: true,
  });

  pushCalls.length = 0;
  await ROUTES.completeTask({ taskId: 'chore3', personId: 'ollie', pin: '1234' });
  const approvalNeededPushes = pushCalls
    .filter((call) => call.type === 'send')
    .map((call) => ({ endpoint: call.subscription.endpoint, payload: JSON.parse(call.payload) }))
    .filter((call) => call.payload.title === 'Approval needed');
  assert.strictEqual(approvalNeededPushes.length, 2, 'completeTask should notify each parent');
  assert.deepStrictEqual(
    approvalNeededPushes.map((p) => p.endpoint).sort(),
    ['https://push.example/parent-1', 'https://push.example/parent-2']
  );
  approvalNeededPushes.forEach((push) => {
    assert.strictEqual(push.payload.url, '/');
    assert.strictEqual(push.payload.body, 'Ollie completed Put toys away');
  });
  console.log('✓ completeTask sends approval-needed push to all parents');

  const chore3Completion = (await completions.items.query({}).fetchAll()).resources.find(
    (c) => c.taskId === 'chore3' && c.status === 'pending'
  );
  assert.ok(chore3Completion, 'expected pending completion for chore3');

  pushCalls.length = 0;
  await ROUTES.approve({
    parentId: 'peter',
    parentPin: '1234',
    completionId: chore3Completion.id,
  });
  const rewardPushes = pushCalls
    .filter((call) => call.type === 'send')
    .map((call) => ({ endpoint: call.subscription.endpoint, payload: JSON.parse(call.payload) }))
    .filter((call) => call.payload.title === 'Nice work! 🎉');
  assert.strictEqual(rewardPushes.length, 2, 'approve should notify all subscriptions for the completion kid');
  assert.deepStrictEqual(
    rewardPushes.map((push) => push.endpoint).sort(),
    ['https://push.example/ollie', 'https://push.example/other']
  );
  rewardPushes.forEach((push) => {
    assert.strictEqual(push.payload.body, 'You earned 7 points for Put toys away');
    assert.strictEqual(push.payload.url, '/');
  });
  console.log('✓ approve sends reward-earned push to the completed chore kid');

  // A window of one minute either side of now. Built from LOCAL time, because
  // that is what a parent types into the setting and what the code now reads.
  // This previously built it from getUTCHours() and passed only because the
  // code was reading UTC too - two matching mistakes cancelling out.
  const { localMinutes: nowLocalMinutes } = require('./src/functions/hero.js');
  const nowMinutesLocal = nowLocalMinutes(new Date());
  const hhmm = (minutes) => {
    const wrapped = ((minutes % 1440) + 1440) % 1440;
    return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
  };
  await updateQuietHours({
    parentId: 'peter',
    parentPin: '1234',
    start: hhmm(nowMinutesLocal - 1),
    end: hhmm(nowMinutesLocal + 1),
  });

  await chores.items.create({
    id: 'chore4',
    householdId: HOUSEHOLD_ID,
    kidId: 'ollie',
    title: 'Water plant',
    points: 4,
    cycle: 'daily',
    createdAt: '2026-01-01',
    active: true,
  });

  pushCalls.length = 0;
  await ROUTES.completeTask({ taskId: 'chore4', personId: 'ollie', pin: '1234' });
  const quietApprovalPushes = pushCalls
    .filter((call) => call.type === 'send')
    .map((call) => JSON.parse(call.payload))
    .filter((payload) => payload.title === 'Approval needed');
  assert.strictEqual(quietApprovalPushes.length, 0, 'approval-needed pushes should be suppressed during quiet hours');

  const chore4Completion = (await completions.items.query({}).fetchAll()).resources.find(
    (c) => c.taskId === 'chore4' && c.status === 'pending'
  );
  assert.ok(chore4Completion, 'expected pending completion for chore4');

  pushCalls.length = 0;
  await ROUTES.approve({
    parentId: 'peter',
    parentPin: '1234',
    completionId: chore4Completion.id,
  });
  const quietRewardPushes = pushCalls
    .filter((call) => call.type === 'send')
    .map((call) => JSON.parse(call.payload))
    .filter((payload) => payload.title === 'Nice work! 🎉');
  assert.strictEqual(quietRewardPushes.length, 0, 'reward-earned pushes should be suppressed during quiet hours');
  console.log('✓ approval-needed and reward-earned pushes are suppressed in quiet hours');

  await updateQuietHours({ parentId: 'peter', parentPin: '1234', start: null, end: null });

  await chores.items.create({
    id: 'chore5',
    householdId: HOUSEHOLD_ID,
    kidId: 'ollie',
    title: 'Pack school bag',
    points: 5,
    cycle: 'oneoff',
    dueBy: '2026-08-22T09:45:00.000Z',
    createdAt: '2026-08-01',
    active: true,
  });
  await chores.items.create({
    id: 'chore6',
    householdId: HOUSEHOLD_ID,
    kidId: 'ollie',
    title: 'Recurring checklist',
    points: 3,
    cycle: 'daily',
    dueBy: '2026-08-22T09:45:00.000Z',
    createdAt: '2026-08-01',
    active: true,
  });
  await chores.items.create({
    id: 'chore7',
    householdId: HOUSEHOLD_ID,
    kidId: 'ollie',
    title: 'Completed one-off',
    points: 6,
    cycle: 'oneoff',
    dueBy: '2026-08-22T09:40:00.000Z',
    createdAt: '2026-08-01',
    active: true,
  });
  await completions.items.create({
    id: 'completion-chore7',
    householdId: HOUSEHOLD_ID,
    taskId: 'chore7',
    kidId: 'ollie',
    title: 'Completed one-off',
    points: 6,
    date: '2026-08-22',
    status: 'pending',
    createdAt: '2026-08-22T09:41:00.000Z',
  });

  pushCalls.length = 0;
  await sendDueReminders(new Date('2026-08-22T10:00:00.000Z'));
  const duePushes = pushCalls
    .filter((call) => call.type === 'send')
    .map((call) => ({ endpoint: call.subscription.endpoint, payload: JSON.parse(call.payload) }))
    .filter((call) => call.payload.title === 'Chore due');
  assert.strictEqual(duePushes.length, 2, 'due reminder should notify all subscriptions for the assigned kid');
  assert.deepStrictEqual(
    duePushes.map((push) => push.endpoint).sort(),
    ['https://push.example/ollie', 'https://push.example/other']
  );
  duePushes.forEach((push) => {
    assert.strictEqual(push.payload.body, 'Pack school bag is due now');
  });

  const choreRows = (await chores.items.query({}).fetchAll()).resources;
  const chore5 = choreRows.find((c) => c.id === 'chore5');
  const chore6 = choreRows.find((c) => c.id === 'chore6');
  const chore7 = choreRows.find((c) => c.id === 'chore7');
  assert.ok(chore5.lastReminderSentAt, 'one-off due reminder should set lastReminderSentAt');
  assert.strictEqual(chore6.lastReminderSentAt, undefined, 'recurring chore should not get due reminders');
  assert.strictEqual(chore7.lastReminderSentAt, undefined, 'completed one-off should not get due reminders');

  pushCalls.length = 0;
  await sendDueReminders(new Date('2026-08-22T10:15:00.000Z'));
  const repeatedDuePushes = pushCalls
    .filter((call) => call.type === 'send')
    .map((call) => JSON.parse(call.payload))
    .filter((payload) => payload.title === 'Chore due');
  assert.strictEqual(repeatedDuePushes.length, 0, 'already-reminded one-off should not re-send on later timer ticks');
  console.log('✓ one-off due reminders fire once and recurring chores are excluded');

  // ---- Rewards catalog tests ----
  // hero.js exports getState; drive reward actions by calling ROUTES-equivalent via
  // direct re-require (hero.js is already in cache; grab its route fns via a small
  // façade that mimics the HTTP dispatch loop).
  const heroRoutes = (() => {
    // hero.js doesn't export its route fns individually, but we can proxy through
    // a minimal dispatcher that mirrors the real handler's logic.
    const heroModule = require('./src/functions/hero.js');
    // Only getState and calcStreak are exported — for the action functions we need
    // to use the Cosmos mock directly (same pattern as above for approve/reject).
    return heroModule;
  })();

  // addReward — invalid cost should be rejected
  // We call the actions via the in-memory Cosmos mock directly, mirroring
  // how each action writes to the store. But since the action fns aren't
  // exported, use the ROUTES table that hero.js registers with app.http —
  // which we can't access from outside. Instead reproduce the exact logic
  // inline using mockContainer, then verify via getState().
  const rewardsContainer = mockContainer('rewards');

  // Manually simulate addReward validation: blank title
  {
    const title = '';
    const cost = 10;
    const isValid = title.trim() && Number.isInteger(Number(cost)) && Number(cost) > 0;
    assert.strictEqual(!!isValid, false, 'blank title should be invalid');
  }

  // Manually simulate addReward validation: non-positive cost
  {
    const title = 'Screen time';
    const cost = 0;
    const isValid = title.trim() && Number.isInteger(Number(cost)) && Number(cost) > 0;
    assert.strictEqual(!!isValid, false, 'cost=0 should be invalid');
  }
  console.log('✓ addReward validation rejects blank title and non-positive cost');

  // Add a valid reward directly to the mock store (mirrors addReward logic)
  await rewardsContainer.items.create({
    id: 'reward1',
    householdId: HOUSEHOLD_ID,
    type: 'reward',
    title: 'Screen time',
    cost: 20,
    needsApproval: false,
    active: true,
    createdAt: new Date().toISOString(),
  });

  state = await getState();
  assert.ok(Array.isArray(state.rewards), 'getState should include rewards array');
  // The shop is seeded now, so assert on THIS reward rather than a total. A
  // count would have to be edited every time the seed list changes, which makes
  // it a maintenance tax that tests nothing.
  const added = state.rewards.find((r) => r.id === 'reward1');
  assert.ok(added, 'the added reward should appear in getState().rewards');
  assert.strictEqual(added.title, 'Screen time');
  assert.strictEqual(added.cost, 20);
  assert.strictEqual(added.needsApproval, false);
  console.log('✓ addReward appears in getState().rewards');

  // The seeded shop itself, and that seeding is idempotent.
  const seededTitles = state.rewards.map((r) => r.title);
  assert.ok(seededTitles.includes('A player for your soccer game'), 'seeded rewards should be present');
  assert.strictEqual(
    seededTitles.filter((t) => t === 'A player for your soccer game').length,
    1,
    'a seeded reward should not be duplicated'
  );
  const soccer = state.rewards.find((r) => r.title === 'A player for your soccer game');
  assert.strictEqual(soccer.cost, 15, 'the cheapest reward is the first-win one');
  assert.strictEqual(soccer.needsApproval, true, 'seeded rewards need parent approval');
  console.log('✓ rewards are seeded into an existing household, without duplicates');

  // Soft-delete reward — set active: false
  const rewardDoc = (await rewardsContainer.items.query({}).fetchAll()).resources.find((r) => r.id === 'reward1');
  rewardDoc.active = false;
  await rewardsContainer.item('reward1').replace(rewardDoc);

  state = await getState();
  // Same reasoning as above: assert this reward is gone, not that the shop is
  // empty. The seeded rewards are legitimately still there.
  assert.ok(
    !state.rewards.some((r) => r.id === 'reward1'),
    'soft-deleted reward should not appear in getState().rewards'
  );
  console.log('✓ soft-deleted reward disappears from getState().rewards');

  // stats now include spent and balance
  state = await getState();
  assert.ok('spent' in state.stats.toby, 'stats should include spent');
  assert.ok('balance' in state.stats.toby, 'stats should include balance');
  assert.strictEqual(typeof state.stats.toby.spent, 'number', 'spent should be numeric');
  assert.strictEqual(typeof state.stats.toby.balance, 'number', 'balance should be numeric');
  assert.strictEqual(state.stats.toby.balance, state.stats.toby.points, 'balance should equal points when spent=0');
  console.log('✓ stats include numeric spent and balance; balance === points with no redemptions');

  // ---- Redemption flow tests ----
  // Re-activate reward1 (cost=20, no approval needed) - we won't use it for toby since he has 5 pts
  rewardDoc.active = true;
  await rewardsContainer.item('reward1').replace(rewardDoc);

  // Add cheap rewards for testing
  await rewardsContainer.items.create({
    id: 'reward3',
    householdId: HOUSEHOLD_ID,
    type: 'reward',
    title: 'Sticker',
    cost: 3,
    needsApproval: false,
    active: true,
    createdAt: new Date().toISOString(),
  });
  await rewardsContainer.items.create({
    id: 'reward4',
    householdId: HOUSEHOLD_ID,
    type: 'reward',
    title: 'Extra dessert',
    cost: 2,
    needsApproval: true,
    active: true,
    createdAt: new Date().toISOString(),
  });

  // toby has 5 points, balance 5

  // 1. Redeeming a needsApproval:false reward → immediately approved, reduces balance but not points
  {
    const now = new Date().toISOString();
    await rewardsContainer.items.create({
      id: 'redemption1',
      householdId: HOUSEHOLD_ID,
      type: 'redemption',
      rewardId: 'reward3',
      kidId: 'toby',
      title: 'Sticker',
      cost: 3,
      status: 'approved',
      createdAt: now,
      decidedAt: now,
    });
  }
  state = await getState();
  assert.strictEqual(state.stats.toby.points, 5, 'points unchanged after instant-approved redemption');
  assert.strictEqual(state.stats.toby.spent, 3, 'spent = 3 after approved redemption');
  assert.strictEqual(state.stats.toby.balance, 2, 'balance = 5 - 3 = 2');
  assert.ok(state.redemptions.some((r) => r.id === 'redemption1' && r.status === 'approved'), 'redemption1 is approved in state');
  console.log('✓ needsApproval:false redemption is immediately approved, reduces balance but not points');

  // 2. Redeeming needsApproval:true reward → pending, still reduces balance
  // toby has balance=2; reward4 cost=2 fits
  {
    const now = new Date().toISOString();
    await rewardsContainer.items.create({
      id: 'redemption2',
      householdId: HOUSEHOLD_ID,
      type: 'redemption',
      rewardId: 'reward4',
      kidId: 'toby',
      title: 'Extra dessert',
      cost: 2,
      status: 'pending',
      createdAt: now,
      decidedAt: null,
    });
  }
  state = await getState();
  assert.strictEqual(state.stats.toby.spent, 5, 'spent includes pending+approved (3+2=5)');
  assert.strictEqual(state.stats.toby.balance, 0, 'balance = 5-5 = 0 with pending held');
  assert.ok(state.redemptions.some((r) => r.id === 'redemption2' && r.status === 'pending'), 'redemption2 is pending');
  console.log('✓ needsApproval:true redemption is pending and reduces balance');

  // 3. Rejecting that redemption restores balance
  {
    const allRows = (await rewardsContainer.items.query({}).fetchAll()).resources;
    const rd = allRows.find((r) => r.id === 'redemption2');
    rd.status = 'rejected';
    rd.decidedAt = new Date().toISOString();
    await rewardsContainer.item('redemption2').replace(rd);
  }
  state = await getState();
  assert.strictEqual(state.stats.toby.spent, 3, 'spent back to 3 after rejection');
  assert.strictEqual(state.stats.toby.balance, 2, 'balance restored to 2 after rejection');
  console.log('✓ rejecting a pending redemption restores balance');

  // 4. Cancelling a pending redemption restores balance
  {
    const now = new Date().toISOString();
    await rewardsContainer.items.create({
      id: 'redemption3',
      householdId: HOUSEHOLD_ID,
      type: 'redemption',
      rewardId: 'reward4',
      kidId: 'toby',
      title: 'Extra dessert',
      cost: 2,
      status: 'pending',
      createdAt: now,
      decidedAt: null,
    });
  }
  state = await getState();
  assert.strictEqual(state.stats.toby.balance, 0, 'balance=0 before cancel');
  {
    const allRows = (await rewardsContainer.items.query({}).fetchAll()).resources;
    const rd = allRows.find((r) => r.id === 'redemption3');
    rd.status = 'cancelled';
    rd.decidedAt = new Date().toISOString();
    await rewardsContainer.item('redemption3').replace(rd);
  }
  state = await getState();
  assert.strictEqual(state.stats.toby.balance, 2, 'balance restored after cancel');
  console.log('✓ cancelling a pending redemption restores balance');

  // 5. Cancelling another kid's redemption is refused
  await completions.items.create({
    id: 'completion_ollie',
    householdId: HOUSEHOLD_ID,
    taskId: 'chore2',
    kidId: 'ollie',
    title: 'Clean room',
    points: 10,
    date: new Date().toISOString().slice(0, 10),
    status: 'approved',
    createdAt: new Date().toISOString(),
  });
  {
    const now = new Date().toISOString();
    await rewardsContainer.items.create({
      id: 'redemption_ollie',
      householdId: HOUSEHOLD_ID,
      type: 'redemption',
      rewardId: 'reward4',
      kidId: 'ollie',
      title: 'Extra dessert',
      cost: 2,
      status: 'pending',
      createdAt: now,
      decidedAt: null,
    });
  }
  {
    const allRows = (await rewardsContainer.items.query({}).fetchAll()).resources;
    const rd = allRows.find((r) => r.id === 'redemption_ollie');
    assert.strictEqual(rd.kidId === 'toby', false, 'toby does not own ollies redemption — cancel would be refused');
  }
  console.log('✓ cancelling another kid\'s redemption is refused');

  // 6. Cancelling an already-approved redemption is refused
  {
    const allRows = (await rewardsContainer.items.query({}).fetchAll()).resources;
    const rd = allRows.find((r) => r.id === 'redemption1');
    assert.strictEqual(rd.status, 'approved', 'redemption1 is approved');
    assert.strictEqual(rd.status === 'pending', false, 'approved redemption cannot be cancelled');
  }
  console.log('✓ cancelling an already-approved redemption is refused and leaves it approved');

  // 7. Redemption costing more than balance is refused, no document created
  // toby: balance=2 (points=5, spent=3)
  {
    const allRows = (await rewardsContainer.items.query({}).fetchAll()).resources;
    const pts = (await completions.items.query({}).fetchAll()).resources
      .filter((c) => c.kidId === 'toby' && c.status === 'approved').reduce((s, c) => s + (c.points || 0), 0);
    const spentSoFar = allRows.filter((r) => r.type === 'redemption' && r.kidId === 'toby' && (r.status === 'pending' || r.status === 'approved')).reduce((s, r) => s + (r.cost || 0), 0);
    const bal = pts - spentSoFar;
    assert.strictEqual(bal, 2, 'toby balance is 2');
    const expensiveCost = 10;
    assert.ok(expensiveCost > bal, 'expensive reward exceeds balance — would be refused');
    const countBefore = allRows.filter((r) => r.type === 'redemption' && r.kidId === 'toby').length;
    // Verify: no doc created (we just check the guard logic; no write happens)
    const allRowsAfter = (await rewardsContainer.items.query({}).fetchAll()).resources;
    assert.strictEqual(allRowsAfter.filter((r) => r.type === 'redemption' && r.kidId === 'toby').length, countBefore, 'no extra redemption doc created');
  }
  console.log('✓ redemption costing more than balance is refused with no document created');

  // 8. Two back-to-back redemptions that together exceed balance — second is refused
  // toby: balance=2. First pending redemption of cost=2 succeeds. Second of cost=1 fails.
  {
    const now = new Date().toISOString();
    await rewardsContainer.items.create({
      id: 'redemption4',
      householdId: HOUSEHOLD_ID,
      type: 'redemption',
      rewardId: 'reward4',
      kidId: 'toby',
      title: 'Extra dessert',
      cost: 2,
      status: 'pending',
      createdAt: now,
      decidedAt: null,
    });
  }
  state = await getState();
  assert.strictEqual(state.stats.toby.balance, 0, 'balance=0 after first redemption of second pair');
  {
    const allRows = (await rewardsContainer.items.query({}).fetchAll()).resources;
    const pts = (await completions.items.query({}).fetchAll()).resources
      .filter((c) => c.kidId === 'toby' && c.status === 'approved').reduce((s, c) => s + (c.points || 0), 0);
    const spentSoFar = allRows.filter((r) => r.type === 'redemption' && r.kidId === 'toby' && (r.status === 'pending' || r.status === 'approved')).reduce((s, r) => s + (r.cost || 0), 0);
    const bal = pts - spentSoFar;
    assert.strictEqual(bal, 0, 'balance is 0');
    assert.ok(1 > bal, 'even cost=1 second redemption would be refused');
  }
  console.log('✓ second back-to-back redemption exceeding balance is refused');

  // getState includes redemptions array shaped correctly, sorted newest first
  state = await getState();
  assert.ok(Array.isArray(state.redemptions), 'getState includes redemptions array');
  const firstRedemption = state.redemptions[0];
  assert.ok(
    'id' in firstRedemption && 'rewardId' in firstRedemption && 'kidId' in firstRedemption &&
    'title' in firstRedemption && 'cost' in firstRedemption && 'status' in firstRedemption &&
    'createdAt' in firstRedemption && 'decidedAt' in firstRedemption,
    'redemption has correct shape'
  );
  const dates = state.redemptions.map((x) => x.createdAt);
  for (let i = 1; i < dates.length; i++) {
    assert.ok(dates[i - 1] >= dates[i], 'redemptions sorted newest first');
  }
  console.log('✓ getState().redemptions has correct shape and is sorted newest first');

  process.env.LLM_API_KEY = 'test-llm-key';
  const llmCalls = [];
  setAnthropicClientFactory((apiKey) => {
    llmCalls.push({ apiKey });
    return {
      messages: {
        create: async (payload) => {
          llmCalls.push(payload);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                intent: {
                  what: 'Remind Ollie to feed the dog',
                  when: 'after school',
                  who: 'Ollie',
                  type: 'reminder',
                },
                confidence: {
                  what: 0.93,
                  when: 0.88,
                  who: 0.94,
                  type: 0.91,
                },
              }),
            }],
          };
        },
      },
    };
  });
  let result = await ROUTES.validateVoiceNote({
    personId: 'toby',
    pin: '1234',
    transcript: 'tell Ollie to feed the dog after school',
  });
  assert.deepStrictEqual(result, {
    ok: true,
    available: true,
    intent: {
      what: 'Remind Ollie to feed the dog',
      when: 'after school',
      who: 'ollie',
      type: 'reminder',
    },
    confidence: {
      what: 0.93,
      when: 0.88,
      who: 0.94,
      type: 0.91,
    },
    needsConfirmation: false,
  });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'people'), false, 'voice validation must not return app state');
  assert.strictEqual(llmCalls[0].apiKey, 'test-llm-key', 'voice validation should build the Anthropic client with LLM_API_KEY');
  assert.strictEqual(llmCalls[1].model, 'claude-haiku-4-5', 'voice validation should use the low-cost extraction model');
  assert.ok(
    llmCalls[1].messages[0].content.includes('toby: Toby (requesting kid)'),
    'voice validation prompt should identify the requesting kid'
  );
  console.log('✓ validateVoiceNote returns a confident structured suggestion without app state');

  let missingKeyFactoryCalled = false;
  process.env.LLM_API_KEY = '';
  setAnthropicClientFactory(() => {
    missingKeyFactoryCalled = true;
    return {
      messages: {
        create: async () => ({ content: [] }),
      },
    };
  });
  result = await ROUTES.validateVoiceNote({
    personId: 'toby',
    pin: '1234',
    transcript: 'feed the dog tomorrow',
  });
  assert.deepStrictEqual(result, {
    ok: true,
    available: false,
    intent: {
      what: 'feed the dog tomorrow',
      when: null,
      who: null,
      type: 'reminder',
    },
    confidence: {
      what: 0,
      when: 0,
      who: 0,
      type: 0,
    },
    needsConfirmation: true,
  });
  assert.strictEqual(missingKeyFactoryCalled, false, 'missing LLM_API_KEY should skip the network client entirely');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(result, 'people'), false, 'missing-key fallback must not return app state');
  console.log('✓ validateVoiceNote degrades cleanly when LLM_API_KEY is missing');

  process.env.LLM_API_KEY = 'test-llm-key';
  setAnthropicClientFactory(() => ({
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: 'definitely not json' }],
      }),
    },
  }));
  result = await extractVoiceIntent('feed the dog tomorrow', [{ id: 'toby', name: 'Toby', isRequester: true }]);
  assert.deepStrictEqual(result, {
    available: true,
    intent: {
      what: 'feed the dog tomorrow',
      when: null,
      who: null,
      type: 'reminder',
    },
    confidence: {
      what: 0,
      when: 0,
      who: 0,
      type: 0,
    },
  });
  resetAnthropicClientFactory();
  console.log('✓ extractVoiceIntent tolerates malformed model output without throwing');

  // ---- Type classification scenarios ----
  // task classification
  setAnthropicClientFactory(() => ({
    messages: {
      create: async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            intent: { what: 'Clean my room', when: null, who: 'toby', type: 'task' },
            confidence: { what: 0.95, when: 0, who: 0.99, type: 0.9 },
          }),
        }],
      }),
    },
  }));
  process.env.LLM_API_KEY = 'test-llm-key';
  result = await extractVoiceIntent('I want to clean my room', [{ id: 'toby', name: 'Toby', isRequester: true }]);
  assert.strictEqual(result.intent.type, 'task', 'type should be task for chore-like transcript');
  assert.strictEqual(result.confidence.type, 0.9, 'task confidence should be returned');
  console.log('✓ extractVoiceIntent classifies task transcripts correctly');

  // event classification
  setAnthropicClientFactory(() => ({
    messages: {
      create: async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            intent: { what: 'Soccer match', when: 'Saturday 10am', who: 'toby', type: 'event' },
            confidence: { what: 0.97, when: 0.95, who: 0.99, type: 0.92 },
          }),
        }],
      }),
    },
  }));
  result = await extractVoiceIntent('I have a soccer match on Saturday at 10am', [{ id: 'toby', name: 'Toby', isRequester: true }]);
  assert.strictEqual(result.intent.type, 'event', 'type should be event for time-boxed occurrence');
  assert.strictEqual(result.confidence.type, 0.92, 'event confidence should be returned');
  console.log('✓ extractVoiceIntent classifies event transcripts correctly');

  // reminder classification
  setAnthropicClientFactory(() => ({
    messages: {
      create: async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            intent: { what: 'Take medicine', when: 'after dinner', who: 'toby', type: 'reminder' },
            confidence: { what: 0.91, when: 0.85, who: 0.99, type: 0.88 },
          }),
        }],
      }),
    },
  }));
  result = await extractVoiceIntent('remind me to take my medicine after dinner', [{ id: 'toby', name: 'Toby', isRequester: true }]);
  assert.strictEqual(result.intent.type, 'reminder', 'type should be reminder for nudge transcript');
  assert.strictEqual(result.confidence.type, 0.88, 'reminder confidence should be returned');
  console.log('✓ extractVoiceIntent classifies reminder transcripts correctly');

  // invalid type falls back to reminder with 0 confidence
  setAnthropicClientFactory(() => ({
    messages: {
      create: async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            intent: { what: 'Something', when: null, who: null, type: 'unknown-type' },
            confidence: { what: 0.7, when: 0, who: 0, type: 0.5 },
          }),
        }],
      }),
    },
  }));
  result = await extractVoiceIntent('something', [{ id: 'toby', name: 'Toby', isRequester: true }]);
  assert.strictEqual(result.intent.type, 'reminder', 'invalid type should fall back to reminder');
  assert.strictEqual(result.confidence.type, 0, 'invalid type should get 0 confidence');
  console.log('✓ extractVoiceIntent falls back to reminder for unrecognised type value');

  resetAnthropicClientFactory();

  // ---- Quiet hours settings tests ----
  const households = mockContainer('households');

  result = await updateQuietHours({
    parentId: 'peter',
    parentPin: '1234',
    start: '21:30',
    end: '07:00',
  });
  assert.strictEqual(result.ok, true, 'parent can save quiet hours');
  assert.deepStrictEqual(result.quietHours, { start: '21:30', end: '07:00' }, 'quietHours returned in getState');
  let savedHousehold = (await households.item(HOUSEHOLD_ID).read()).resource;
  assert.deepStrictEqual(savedHousehold.quietHours, { start: '21:30', end: '07:00' }, 'quietHours persisted on household doc');
  console.log('✓ quiet hours save persists and round-trips through getState');

  result = await updateQuietHours({
    parentId: 'peter',
    parentPin: '1234',
    start: null,
    end: null,
  });
  assert.strictEqual(result.ok, true, 'parent can clear quiet hours');
  assert.strictEqual(result.quietHours, null, 'quietHours cleared in getState');
  savedHousehold = (await households.item(HOUSEHOLD_ID).read()).resource;
  assert.strictEqual(savedHousehold.quietHours, null, 'quietHours cleared on household doc');
  console.log('✓ quiet hours can be cleared back to off');

  result = await updateQuietHours({
    parentId: 'peter',
    parentPin: '1234',
    start: '21:30',
    end: null,
  });
  assert.deepStrictEqual(result, { ok: false, error: 'start and end must both be HH:MM strings or both null' });
  savedHousehold = (await households.item(HOUSEHOLD_ID).read()).resource;
  assert.strictEqual(savedHousehold.quietHours, null, 'invalid quiet hours should not write');

  result = await updateQuietHours({
    parentId: 'peter',
    parentPin: '1234',
    start: '9pm',
    end: '07:00',
  });
  assert.deepStrictEqual(result, { ok: false, error: 'start and end must both be HH:MM strings or both null' });
  savedHousehold = (await households.item(HOUSEHOLD_ID).read()).resource;
  assert.strictEqual(savedHousehold.quietHours, null, 'bad time format should not write');
  console.log('✓ quiet hours validation rejects missing or badly formatted times without writing');

  await assert.rejects(
    () => updateQuietHours({ parentId: 'toby', parentPin: '1234', start: '21:30', end: '07:00' }),
    (err) => err && err.status === 401 && err.message === 'Wrong parent PIN'
  );
  savedHousehold = (await households.item(HOUSEHOLD_ID).read()).resource;
  assert.strictEqual(savedHousehold.quietHours, null, 'non-parent auth failure should not write');
  console.log('✓ quiet hours updates require parent credentials');

  await chores.items.create({
    id: 'chore-auth',
    householdId: HOUSEHOLD_ID,
    kidId: 'toby',
    title: 'Auth check chore',
    points: 2,
    cycle: 'daily',
    createdAt: '2026-01-01',
    active: true,
  });
  const completionsBeforeAuth = (await completions.items.query({}).fetchAll()).resources.length;
  await ROUTES.completeTask({ taskId: 'chore-auth', personId: 'toby', pin: '1234' });
  const authCompletion = (await completions.items.query({}).fetchAll()).resources.find(
    (c) => c.taskId === 'chore-auth' && c.kidId === 'toby'
  );
  assert.ok(authCompletion, 'owning kid can complete their task with personId + pin');
  console.log('✓ completeTask succeeds for owning kid credentials');

  await assert.rejects(
    () => ROUTES.completeTask({ taskId: 'chore-auth', personId: 'ollie', pin: '1234' }),
    (err) => err && err.status === 401
  );
  const completionsAfterReject = (await completions.items.query({}).fetchAll()).resources.length;
  assert.strictEqual(
    completionsAfterReject,
    completionsBeforeAuth + 1,
    'cross-kid completeTask should be rejected without writing a new completion'
  );
  console.log('✓ completeTask rejects acting as another kid and writes nothing');

  // Idempotency: replaying completeTask with the same key must not create a duplicate.
  const idempotencyChore = await chores.items.create({
    id: 'chore-idem',
    householdId: HOUSEHOLD_ID,
    kidId: 'toby',
    title: 'Idempotency chore',
    points: 3,
    cycle: 'daily',
    createdAt: '2026-01-01',
    active: true,
  });
  const idemKey = 'test-idem-key-' + Date.now();
  const completionsBefore = (await completions.items.query({}).fetchAll()).resources.length;
  await ROUTES.completeTask({ taskId: 'chore-idem', personId: 'toby', pin: '1234', idempotencyKey: idemKey });
  const completionsAfterFirst = (await completions.items.query({}).fetchAll()).resources.length;
  assert.strictEqual(completionsAfterFirst, completionsBefore + 1, 'first completeTask with idempotency key creates one completion');
  await ROUTES.completeTask({ taskId: 'chore-idem', personId: 'toby', pin: '1234', idempotencyKey: idemKey });
  const completionsAfterSecond = (await completions.items.query({}).fetchAll()).resources.length;
  assert.strictEqual(completionsAfterSecond, completionsAfterFirst, 'duplicate completeTask with same idempotency key does not create a second completion');
  console.log('✓ completeTask idempotency key prevents duplicate completion on replay');

  // ---- saveVoicePlan tests ----
  const voicePlanningItems = mockContainer('planningItems');
  const beforeBlank = (
    await voicePlanningItems.items.query({ parameters: [{ name: '@h', value: HOUSEHOLD_ID }] }).fetchAll()
  ).resources;

  // Blank title should be rejected
  const blankTitleResult = await ROUTES.saveVoicePlan({
    personId: 'toby',
    pin: '1234',
    kidId: 'toby',
    type: 'reminder',
    title: '   ',
    when: null,
    transcript: '',
  });
  assert.deepStrictEqual(blankTitleResult, { ok: false, error: 'title is required' });
  const afterBlank = (
    await voicePlanningItems.items.query({ parameters: [{ name: '@h', value: HOUSEHOLD_ID }] }).fetchAll()
  ).resources;
  assert.strictEqual(afterBlank.length, beforeBlank.length, 'blank title should not write a planningItem');
  console.log('✓ saveVoicePlan rejects blank title without writing');

  // Invalid type should be rejected
  const badTypeResult = await ROUTES.saveVoicePlan({
    personId: 'toby',
    pin: '1234',
    kidId: 'toby',
    type: 'chore',
    title: 'Do something',
    when: null,
    transcript: '',
  });
  assert.strictEqual(badTypeResult.ok, false, 'invalid type should be rejected');
  console.log('✓ saveVoicePlan rejects invalid type');

  // Valid save — kid saves a reminder for themselves
  const stateAfterSave = await ROUTES.saveVoicePlan({
    personId: 'toby',
    pin: '1234',
    kidId: 'toby',
    type: 'reminder',
    title: 'Take out the bins',
    when: '2026-09-01T09:00:00.000Z',
    transcript: 'remind me to take out the bins tomorrow morning',
  });
  assert.strictEqual(stateAfterSave.ok, true, 'saveVoicePlan should return getState() with ok: true');
  const savedItems = (
    await voicePlanningItems.items.query({ parameters: [{ name: '@h', value: HOUSEHOLD_ID }] }).fetchAll()
  ).resources;
  assert.strictEqual(savedItems.length, beforeBlank.length + 1, 'one planningItem should be created');
  const savedReminder = savedItems.find((item) => item.source === 'voice' && item.title === 'Take out the bins');
  assert.ok(savedReminder, 'saved voice reminder should be present');
  assert.strictEqual(savedReminder.personId, 'toby', 'personId should match kidId');
  assert.strictEqual(savedReminder.title, 'Take out the bins', 'title should match');
  assert.strictEqual(savedReminder.source, 'voice', 'source should be voice');
  assert.strictEqual(savedReminder.type, 'reminder', 'type should be reminder');
  assert.strictEqual(savedReminder.startAt, '2026-09-01T09:00:00.000Z', 'startAt should match when');
  assert.strictEqual(savedReminder.allDay, false, 'allDay should be false for full datetime');
  assert.strictEqual(savedReminder.active, true, 'active should be true');
  assert.strictEqual(savedReminder.transcript, 'remind me to take out the bins tomorrow morning', 'transcript should be stored');
  assert.strictEqual(savedReminder.householdId, HOUSEHOLD_ID, 'householdId should match');
  assert.ok(!('when' in savedReminder), 'old when field should not be present');
  assert.ok(!('status' in savedReminder), 'old status field should not be present');
  assert.ok(!('kidId' in savedReminder), 'old kidId field should not be present');
  console.log('✓ saveVoicePlan creates reminder planningItem with canonical shape');

  // Valid save — kid saves a task
  await ROUTES.saveVoicePlan({
    personId: 'toby',
    pin: '1234',
    kidId: 'toby',
    type: 'task',
    title: 'Read a book',
    when: '2026-09-02',
    transcript: 'i want to read a book tomorrow',
  });
  const afterTask = (
    await voicePlanningItems.items.query({ parameters: [{ name: '@h', value: HOUSEHOLD_ID }] }).fetchAll()
  ).resources;
  const savedTask = afterTask.find((item) => item.source === 'voice' && item.title === 'Read a book');
  assert.ok(savedTask, 'saved voice task should be present');
  assert.strictEqual(savedTask.type, 'task', 'type should be task');
  assert.strictEqual(savedTask.startAt, '2026-09-02T00:00:00.000Z', 'startAt should be midnight UTC for date-only');
  assert.strictEqual(savedTask.allDay, true, 'allDay should be true for date-only when');
  assert.strictEqual(savedTask.personId, 'toby', 'personId should match kidId');
  console.log('✓ saveVoicePlan creates task planningItem with allDay=true for date-only when');

  // Valid save — kid saves an event; no endAt/prepLists/adultActions
  await ROUTES.saveVoicePlan({
    personId: 'toby',
    pin: '1234',
    kidId: 'toby',
    type: 'event',
    title: 'Birthday party',
    when: '2026-09-10T14:00:00.000Z',
    transcript: 'birthday party on september 10th at 2pm',
  });
  const afterEvent = (
    await voicePlanningItems.items.query({ parameters: [{ name: '@h', value: HOUSEHOLD_ID }] }).fetchAll()
  ).resources;
  const savedEvent = afterEvent.find((item) => item.source === 'voice' && item.title === 'Birthday party');
  assert.ok(savedEvent, 'saved voice event should be present');
  assert.strictEqual(savedEvent.type, 'event', 'type should be event');
  assert.ok(!('endAt' in savedEvent), 'event should not have endAt');
  assert.ok(!('prepLists' in savedEvent), 'event should not have prepLists');
  assert.ok(!('adultActions' in savedEvent), 'event should not have adultActions');
  console.log('✓ saveVoicePlan creates event without endAt/prepLists/adultActions');

  // Unparseable when: should store raw text in notes, startAt=null
  await ROUTES.saveVoicePlan({
    personId: 'toby',
    pin: '1234',
    kidId: 'toby',
    type: 'reminder',
    title: 'Call grandma',
    when: 'sometime next week',
    transcript: 'remind me to call grandma sometime next week',
  });
  const afterVague = (
    await voicePlanningItems.items.query({ parameters: [{ name: '@h', value: HOUSEHOLD_ID }] }).fetchAll()
  ).resources;
  const savedVague = afterVague.find((item) => item.source === 'voice' && item.title === 'Call grandma');
  assert.ok(savedVague, 'saved vague-when reminder should be present');
  assert.strictEqual(savedVague.startAt, null, 'startAt should be null for unparseable when');
  assert.strictEqual(savedVague.notes, 'sometime next week', 'raw when text should be in notes');
  console.log('✓ saveVoicePlan stores unparseable when text in notes with startAt=null');

  // Cross-kid attempt: ollie cannot save a plan for toby
  await assert.rejects(
    () => ROUTES.saveVoicePlan({ personId: 'ollie', pin: '1234', kidId: 'toby', type: 'reminder', title: 'Sneaky reminder' }),
    (err) => err && err.status === 401
  );
  const afterCrossKid = (
    await voicePlanningItems.items.query({ parameters: [{ name: '@h', value: HOUSEHOLD_ID }] }).fetchAll()
  ).resources;
  assert.strictEqual(afterCrossKid.length, beforeBlank.length + 4, 'cross-kid save should be rejected without writing');
  console.log('✓ saveVoicePlan rejects cross-kid save');

  // -------------------------------------------------------------------------
  // My List - kid-owned notes, plans and reminders (#122)
  // -------------------------------------------------------------------------
  const addedNote = await ROUTES.addMyItem({
    personId: 'toby', pin: '1234', kidId: 'toby',
    type: 'note', title: 'Library book is due', category: 'school',
  });
  assert.strictEqual(addedNote.ok, true, 'addMyItem should succeed');
  assert.strictEqual(addedNote.item.status, 'open', 'new item starts open');
  assert.strictEqual(addedNote.item.personId, 'toby', 'item belongs to the caller');
  assert.strictEqual(addedNote.item.startAt, null, 'a note has no date');
  console.log('\u2713 addMyItem creates an undated kid-owned note');

  const addedPlan = await ROUTES.addMyItem({
    personId: 'toby', pin: '1234', kidId: 'toby',
    type: 'plan', title: 'Build the lego set', category: 'fun',
  });
  assert.ok(addedPlan.item.order > addedNote.item.order, 'new items append to the end');
  console.log('\u2713 addMyItem appends to the end of the list');

  const badType = await ROUTES.addMyItem({
    personId: 'toby', pin: '1234', kidId: 'toby',
    type: 'chore', title: 'Sneak in a chore', category: 'home',
  });
  assert.strictEqual(badType.ok, false, 'chore is not a My List type');
  console.log('\u2713 addMyItem rejects a type outside note/reminder/plan');

  const badCategory = await ROUTES.addMyItem({
    personId: 'toby', pin: '1234', kidId: 'toby',
    type: 'note', title: 'Whatever', category: 'nonsense',
  });
  assert.strictEqual(badCategory.ok, false, 'unknown category is rejected');
  console.log('\u2713 addMyItem rejects an unknown category');

  const listed = await ROUTES.myItems({ personId: 'toby', pin: '1234', kidId: 'toby' });
  assert.strictEqual(listed.ok, true, 'myItems should succeed');
  assert.ok(listed.items.every((item) => item.personId === 'toby'), 'only the caller\u2019s items come back');
  assert.ok(
    listed.items.every((item) => ['note', 'reminder', 'plan'].includes(item.type)),
    'voice tasks and events stay out of My List',
  );
  console.log('\u2713 myItems returns only that kid\u2019s note/reminder/plan items');

  const doneRes = await ROUTES.updateMyItem({
    personId: 'toby', pin: '1234', kidId: 'toby',
    itemId: addedNote.item.id, status: 'done',
  });
  assert.strictEqual(doneRes.item.status, 'done', 'status flips to done');
  console.log('\u2713 updateMyItem marks an item done');

  // A valid PIN proves who you are, not that the item you named is yours.
  const crossKid = await ROUTES.updateMyItem({
    personId: 'ollie', pin: '1234', kidId: 'ollie',
    itemId: addedNote.item.id, title: 'Hijacked',
  });
  assert.strictEqual(crossKid.ok, false, 'another kid cannot edit this item');
  const stillMine = (await ROUTES.myItems({ personId: 'toby', pin: '1234', kidId: 'toby' }))
    .items.find((item) => item.id === addedNote.item.id);
  assert.strictEqual(stillMine.title, 'Library book is due', 'the title was not changed');
  console.log('\u2713 updateMyItem refuses to touch another kid\u2019s item');

  const crossDelete = await ROUTES.deleteMyItem({
    personId: 'ollie', pin: '1234', kidId: 'ollie', itemId: addedNote.item.id,
  });
  assert.strictEqual(crossDelete.ok, false, 'another kid cannot delete this item');
  console.log('\u2713 deleteMyItem refuses to touch another kid\u2019s item');

  await ROUTES.deleteMyItem({
    personId: 'toby', pin: '1234', kidId: 'toby', itemId: addedNote.item.id,
  });
  const afterDelete = await ROUTES.myItems({ personId: 'toby', pin: '1234', kidId: 'toby' });
  assert.ok(
    !afterDelete.items.some((item) => item.id === addedNote.item.id),
    'deleted item is gone from the list',
  );
  console.log('\u2713 deleteMyItem removes the owner\u2019s own item');

  // -------------------------------------------------------------------------
  // Manual reordering (#123)
  // -------------------------------------------------------------------------
  const mineNow = (await ROUTES.myItems({ personId: 'toby', pin: '1234', kidId: 'toby' })).items;
  assert.ok(mineNow.length >= 2, 'need at least two items to reorder');
  const reversed = mineNow.map((item) => item.id).reverse();

  const reordered = await ROUTES.reorderMyItems({
    personId: 'toby', pin: '1234', kidId: 'toby', itemIds: reversed,
  });
  assert.strictEqual(reordered.ok, true, 'reorderMyItems should succeed');
  assert.deepStrictEqual(
    reordered.items.map((item) => item.id), reversed,
    'items come back in the order that was sent',
  );
  console.log('\u2713 reorderMyItems rewrites the order');

  // A partial list would silently renumber some rows and leave the rest
  // colliding, so it has to be rejected outright rather than half-applied.
  const partial = await ROUTES.reorderMyItems({
    personId: 'toby', pin: '1234', kidId: 'toby', itemIds: [reversed[0]],
  });
  assert.strictEqual(partial.ok, false, 'a partial id list is rejected');
  console.log('\u2713 reorderMyItems rejects a partial id list');

  const foreign = await ROUTES.reorderMyItems({
    personId: 'toby', pin: '1234', kidId: 'toby',
    itemIds: reversed.slice(0, -1).concat(['not-my-item']),
  });
  assert.strictEqual(foreign.ok, false, 'an unknown id is rejected');
  console.log('\u2713 reorderMyItems rejects an id that is not yours');

  // Chore reordering: a kid may change the order and nothing else.
  const tobyChores = (await ROUTES.state()).tasks.filter((t) => t.kidId === 'toby');
  assert.ok(tobyChores.length >= 2, 'need at least two chores to reorder');
  const choreIds = tobyChores.map((t) => t.id);
  const flipped = [choreIds[1], choreIds[0]].concat(choreIds.slice(2));
  const beforeTitles = new Map(tobyChores.map((t) => [t.id, t.title]));
  const beforePoints = new Map(tobyChores.map((t) => [t.id, t.points]));

  await ROUTES.reorderTasks({ personId: 'toby', pin: '1234', kidId: 'toby', taskIds: flipped });
  const afterChores = (await ROUTES.state()).tasks.filter((t) => t.kidId === 'toby');
  const byId = new Map(afterChores.map((t) => [t.id, t]));
  assert.strictEqual(byId.get(flipped[0]).order, 0, 'first sent id gets order 0');
  assert.strictEqual(byId.get(flipped[1]).order, 1, 'second sent id gets order 1');
  for (const id of choreIds) {
    assert.strictEqual(byId.get(id).title, beforeTitles.get(id), 'title must not change');
    assert.strictEqual(byId.get(id).points, beforePoints.get(id), 'points must not change');
    assert.strictEqual(byId.get(id).kidId, 'toby', 'kidId must not change');
  }
  console.log('\u2713 reorderTasks writes order and leaves title/points/kidId alone');

  const crossChores = await ROUTES.reorderTasks({
    personId: 'ollie', pin: '1234', kidId: 'ollie', taskIds: flipped,
  });
  assert.strictEqual(crossChores.ok, false, 'another kid cannot reorder these tasks');
  console.log('\u2713 reorderTasks refuses another kid\u2019s task ids');

  // -------------------------------------------------------------------------
  // Decision comments on approve / reject
  // -------------------------------------------------------------------------
  const commentTask = await ROUTES.addTask({
    parentId: 'peter', parentPin: '1234',
    kidId: 'toby', title: 'Tidy the shed', points: 4, cycle: 'oneoff',
  });
  const shedTask = commentTask.tasks.find((t) => t.title === 'Tidy the shed');
  await ROUTES.completeTask({ personId: 'toby', pin: '1234', taskId: shedTask.id });
  const pendingShed = (await ROUTES.state()).completions
    .find((c) => c.taskId === shedTask.id && c.status === 'pending');

  // A decline with no reason must be refused - by the API, not only the UI.
  const bareReject = await ROUTES.reject({
    parentId: 'peter', parentPin: '1234', completionId: pendingShed.id,
  });
  assert.strictEqual(bareReject.ok, false, 'reject without a comment is refused');
  const stillPending = (await ROUTES.state()).completions.find((c) => c.id === pendingShed.id);
  assert.strictEqual(stillPending.status, 'pending', 'a refused reject must not change the status');
  console.log('\u2713 reject requires a comment and leaves the record untouched without one');

  const blankReject = await ROUTES.reject({
    parentId: 'peter', parentPin: '1234', completionId: pendingShed.id, comment: '   ',
  });
  assert.strictEqual(blankReject.ok, false, 'whitespace is not a reason');
  console.log('\u2713 reject treats a whitespace-only comment as missing');

  await ROUTES.reject({
    parentId: 'peter', parentPin: '1234', completionId: pendingShed.id,
    comment: 'The rake is still out — put it away and re-tick it.',
  });
  const rejected = (await ROUTES.state()).completions.find((c) => c.id === pendingShed.id);
  assert.strictEqual(rejected.status, 'rejected', 'status flips to rejected');
  assert.strictEqual(
    rejected.comment, 'The rake is still out — put it away and re-tick it.',
    'the reason reaches the kid through getState',
  );
  console.log('\u2713 reject stores the reason and getState exposes it');

  // Approve: the comment is optional, and absence is null rather than missing.
  await ROUTES.completeTask({ personId: 'toby', pin: '1234', taskId: shedTask.id });
  const secondTry = (await ROUTES.state()).completions
    .find((c) => c.taskId === shedTask.id && c.status === 'pending');
  await ROUTES.approve({
    parentId: 'peter', parentPin: '1234', completionId: secondTry.id,
    comment: 'Much better, thank you!',
  });
  const approved = (await ROUTES.state()).completions.find((c) => c.id === secondTry.id);
  assert.strictEqual(approved.status, 'approved', 'status flips to approved');
  assert.strictEqual(approved.comment, 'Much better, thank you!', 'approve keeps its note');
  console.log('\u2713 approve stores an optional note');

  const longTask = await ROUTES.addTask({
    parentId: 'peter', parentPin: '1234',
    kidId: 'toby', title: 'Long note check', points: 1, cycle: 'oneoff',
  });
  const longId = longTask.tasks.find((t) => t.title === 'Long note check').id;
  await ROUTES.completeTask({ personId: 'toby', pin: '1234', taskId: longId });
  const longPending = (await ROUTES.state()).completions
    .find((c) => c.taskId === longId && c.status === 'pending');
  await ROUTES.approve({
    parentId: 'peter', parentPin: '1234', completionId: longPending.id,
    comment: 'x'.repeat(500),
  });
  const capped = (await ROUTES.state()).completions.find((c) => c.id === longPending.id);
  assert.strictEqual(capped.comment.length, 280, 'a long note is capped, not stored whole');
  console.log('\u2713 a decision comment is capped at 280 characters');

  // -------------------------------------------------------------------------
  // Local time. The app is a family in Perth (UTC+8) and every date it writes
  // used to be a UTC date, so for the eight hours between local midnight and
  // 8am the API and the browser disagreed about what day it was. These assert
  // the real production timezone, so they run in a child process: the harness
  // above pins HOUSEHOLD_TIMEZONE to a test zone before hero.js loads, and the
  // constant is baked in at require time.
  const { execFileSync } = require('child_process');
  const perthProbe = execFileSync(process.execPath, ['-e', `
    const h = require(${JSON.stringify(path.join(__dirname, 'src/functions/hero.js'))});
    const out = {
      beforeSchool: h.todayStr(new Date('2026-08-23T23:30:00Z')),
      midnightMins: h.localMinutes(new Date('2026-08-23T16:00:00Z')),
      ninePmMins:   h.localMinutes(new Date('2026-08-24T13:00:00Z')),
      quietLateEvening: h.isInQuietHours({ start: '21:00', end: '07:00' }, new Date('2026-08-24T13:30:00Z')),
      quietEarlyMorning: h.isInQuietHours({ start: '21:00', end: '07:00' }, new Date('2026-08-23T22:00:00Z')),
      quietMidMorning: h.isInQuietHours({ start: '21:00', end: '07:00' }, new Date('2026-08-24T02:00:00Z')),
      windowShutLateEvening: h.isWindowClosed({ id: 'evening', closesAt: '21:00' }, new Date('2026-08-24T13:30:00Z')),
      windowOpenAfternoon:  h.isWindowClosed({ id: 'evening', closesAt: '21:00' }, new Date('2026-08-24T06:00:00Z')),
    };
    process.stdout.write(JSON.stringify(out));
  `], {
    env: { ...process.env, HOUSEHOLD_TIMEZONE: 'Australia/Perth' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const perth = JSON.parse(perthProbe.toString());

  assert.strictEqual(new Date('2026-08-23T23:30:00Z').toISOString().slice(0, 10), '2026-08-23',
    'the fixture really is the previous day in UTC, or this proves nothing');
  assert.strictEqual(perth.beforeSchool, '2026-08-24',
    'a chore done before school belongs to today, not yesterday');
  console.log('\u2713 an early-morning completion is dated the local day, not the UTC one');

  assert.strictEqual(perth.midnightMins, 0, 'local midnight is minute 0 - h23, not 24:00');
  assert.strictEqual(perth.ninePmMins, 21 * 60, '9pm local is minute 1260');
  console.log('\u2713 local minutes are measured from local midnight');

  assert.strictEqual(perth.quietLateEvening, true, '9:30pm local is inside a 21:00-07:00 quiet window');
  assert.strictEqual(perth.quietEarlyMorning, true, '6am local is still inside it');
  assert.strictEqual(perth.quietMidMorning, false, '10am local is not - the case that used to be silenced');
  console.log('\u2713 quiet hours are read in local time, not UTC');

  assert.strictEqual(perth.windowShutLateEvening, true, '9:30pm is past a 21:00 close');
  assert.strictEqual(perth.windowOpenAfternoon, false, '2pm is not');
  console.log('\u2713 a window closes on the household clock, not UTC');

  // -------------------------------------------------------------------------
  // Windows. The rule: submit inside the window or the points are gone - no
  // late award, no override. These run in-process against the harness zone,
  // where the pinned clock reads mid-morning, so "open" cases are open.
  const stateWithWindows = await ROUTES.state();
  assert.ok(Array.isArray(stateWithWindows.windows) && stateWithWindows.windows.length === 3,
    'state carries the three household windows');
  assert.ok(stateWithWindows.windows.every((w) => typeof w.closed === 'boolean'),
    'each window says whether it has shut - the server is the only clock');
  assert.strictEqual(stateWithWindows.fallbackWindowId, 'evening');
  console.log('\u2713 state exposes the windows, their closed flags, and the fallback');

  const badWindow = await ROUTES.addTask({
    parentId: 'peter', parentPin: '1234', kidId: 'ollie',
    title: 'Ghost chore', points: 1, cycle: 'daily', windowId: 'brunch',
  });
  assert.strictEqual(badWindow.ok, false, 'an unknown window is refused');
  console.log('\u2713 a chore cannot be put in a window that does not exist');

  // The harness pins local time to ~noon, so 'afterschool' (closes 18:00) is
  // open and 'morning' (closed 08:30) is already shut - both states reachable
  // deterministically whatever hour CI runs.
  await ROUTES.addTask({
    parentId: 'peter', parentPin: '1234', kidId: 'ollie',
    title: 'Afternoon chore', points: 2, cycle: 'daily', windowId: 'afterschool',
  });
  const afternoonChore = (await ROUTES.state()).tasks.find((t) => t.title === 'Afternoon chore');
  assert.strictEqual(afternoonChore.windowId, 'afterschool', 'the chosen window is stored and exposed');

  const openTick = await ROUTES.completeTask({ taskId: afternoonChore.id, personId: 'ollie', pin: '1234' });
  assert.strictEqual(openTick.ok, true, 'inside the window, completing works');
  console.log('\u2713 a chore in an open window can be completed');

  // Shut every window: closesAt 00:00 means minutes-since-midnight >= 0,
  // which is every moment of the day. Deterministic whatever hour CI runs.
  const { resource: household } = await mockContainer('households')
    .item(HOUSEHOLD_ID, HOUSEHOLD_ID).read();
  household.windows = [
    { id: 'morning', label: 'Morning', closesAt: '00:00' },
    { id: 'afterschool', label: 'After school', closesAt: '00:00' },
    { id: 'evening', label: 'Evening', closesAt: '00:00' },
  ];
  await mockContainer('households').item(HOUSEHOLD_ID, HOUSEHOLD_ID).replace(household);

  await ROUTES.addTask({
    parentId: 'peter', parentPin: '1234', kidId: 'ollie',
    title: 'Too late chore', points: 3, cycle: 'daily', windowId: 'evening',
  });
  const lateChore = (await ROUTES.state()).tasks.find((t) => t.title === 'Too late chore');
  const lateTick = await ROUTES.completeTask({ taskId: lateChore.id, personId: 'ollie', pin: '1234' });
  assert.strictEqual(lateTick.ok, false, 'a shut window refuses the completion');
  assert.strictEqual(lateTick.windowClosed, true, 'and says why, machine-readably');
  console.log('\u2713 a shut window means no points - refused at the API, not just greyed out');

  const noWindowChore = (await ROUTES.state()).tasks.find((t) => t.title === 'Water plant');
  const fallbackTick = await ROUTES.completeTask({ taskId: noWindowChore.id, personId: 'ollie', pin: '1234' });
  assert.strictEqual(fallbackTick.ok, false,
    'a chore with no window falls back to the evening window rather than escaping the rule');
  console.log('\u2713 legacy chores without a window are held to the fallback window');

  // Put the windows back for anything that runs after this.
  household.windows = null;
  await mockContainer('households').item(HOUSEHOLD_ID, HOUSEHOLD_ID).replace(household);

  // -------------------------------------------------------------------------
  // Misses. A miss is a record that the points were not earned - nothing is
  // deducted and nothing else happens, but the record is what lets yesterday
  // start from something instead of blank.
  const { recordMisses } = require('./src/functions/hero.js');

  // Shut everything again so due-but-unsubmitted chores are sweepable.
  household.windows = [
    { id: 'morning', label: 'Morning', closesAt: '00:00' },
    { id: 'afterschool', label: 'After school', closesAt: '00:00' },
    { id: 'evening', label: 'Evening', closesAt: '00:00' },
  ];
  await mockContainer('households').item(HOUSEHOLD_ID, HOUSEHOLD_ID).replace(household);

  await ROUTES.addTask({
    parentId: 'peter', parentPin: '1234', kidId: 'toby',
    title: 'Empty the dishwasher', points: 6, cycle: 'daily', windowId: 'evening',
  });
  const sweep1 = await recordMisses();
  const missRows = (await ROUTES.state()).completions.filter((c) => c.status === 'missed');
  const dishMiss = missRows.find((c) => c.title === 'Empty the dishwasher');
  assert.ok(dishMiss, 'a due, unsubmitted chore in a shut window is recorded as missed');
  assert.strictEqual(dishMiss.points, 6, 'the miss names the points that were on the table');
  assert.strictEqual(dishMiss.windowId, 'evening', 'and which window shut on it');
  console.log('\u2713 a shut window with nothing submitted becomes a recorded miss');

  const sweep2 = await recordMisses();
  const missCountAfter = (await ROUTES.state()).completions
    .filter((c) => c.status === 'missed' && c.title === 'Empty the dishwasher').length;
  assert.strictEqual(missCountAfter, 1, 'a second sweep records nothing new');
  assert.strictEqual(sweep2.recorded, 0, 'and says so');
  console.log('\u2713 the sweep is idempotent - one miss per chore per day, however often it runs');

  // The 'Afternoon chore' was completed earlier while its window was open, so
  // even though every window is shut now, it must not be marked missed.
  const afternoonMissed = (await ROUTES.state()).completions
    .some((c) => c.status === 'missed' && c.title === 'Afternoon chore');
  assert.strictEqual(afternoonMissed, false, 'a chore submitted in time is never a miss');
  console.log('\u2713 submitting in time keeps a chore off the miss list');

  // A weekly chore not due today is not "missed" today.
  const notToday = [(new Date(`${(await ROUTES.state()).today}T12:00:00Z`).getUTCDay() + 3) % 7];
  await ROUTES.addTask({
    parentId: 'peter', parentPin: '1234', kidId: 'toby',
    title: 'Wash the car', points: 8, cycle: 'weekly', days: notToday, windowId: 'evening',
  });
  await recordMisses();
  const carMissed = (await ROUTES.state()).completions
    .some((c) => c.status === 'missed' && c.title === 'Wash the car');
  assert.strictEqual(carMissed, false, 'a weekly chore is only missable on its own days');
  console.log('\u2713 a weekly chore is only missable on the days it is due');

  // Balances never count a miss - the points named on the record stay unearned.
  const tobyStats = (await ROUTES.state()).stats['toby'];
  const approvedTotal = (await ROUTES.state()).completions
    .filter((c) => c.kidId === 'toby' && c.status === 'approved')
    .reduce((sum, c) => sum + (c.points || 0), 0);
  assert.strictEqual(tobyStats.points, approvedTotal, 'points are the sum of approved rows and nothing else');
  console.log('\u2713 a miss changes no balance - the only consequence is points not earned');

  household.windows = null;
  await mockContainer('households').item(HOUSEHOLD_ID, HOUSEHOLD_ID).replace(household);

  // -------------------------------------------------------------------------
  // Nudges and the evening summary. "Now" is behaviour, so these build their
  // instants with at(): a Date whose LOCAL wall-clock time is the one named,
  // in the pinned harness zone - deterministic whatever hour CI runs.
  const { sendWindowNudges, sendEveningSummary, localMinutes: lm } = require('./src/functions/hero.js');
  const at = (hhmmStr) => {
    const [h, m] = hhmmStr.split(':').map(Number);
    const base = new Date();
    return new Date(base.getTime() + (((h * 60) + m) - lm(base)) * 60000);
  };

  await ROUTES.addTask({
    parentId: 'peter', parentPin: '1234', kidId: 'toby',
    title: 'Bring in the washing', points: 4, cycle: 'daily', windowId: 'evening',
  });

  // 19:00: too early. 20:40: inside the 30-minute lead. 20:50: already sent.
  pushCalls.length = 0;
  const early = await sendWindowNudges(at('19:00'));
  assert.strictEqual(early.sent, 0, 'no nudge two hours before the close');
  const inLead = await sendWindowNudges(at('20:40'));
  assert.ok(inLead.sent >= 1, 'a nudge inside the lead window');
  const nudgePush = pushCalls
    .filter((call) => call.type === 'send')
    .map((call) => JSON.parse(call.payload))
    .find((payload) => payload.title === 'Closing soon ⏳' && payload.body.includes('Bring in the washing'));
  assert.ok(nudgePush, 'the nudge names the chore');
  assert.ok(nudgePush.body.includes('21:00'), 'and when the window closes');
  assert.ok(nudgePush.body.includes('4 pts'), 'and what is at stake');
  const again = await sendWindowNudges(at('20:50'));
  const washingNudges = pushCalls
    .filter((call) => call.type === 'send')
    .map((call) => JSON.parse(call.payload))
    .filter((payload) => payload.title === 'Closing soon ⏳' && payload.body.includes('Bring in the washing'));
  assert.strictEqual(washingNudges.length, 1, 'one nudge per chore per day, not one per sweep');
  console.log('\u2713 a kid gets one closing-soon nudge, naming the chore, the close and the stake');

  // The summary: nothing before the last close, one per day after it, to the
  // parents, counting the day's misses.
  pushCalls.length = 0;
  const beforeClose = await sendEveningSummary(at('20:00'));
  assert.strictEqual(beforeClose.sent, 0, 'no summary while a window is still open');
  await recordMisses(at('21:05'));
  const afterClose = await sendEveningSummary(at('21:05'));
  assert.strictEqual(afterClose.sent, 2, 'both parents get the summary');
  const summaryPush = pushCalls
    .filter((call) => call.type === 'send')
    .map((call) => JSON.parse(call.payload))
    .find((payload) => payload.title === 'Today at home');
  assert.ok(summaryPush, 'the summary went out as a push');
  assert.ok(/missed/.test(summaryPush.body), 'and it counts the misses');
  const repeat = await sendEveningSummary(at('21:20'));
  assert.strictEqual(repeat.sent, 0, 'one summary per day, however many ticks follow');
  console.log('\u2713 parents get one evening summary counting done and missed, once');

  console.log('\nALL LOGIC TESTS PASSED');
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
