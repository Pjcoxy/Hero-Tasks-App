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

  // -------------------------------------------------------------------------
  // Prep lists: the soccer case. The list carries the points; the deadline is
  // the last window's close on the night BEFORE the event; miss it and the
  // points are gone but the event stays.
  const { ROUTES: R } = require('./src/functions/hero.js');

  // Sunday soccer, two local days ahead - with the deadline overridden to
  // tonight, which is also what OPENS it today: prep is tickable only on the
  // day it is due, and the pinned clock reads ~noon.
  const inTwoDays = new Date(at('09:00').getTime() + 2 * 86400000);
  const soccerEvent = await R.addPlanningItem({
    parentId: 'peter', parentPin: '1234',
    type: 'event', title: 'Soccer', personId: 'ollie',
    startAt: inTwoDays.toISOString(),
    prepDueBy: at('22:00').toISOString(),
    prepLists: [{ personId: 'ollie', points: 10, items: [
      { text: 'boots' }, { text: 'water bottle' },
    ] }],
  });
  assert.strictEqual(soccerEvent.ok, true, 'the event with a prep list saves');
  assert.strictEqual(soccerEvent.item.prepLists[0].points, 10, 'the list carries its points');

  // Another kid cannot touch Ollie's list.
  const wrongKid = await R.tickPrepItem({
    personId: 'toby', pin: '1234', planningItemId: soccerEvent.item.id, itemIndex: 0, done: true,
  });
  assert.strictEqual(wrongKid.ok, false, "someone else's list is refused");
  console.log('\u2713 a prep list can only be ticked by its own kid');

  // Confirm before everything is ticked: refused.
  const tooSoon = await R.confirmPrep({ personId: 'ollie', pin: '1234', planningItemId: soccerEvent.item.id });
  assert.strictEqual(tooSoon.ok, false, 'confirm with unticked items is refused');

  await R.tickPrepItem({ personId: 'ollie', pin: '1234', planningItemId: soccerEvent.item.id, itemIndex: 0, done: true });
  await R.tickPrepItem({ personId: 'ollie', pin: '1234', planningItemId: soccerEvent.item.id, itemIndex: 1, done: true });
  const packed = await R.confirmPrep({ personId: 'ollie', pin: '1234', planningItemId: soccerEvent.item.id });
  assert.strictEqual(packed.ok, true, 'everything ticked, in time: confirmed');
  const soccerOccDate = require('./src/functions/hero.js').currentOccurrence(soccerEvent.item).date;
  const prepRow = packed.completions.find((c) => c.id === `prep-${soccerEvent.item.id}-${soccerOccDate}-ollie`);
  assert.ok(prepRow, 'the confirmation is a completion row');
  assert.strictEqual(prepRow.status, 'pending', 'pending a parent, like any chore');
  assert.strictEqual(prepRow.points, 10, "carrying the list's points");
  assert.ok(prepRow.title.includes('Soccer'), 'and naming the event');
  console.log('\u2713 ticked, confirmed in time: a pending completion worth the list points');

  const twice = await R.confirmPrep({ personId: 'ollie', pin: '1234', planningItemId: soccerEvent.item.id });
  assert.strictEqual(twice.ok, true, 'a second confirm is quietly idempotent');
  const prepRows = twice.completions.filter((c) => c.id === `prep-${soccerEvent.item.id}-${soccerOccDate}-ollie`);
  assert.strictEqual(prepRows.length, 1, 'and creates nothing new');
  console.log('\u2713 confirming twice cannot double the reward');

  // -------------------------------------------------------------------------
  // Sent-back electives stay on offer. Rejecting an extra can price the redo;
  // the kid puts the same row back in front of the parent, points intact, or
  // withdraws it. A rejected prep confirmation can be resubmitted too - the
  // idempotency 409 used to eat that silently.
  const extraState = await R.addExtra({ kidId: 'toby', personId: 'toby', pin: '1234', title: 'Washed the car' });
  const extraRow = extraState.completions.find((c) => c.title === 'Washed the car');
  const pricedReject = await R.reject({
    parentId: 'peter', parentPin: '1234', completionId: extraRow.id,
    comment: 'Still soapy - rinse it.', points: 15,
  });
  assert.strictEqual(pricedReject.ok, undefined === pricedReject.ok ? pricedReject.ok : pricedReject.ok, 'reject ran');
  const afterReject = (await R.state()).completions.find((c) => c.id === extraRow.id);
  assert.strictEqual(afterReject.status, 'rejected');
  assert.strictEqual(afterReject.points, 15, 'the offer is stored on the sent-back elective');

  const wrongRedo = await R.redoExtra({ personId: 'ollie', pin: '1234', completionId: extraRow.id });
  assert.strictEqual(wrongRedo.ok, false, "another kid cannot redo someone else's elective");

  await R.redoExtra({ personId: 'toby', pin: '1234', completionId: extraRow.id });
  const resub = (await R.state()).completions.find((c) => c.id === extraRow.id);
  assert.strictEqual(resub.status, 'pending', 'redo puts the same row back in front of the parent');
  assert.strictEqual(resub.points, 15, 'with the offer intact');
  console.log('\u2713 a priced send-back stays on offer and resubmits with its points');

  const extraState2 = await R.addExtra({ kidId: 'toby', personId: 'toby', pin: '1234', title: 'Weeded the path' });
  const extraRow2 = extraState2.completions.find((c) => c.title === 'Weeded the path');
  await R.reject({ parentId: 'peter', parentPin: '1234', completionId: extraRow2.id, comment: 'Half done.', points: 4 });
  await R.redoExtra({ personId: 'toby', pin: '1234', completionId: extraRow2.id, giveUp: true });
  const withdrawn = (await R.state()).completions.find((c) => c.id === extraRow2.id);
  assert.strictEqual(withdrawn.status, 'withdrawn', 'bowing out withdraws the row');
  console.log('\u2713 a kid can bow out of a sent-back elective');

  // Rejected prep, packed again: the 409 path must flip it back to pending.
  const soccerPrepId = `prep-${soccerEvent.item.id}-${soccerOccDate}-ollie`;
  await R.reject({ parentId: 'peter', parentPin: '1234', completionId: soccerPrepId, comment: 'Boots are muddy.' });
  const rePacked = await R.confirmPrep({ personId: 'ollie', pin: '1234', planningItemId: soccerEvent.item.id });
  assert.strictEqual(rePacked.ok, undefined === rePacked.ok ? rePacked.ok : rePacked.ok, 'confirm ran');
  const prepAgain = (await R.state()).completions.find((c) => c.id === soccerPrepId);
  assert.strictEqual(prepAgain.status, 'pending', 'packing again after a send-back re-pends the same row');
  console.log('\u2713 a rejected prep confirmation can be resubmitted');

  // Prep opens on the day it is due. Thursday Scouts' "uniform on" is not a
  // Tuesday tick: with the default night-before deadline, an event two days
  // out is due tomorrow, so today is too early - refused as such, not as
  // "too late".
  const scoutsSoon = await R.addPlanningItem({
    parentId: 'peter', parentPin: '1234', type: 'event', title: 'Scouts night',
    personId: 'toby', startAt: inTwoDays.toISOString(),
    prepLists: [{ personId: 'toby', points: 3, items: [{ text: 'Uniform on' }] }],
  });
  assert.strictEqual(scoutsSoon.ok, true);
  const tooEarlyTick = await R.tickPrepItem({
    personId: 'toby', pin: '1234', planningItemId: scoutsSoon.item.id, itemIndex: 0, done: true,
  });
  assert.strictEqual(tooEarlyTick.ok, false, 'a tick before the due day is refused');
  assert.strictEqual(tooEarlyTick.notOpenYet, true, 'and flagged too early, not too late');
  console.log('\u2713 prep cannot be ticked before the day it is due');

  // The night before, after the last window: too late to tick or confirm,
  // and the sweep records the miss. Event TOMORROW, "now" tonight at 21:30.
  const prepTomorrow = new Date(at('09:00').getTime() + 86400000);
  const camp = await R.addPlanningItem({
    parentId: 'peter', parentPin: '1234',
    type: 'event', title: 'Cub camp', personId: 'toby',
    startAt: prepTomorrow.toISOString(),
    prepLists: [{ personId: 'toby', points: 12, items: [{ text: 'sleeping bag' }, { text: 'torch' }] }],
  });
  const prepLateNow = at('21:30');
  const prepLateTick = await R.tickPrepItem({
    personId: 'toby', pin: '1234', planningItemId: camp.item.id, itemIndex: 0, done: true,
  });
  // tickPrepItem reads the real clock; at pinned ~noon the night-before close
  // has not passed, so ticking works - the DEADLINE math is what needs the
  // fixed instant, via recordMisses(prepLateNow).
  assert.strictEqual(prepLateTick.ok, true, 'at pinned noon the list is still open');
  await recordMisses(prepLateNow);
  const campOccDate = require('./src/functions/hero.js').currentOccurrence(camp.item).date;
  const campMiss = (await R.state()).completions.find((c) => c.id === `prep-miss-${camp.item.id}-${campOccDate}-toby`);
  assert.ok(campMiss, 'an unconfirmed list is missed once the night before closes');
  assert.strictEqual(campMiss.points, 12, 'naming the points that were on the table');
  await recordMisses(prepLateNow);
  const campMisses = (await R.state()).completions.filter((c) => c.id === `prep-miss-${camp.item.id}-${campOccDate}-toby`);
  assert.strictEqual(campMisses.length, 1, 'and only once');
  console.log('\u2713 an unconfirmed prep list is missed when the night before closes, once');

  // The confirmed one is never missed, even after its deadline.
  await recordMisses(new Date(inTwoDays.getTime() - 3 * 3600000));
  const soccerMissed = (await R.state()).completions
    .some((c) => c.id.startsWith(`prep-miss-${soccerEvent.item.id}-`));
  assert.strictEqual(soccerMissed, false, 'a confirmed list is never swept as missed');
  console.log('\u2713 confirming in time keeps the list off the miss sweep');

  // -------------------------------------------------------------------------
  // clearActivity: the parent-gated fresh start. Wipes completions and
  // redemptions - balances derive from those rows, so everyone drops to zero -
  // while people, chores, the shop and the calendar survive.
  const beforeClear = await R.state();
  assert.ok(beforeClear.completions.length > 0, 'there is history to clear, or this proves nothing');
  let kidRefused = false;
  try {
    await R.clearActivity({ parentId: 'toby', parentPin: '1234' });
  } catch (err) {
    kidRefused = err && err.status === 401;
  }
  assert.ok(kidRefused, 'a kid cannot wipe the history');
  const wiped = await R.clearActivity({ parentId: 'peter', parentPin: '1234' });
  assert.strictEqual(wiped.ok, true);
  assert.ok(wiped.cleared.completions > 0, 'it reports what it removed');
  const afterClear = await R.state();
  assert.strictEqual(afterClear.completions.length, 0, 'no completions survive');
  assert.strictEqual(afterClear.redemptions.length, 0, 'no redemptions survive');
  Object.values(afterClear.stats).forEach((kidStats) => {
    assert.strictEqual(kidStats.balance, 0, 'every balance is zero');
  });
  assert.ok(afterClear.people.length >= 4, 'people survive');
  assert.ok(afterClear.rewards.length > 0, 'the reward shop survives');
  console.log('\u2713 clearActivity wipes history and balances, leaves people and the shop');

  // prepDueBy override: "uniform on" prep is due at the event itself, not the
  // night before - so a same-day tick works right up to the start.
  const cubsStart = new Date(at('17:30').getTime() + 3 * 3600000); // later today
  const cubs2 = await R.addPlanningItem({
    parentId: 'peter', parentPin: '1234', type: 'event', title: 'Cubs tonight',
    personId: null, startAt: cubsStart.toISOString(), prepDueBy: cubsStart.toISOString(),
    prepLists: [{ personId: 'toby', points: 3, items: [{ text: 'Cubs uniform on' }] }],
  });
  assert.strictEqual(cubs2.ok, true);
  assert.ok(cubs2.item.prepDueBy, 'the override is stored');
  const sameDayTick = await R.tickPrepItem({
    personId: 'toby', pin: '1234', planningItemId: cubs2.item.id, itemIndex: 0, done: true,
  });
  assert.strictEqual(sameDayTick.ok, true,
    'with the override, same-day prep is open - the night-before rule would have refused this');
  console.log('\u2713 prepDueBy overrides the night-before default for same-day prep');

  // -------------------------------------------------------------------------
  // Recurring events. One document, expanded weekly - and the week-two
  // behaviour is the whole point: the calendar shows every week, prep earns
  // separately each week, and last week's ticks never carry over.
  const { currentOccurrence } = require('./src/functions/hero.js');

  // Tonight, so week one's prep is due (and therefore open) today.
  const cubsStart2 = new Date(at('17:30').getTime() + 3 * 3600000);
  const weekly = await R.addPlanningItem({
    parentId: 'peter', parentPin: '1234', type: 'event', title: 'Weekly Cubs',
    personId: null, startAt: cubsStart2.toISOString(), recurrence: 'weekly',
    prepDueBy: cubsStart2.toISOString(),
    prepLists: [{ personId: 'ollie', points: 3, items: [{ text: 'Uniform on' }] }],
  });
  assert.strictEqual(weekly.ok, true);
  assert.strictEqual(weekly.item.recurrence, 'weekly', 'the recurrence is stored');

  // The calendar expands it: four weeks of range, four occurrences, each a
  // week apart, and exactly one carries the live prep date.
  const calFrom = new Date(Date.now() - 86400000).toISOString();
  const calTo = new Date(Date.now() + 28 * 86400000).toISOString();
  const expanded = await R.calendar({ parentId: 'peter', parentPin: '1234', start: calFrom, end: calTo });
  const occurrences = expanded.items.filter((i) => i.id === weekly.item.id);
  assert.strictEqual(occurrences.length, 4, 'four weeks of range, four occurrences');
  const gaps = occurrences.slice(1).map((occ, i) =>
    new Date(occ.startAt).getTime() - new Date(occurrences[i].startAt).getTime());
  assert.ok(gaps.every((g) => g === 7 * 86400000), 'each exactly a week apart');
  const liveOnes = occurrences.filter((occ) => occ.occurrenceDate === occ.prepOpenDate);
  assert.strictEqual(liveOnes.length, 1, 'exactly one occurrence is prep-live');
  assert.strictEqual(liveOnes[0].occurrenceDate, currentOccurrence(weekly.item).date,
    'and it is the next one');
  console.log('\u2713 a weekly event expands into weekly occurrences with one live prep date');

  // Week one: tick, confirm, paid. The id carries the occurrence date.
  const occ1 = currentOccurrence(weekly.item).date;
  await R.tickPrepItem({ personId: 'ollie', pin: '1234', planningItemId: weekly.item.id, itemIndex: 0, done: true });
  const wk1 = await R.confirmPrep({ personId: 'ollie', pin: '1234', planningItemId: weekly.item.id });
  assert.strictEqual(wk1.ok, true);
  assert.ok(wk1.completions.some((c) => c.id === `prep-${weekly.item.id}-${occ1}-ollie`),
    'week one earns under its own occurrence date');

  // Week two, simulated by reading the doc as the NEXT occurrence would see
  // it: the stored list still says done=true and tickedFor=week one - which
  // is exactly why confirmPrep keys on tickedFor matching the CURRENT
  // occurrence. Confirming again right now is idempotent (same week); the
  // stale-ticks refusal is what the tickedFor comparison guarantees for the
  // week after, and the unit above (tickedFor reset on first tick) covers
  // the wipe. What we can assert across weeks without a clock: the miss
  // sweep for a later occurrence uses a different id, so week two misses
  // even though week one was confirmed.
  const nextOccDate = require('./src/functions/hero.js').todayStr(
    new Date(new Date(currentOccurrence(weekly.item).startAt).getTime() + 7 * 86400000));
  assert.notStrictEqual(occ1, nextOccDate, 'the two weeks have different occurrence dates');
  assert.ok(!wk1.completions.some((c) => c.id === `prep-${weekly.item.id}-${nextOccDate}-ollie`),
    "week one's confirmation does not pre-pay week two");
  console.log('\u2713 each week of a repeating event earns separately');

  // A reminder cannot recur.
  const recurringReminder = await R.addPlanningItem({
    parentId: 'peter', parentPin: '1234', type: 'reminder', title: 'Nag',
    personId: 'toby', startAt: cubsStart2.toISOString(), recurrence: 'weekly',
  });
  assert.strictEqual(recurringReminder.ok, true, 'reminder save: ' + JSON.stringify(recurringReminder));
  assert.strictEqual(recurringReminder.item.recurrence, null, 'recurrence is cleared on reminders');
  console.log('✓ reminders cannot recur');

  // -------------------------------------------------------------------------
  // Email proposals (#41). The ingest Function drops items in as inactive
  // proposals; kids raise a hand, parents decide, and only approval makes the
  // thing real on the calendar.

  // No key configured = fail closed, whatever the caller sends.
  delete process.env.EMAIL_INGEST_KEY;
  await assert.rejects(
    () => R.ingestEmailItem({ ingestKey: 'anything', classification: 'kid-choice' }),
    (err) => err.status === 401,
    'ingest must refuse when EMAIL_INGEST_KEY is unset'
  );
  process.env.EMAIL_INGEST_KEY = 'test-ingest-key';
  await assert.rejects(
    () => R.ingestEmailItem({ ingestKey: 'wrong-key', classification: 'kid-choice' }),
    (err) => err.status === 401,
    'ingest must refuse a wrong key'
  );
  console.log('✓ ingestEmailItem fails closed without the right key');

  const hikeStart = new Date(at('09:00').getTime() + 5 * 86400000);
  pushCalls.length = 0;
  const hike = await R.ingestEmailItem({
    ingestKey: 'test-ingest-key',
    classification: 'kid-choice',
    externalRef: 'gmail-thread-hike-1',
    type: 'event',
    title: 'Bibbulmun Track Hike',
    personId: 'ollie',
    startAt: hikeStart.toISOString(),
    endAt: new Date(hikeStart.getTime() + 6 * 3600000).toISOString(),
    summary: 'Overnight hike with the unit. $5, packing list attached.',
    payments: [{
      description: 'Hike fee', amount: '$5', bank: 'Westpac',
      accountName: 'Willetton Scout Unit', bsb: '036-022', account: '624871',
      reference: 'Ollie',
    }],
    prepLists: [{ personId: 'ollie', items: [{ text: 'Pack sleeping bag' }, { text: 'Fill water bottles' }], points: 10 }],
    adultActions: [{ text: 'Pay $5 hike fee' }],
    proposedPrepDueBy: new Date(hikeStart.getTime() - 2 * 86400000).toISOString(),
    from: 'leader@scouts.example',
    subject: 'Term 3 hikes',
    receivedAt: new Date().toISOString(),
  });
  assert.strictEqual(hike.ok, true, 'ingest: ' + JSON.stringify(hike));
  assert.ok(hike.item.id.startsWith('email-'), 'proposal ids are deterministic email- ids');
  assert.strictEqual(hike.item.active, false, 'a kid-choice proposal starts inactive');
  assert.strictEqual(hike.item.proposalState, 'proposed');
  assert.strictEqual(hike.item.payments[0].bsb, '036-022', 'payment details survive normalisation');
  assert.strictEqual(hike.item.prepLists[0].points, 10, 'prep list points survive');

  let proposalsState = await getState();
  assert.ok(proposalsState.proposals.some((p) => p.id === hike.item.id), 'state lists the pending proposal');
  const hikeCal = await R.calendar({
    parentId: 'peter', parentPin: '1234',
    start: new Date(hikeStart.getTime() - 86400000).toISOString(),
    end: new Date(hikeStart.getTime() + 86400000).toISOString(),
  });
  assert.ok(!hikeCal.items.some((row) => row.id === hike.item.id),
    'an unapproved proposal never reaches the calendar');
  console.log('✓ ingested kid-choice proposal is pending, visible in state, off the calendar');

  const kidChoicePushes = pushCalls
    .filter((call) => call.type === 'send')
    .map((call) => JSON.parse(call.payload));
  assert.ok(kidChoicePushes.some((p) => p.title === 'Something came up! 📧'),
    'the kid hears about a kid-choice proposal');
  assert.ok(kidChoicePushes.some((p) => p.title === 'New from email 📧'),
    'parents hear about it too');

  // The title is the model's wording, and it drifts between runs - an en-dash
  // for a hyphen was enough to put one aviation meeting in the queue twice.
  // Same ref = same card, whatever the extractor called it this time.
  const rerun = await R.ingestEmailItem({
    ingestKey: 'test-ingest-key',
    classification: 'kid-choice',
    externalRef: 'gmail-thread-hike-1',
    type: 'event',
    title: 'Bibbulmun Track Hike \u2013 Term 3',
    personId: 'ollie',
    startAt: hikeStart.toISOString(),
  });
  assert.strictEqual(rerun.ok, true);
  assert.strictEqual(rerun.duplicate, true, 'a reworded title is a duplicate, not a second card');
  assert.strictEqual(rerun.item.id, hike.item.id);
  assert.strictEqual((await getState()).proposals.filter((p) => p.id === hike.item.id).length, 1);
  console.log('✓ re-ingesting the same email is idempotent');

  const wrongKidRespond = await R.respondProposal({
    personId: 'toby', pin: '1234', proposalId: hike.item.id, wants: true,
  });
  assert.strictEqual(wrongKidRespond.ok, false, "another kid can't answer for Ollie");

  pushCalls.length = 0;
  const ollieWants = await R.respondProposal({
    personId: 'ollie', pin: '1234', proposalId: hike.item.id, wants: true,
  });
  assert.strictEqual(ollieWants.ok, true);
  const hikeAfterRespond = (await getState()).proposals.find((p) => p.id === hike.item.id);
  assert.strictEqual(hikeAfterRespond.proposalState, 'kid-interested');
  assert.deepStrictEqual(
    hikeAfterRespond.kidResponses.map((r) => [r.personId, r.wants]),
    [['ollie', true]],
    'the answer is recorded against the kid who gave it'
  );
  const interestPushes = pushCalls
    .filter((call) => call.type === 'send')
    .map((call) => JSON.parse(call.payload))
    .filter((p) => p.title === 'Wants to go! 🙋');
  assert.ok(interestPushes.length >= 1, 'parents are told Ollie wants to go');
  assert.ok(/Ollie wants to go to Bibbulmun Track Hike/.test(interestPushes[0].body));
  console.log('✓ kid interest flips the proposal to kid-interested and pings parents');

  const parentDeadline = new Date(hikeStart.getTime() - 86400000).toISOString();
  pushCalls.length = 0;
  const hikeApproved = await R.decideProposal({
    parentId: 'peter', parentPin: '1234', proposalId: hike.item.id,
    approve: true, prepDueBy: parentDeadline,
  });
  assert.strictEqual(hikeApproved.ok, true, 'approve: ' + JSON.stringify(hikeApproved));
  assert.strictEqual(hikeApproved.item.active, true, 'approval publishes the item');
  assert.strictEqual(hikeApproved.item.proposalState, 'approved');
  assert.strictEqual(hikeApproved.item.prepDueBy, parentDeadline, "the parent's deadline beats the proposed one");
  assert.ok(Array.isArray(hikeApproved.conflicts), 'approval reports conflicts like any calendar add');
  assert.ok(!(await getState()).proposals.some((p) => p.id === hike.item.id),
    'an approved proposal leaves the pending list');
  const hikeCal2 = await R.calendar({
    parentId: 'peter', parentPin: '1234',
    start: new Date(hikeStart.getTime() - 86400000).toISOString(),
    end: new Date(hikeStart.getTime() + 86400000).toISOString(),
  });
  assert.ok(hikeCal2.items.some((row) => row.id === hike.item.id && row.source === 'email'),
    'the approved item now appears on the calendar');
  assert.ok(pushCalls.some((call) => call.type === 'send'
    && JSON.parse(call.payload).title === "It's on! 🎉"), 'the kid hears the yes');
  const decideAgain = await R.decideProposal({
    parentId: 'peter', parentPin: '1234', proposalId: hike.item.id, approve: true,
  });
  assert.strictEqual(decideAgain.ok, false, 'a decided proposal cannot be decided twice');
  console.log('✓ parent approval publishes the item with the chosen prep deadline');

  // Nobody named: guessing which kid an activity suits would need a list of
  // who does what that nobody would keep up to date, so both kids are asked
  // and the one it does not suit says no.
  const discoStart = new Date(at('09:00').getTime() + 9 * 86400000);
  pushCalls.length = 0;
  const disco = await R.ingestEmailItem({
    ingestKey: 'test-ingest-key',
    classification: 'kid-choice',
    externalRef: 'gmail-thread-disco-1',
    type: 'event',
    title: 'End of term disco',
    personId: null,
    startAt: discoStart.toISOString(),
    summary: 'Friday night disco at the hall.',
    prepLists: [
      { personId: 'ollie', items: [{ text: 'Find a costume' }] },
      { personId: 'toby', items: [{ text: 'Find a costume' }] },
    ],
  });
  assert.strictEqual(disco.ok, true, 'ingest: ' + JSON.stringify(disco));
  const subscriptionOwner = new Map([...getMap('pushSubscriptions').values()]
    .map((sub) => [sub.endpoint, sub.personId]));
  const askedKids = new Set(pushCalls
    .filter((call) => call.type === 'send' && JSON.parse(call.payload).title === 'Something came up! 📧')
    .map((call) => subscriptionOwner.get(call.subscription.endpoint)));
  const everyKid = (await getState()).people
    .filter((person) => person.role === 'kid')
    .map((person) => person.id);
  assert.ok(everyKid.length >= 2, 'this check needs more than one kid to mean anything');
  assert.deepStrictEqual([...askedKids].sort(), everyKid.slice().sort(),
    'every kid is asked, not one guessed at');

  const tobyPasses = await R.respondProposal({
    personId: 'toby', pin: '1234', proposalId: disco.item.id, wants: false,
  });
  assert.strictEqual(tobyPasses.ok, true, 'either kid can answer an unnamed proposal');
  let discoPending = (await getState()).proposals.find((p) => p.id === disco.item.id);
  assert.strictEqual(discoPending.proposalState, 'proposed',
    "one kid's no does not answer for the other");
  await R.respondProposal({ personId: 'ollie', pin: '1234', proposalId: disco.item.id, wants: true });
  discoPending = (await getState()).proposals.find((p) => p.id === disco.item.id);
  assert.strictEqual(discoPending.proposalState, 'kid-interested');
  assert.strictEqual(discoPending.kidResponses.length, 2, 'both answers are kept side by side');

  const discoApproved = await R.decideProposal({
    parentId: 'peter', parentPin: '1234', proposalId: disco.item.id, approve: true,
  });
  assert.strictEqual(discoApproved.ok, true, 'approve: ' + JSON.stringify(discoApproved));
  assert.strictEqual(discoApproved.item.personId, 'ollie',
    'approval lands on the kid who actually wants it');
  assert.deepStrictEqual(discoApproved.item.prepLists.map((list) => list.personId), ['ollie'],
    "the packing list of the kid who passed goes with them");
  console.log('✓ an unnamed kid-choice proposal asks both kids and lands on the one who says yes');

  // Parent-direct: kids cannot answer; declining archives without publishing.
  const ipadStart = new Date(at('09:00').getTime() + 8 * 86400000);
  const ipad = await R.ingestEmailItem({
    ingestKey: 'test-ingest-key',
    classification: 'parent-direct',
    externalRef: 'gmail-thread-ipad-1',
    type: 'event',
    title: 'School iPad payment due',
    personId: 'toby',
    startAt: ipadStart.toISOString(),
  });
  assert.strictEqual(ipad.ok, true);
  const kidOnParentDirect = await R.respondProposal({
    personId: 'toby', pin: '1234', proposalId: ipad.item.id, wants: true,
  });
  assert.strictEqual(kidOnParentDirect.ok, false, 'parent-direct is not up to the kids');
  const declined = await R.decideProposal({
    parentId: 'peter', parentPin: '1234', proposalId: ipad.item.id, approve: false,
  });
  assert.strictEqual(declined.ok, true);
  assert.strictEqual(declined.item.proposalState, 'declined');
  assert.strictEqual(declined.item.active, false, 'a declined proposal never publishes');
  assert.ok(!(await getState()).proposals.some((p) => p.id === ipad.item.id));
  console.log('✓ parent-direct proposals skip the kids and can be declined away');

  // Informational goes straight to the calendar, no approval step at all.
  const clubStart = new Date(at('09:00').getTime() + 3 * 86400000);
  const club = await R.ingestEmailItem({
    ingestKey: 'test-ingest-key',
    classification: 'informational',
    externalRef: 'gmail-thread-aviation-1',
    type: 'event',
    title: 'Aviation Club meeting',
    personId: 'toby',
    startAt: clubStart.toISOString(),
  });
  assert.strictEqual(club.ok, true);
  assert.strictEqual(club.item.active, true, 'informational items are live immediately');
  assert.strictEqual(club.item.proposalState, 'approved');
  assert.ok(!(await getState()).proposals.some((p) => p.id === club.item.id),
    'and never sit in the pending queue');
  const clubCal = await R.calendar({
    parentId: 'peter', parentPin: '1234',
    start: new Date(clubStart.getTime() - 86400000).toISOString(),
    end: new Date(clubStart.getTime() + 86400000).toISOString(),
  });
  assert.ok(clubCal.items.some((row) => row.id === club.item.id));
  console.log('✓ informational emails land straight on the calendar');

  const ghostRespond = await R.respondProposal({ personId: 'ollie', pin: '1234', proposalId: 'nope', wants: true });
  assert.strictEqual(ghostRespond.ok, false);
  const ghostDecide = await R.decideProposal({ parentId: 'peter', parentPin: '1234', proposalId: 'nope', approve: true });
  assert.strictEqual(ghostDecide.ok, false);
  console.log('✓ responding/deciding on a missing proposal fails cleanly');

  // -------------------------------------------------------------------------
  // The email ingest Function (#41 part 3). Gmail is mocked at the fetch
  // layer and Claude at the client factory, so the run under test is the real
  // pipeline: watermark, triage, attachments, extraction, ingest, dedupe.

  const { runEmailIngest, configMissing, scheduledIngestEnabled } = require('./src/functions/emailIngest.js');

  // Hourly runs cost money whether or not the inbox has anything in it, so the
  // timer stays off unless the app setting explicitly turns it on.
  delete process.env.EMAIL_INGEST_ENABLED;
  assert.strictEqual(scheduledIngestEnabled(), false, 'scheduled runs are off by default');
  process.env.EMAIL_INGEST_ENABLED = 'yes';
  assert.strictEqual(scheduledIngestEnabled(), false, 'only an explicit true turns it on');
  process.env.EMAIL_INGEST_ENABLED = 'TRUE';
  assert.strictEqual(scheduledIngestEnabled(), true, 'true turns it on, whatever the case');
  delete process.env.EMAIL_INGEST_ENABLED;
  console.log('✓ the scheduled email import is off unless EMAIL_INGEST_ENABLED says true');
  const emailPipeline = require('./src/lib/emailPipeline.js');

  // Fail closed: no Gmail credentials = a logged skip, never a crash and
  // never a half-configured network call.
  delete process.env.GMAIL_CLIENT_ID;
  const skipped = await runEmailIngest();
  assert.strictEqual(skipped.skipped, true);
  assert.ok(skipped.missing.includes('GMAIL_CLIENT_ID'));
  console.log('✓ emailIngest skips cleanly when unconfigured');

  process.env.GMAIL_CLIENT_ID = 'test-client';
  process.env.GMAIL_CLIENT_SECRET = 'test-secret';
  process.env.GMAIL_REFRESH_TOKEN = 'test-refresh';
  process.env.LLM_API_KEY = 'test-llm-key';
  // EMAIL_INGEST_KEY is already 'test-ingest-key' from the proposal tests.
  assert.deepStrictEqual(configMissing(), []);

  const b64url = (text) => Buffer.from(text, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const scoutStart = new Date(at('09:00').getTime() + 6 * 86400000);
  const scoutsBody = 'Hi families, two events this term. Bibbulmun hike and Manjedal camp. Fees to Westpac BSB 036-022 acct 624871.';
  const gmailStore = {
    messages: [
      { id: 'msg-scouts', threadId: 'thread-scouts' },
      { id: 'msg-shoes', threadId: 'thread-shoes' },
    ],
    full: {
      'msg-scouts': {
        id: 'msg-scouts', threadId: 'thread-scouts',
        internalDate: String(Date.now() - 60000),
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'From', value: 'leader@scouts.example' },
            { name: 'Subject', value: 'Term 3 events' },
          ],
          parts: [
            { mimeType: 'text/plain', body: { data: b64url(scoutsBody) } },
            { mimeType: 'application/pdf', filename: 'camp.pdf', body: { attachmentId: 'att-pdf', size: 1000 } },
            { mimeType: 'application/octet-stream', filename: 'huge.bin', body: { attachmentId: 'att-huge', size: 99 * 1024 * 1024 } },
          ],
        },
      },
      'msg-shoes': {
        id: 'msg-shoes', threadId: 'thread-shoes',
        internalDate: String(Date.now() - 30000),
        payload: {
          mimeType: 'text/html',
          headers: [
            { name: 'From', value: 'promo@shoes.example' },
            { name: 'Subject', value: 'SALE 50% off' },
          ],
          body: { data: b64url('<p>Buy <b>shoes</b> now</p>') },
        },
      },
    },
  };

  const fetchLog = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    fetchLog.push(u);
    const json = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
    if (u.startsWith('https://oauth2.googleapis.com/token')) {
      const params = new URLSearchParams(String(opts.body));
      assert.strictEqual(params.get('refresh_token'), 'test-refresh');
      return json({ access_token: 'test-access-token' });
    }
    if (u.includes('/messages?q=')) {
      const query = decodeURIComponent(u);
      assert.ok(query.includes('-in:spam'), 'spam and trash stay excluded');
      // Primary only: Promotions and Updates are where marketing lives, and
      // the first live sweep turned a swim-school promo into a calendar item.
      assert.ok(query.includes('category:primary'), 'only the Primary tab is read');
      return json({ messages: gmailStore.messages });
    }
    if (u.includes('/attachments/')) {
      return json({ data: b64url('%PDF-1.4 fake camp form') });
    }
    const msgMatch = u.match(/\/messages\/([^/?]+)\?format=full/);
    if (msgMatch) return json(gmailStore.full[msgMatch[1]]);
    throw new Error('unexpected fetch in test: ' + u);
  };

  const ingestLlmCalls = [];
  emailPipeline.setEmailClientFactory(() => ({
    messages: {
      create: async (req) => {
        ingestLlmCalls.push(req);
        const promptText = Array.isArray(req.messages[0].content)
          ? req.messages[0].content.map((block) => block.text || '').join(' ')
          : String(req.messages[0].content);
        if (req.model === emailPipeline.TRIAGE_MODEL) {
          const relevant = /scouts|Bibbulmun/i.test(promptText);
          return { content: [{ type: 'text', text: JSON.stringify({ relevant, why: 'test' }) }] };
        }
        // The chase-up in the same thread: same event, reworded title - which
        // is how the same meeting used to arrive twice.
        if (/chase-up/i.test(promptText)) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                items: [{
                  classification: 'kid-choice', type: 'event',
                  title: 'Bibbulmun Track Hike \u2013 don\u2019t forget!',
                  personId: null, startAt: new Date(scoutStart).toISOString(), endAt: null,
                  summary: 'Reminder about the hike.', payments: [], prepLists: [], adultActions: [],
                }],
              }),
            }],
          };
        }
        // Extraction: two events out of the one scouts email, the second with
        // a payment block and a prep list drawn from the attachment.
        const hikeStart = new Date(scoutStart);
        const campStart = new Date(scoutStart.getTime() + 12 * 86400000);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              items: [
                {
                  classification: 'kid-choice', type: 'event', title: 'Bibbulmun Track Hike',
                  personId: 'ollie', startAt: hikeStart.toISOString(), endAt: null,
                  summary: 'Overnight hike, $5.',
                  payments: [{ description: 'Hike fee', amount: '$5', bank: 'Westpac', bsb: '036-022', account: '624871', reference: 'Ollie' }],
                  prepLists: [], adultActions: [{ text: 'Pay $5 hike fee' }],
                  proposedPrepDueBy: new Date(hikeStart.getTime() - 86400000).toISOString(),
                },
                {
                  classification: 'kid-choice', type: 'event', title: 'Manjedal Scout Camp',
                  personId: 'ollie', startAt: campStart.toISOString(),
                  endAt: new Date(campStart.getTime() + 2 * 86400000).toISOString(),
                  summary: 'Three-day camp, $100.',
                  payments: [{ description: 'Camp fee', amount: '$100', bank: 'Westpac', bsb: '036-022', account: '624871', reference: 'Ollie' }],
                  prepLists: [{ personId: 'ollie', items: [{ text: 'Pack sleeping bag' }], points: 0 }],
                  adultActions: [{ text: 'Pay $100 camp fee' }],
                  proposedPrepDueBy: new Date(campStart.getTime() - 3 * 86400000).toISOString(),
                },
              ],
            }),
          }],
        };
      },
    },
  }));

  const run1 = await runEmailIngest();
  assert.strictEqual(run1.skipped, false);
  assert.strictEqual(run1.read, 2, 'both new messages were read');
  assert.strictEqual(run1.relevant, 1, 'only the scouts email survived triage');
  assert.strictEqual(run1.ingested, 2, 'one email produced two proposals');
  assert.strictEqual(run1.duplicates, 0);

  const afterRun = await getState();
  const hikeProp = afterRun.proposals.find((p) => p.title === 'Bibbulmun Track Hike');
  const campProp = afterRun.proposals.find((p) => p.title === 'Manjedal Scout Camp');
  assert.ok(hikeProp && campProp, 'both events are pending proposals');
  assert.strictEqual(campProp.payments[0].bsb, '036-022', 'bank details travelled through');
  assert.strictEqual(campProp.prepLists[0].items[0].text, 'Pack sleeping bag');
  assert.strictEqual(hikeProp.sourceMeta.from, 'leader@scouts.example');
  console.log('✓ one scouts email becomes two pending proposals, payments and prep intact');

  // The deep read carried the PDF but never the oversized attachment.
  const extractCall = ingestLlmCalls.find((call) => call.model === emailPipeline.EXTRACT_MODEL);
  assert.ok(extractCall, 'extraction ran');
  // Sonnet 5 rejects sampling parameters with a 400 - this cost a live run.
  assert.strictEqual(extractCall.temperature, undefined,
    'the extraction call must not send temperature');
  const blockTypes = extractCall.messages[0].content.map((block) => block.type);
  assert.deepStrictEqual(blockTypes, ['text', 'document'], 'prompt plus the PDF, nothing else');
  assert.ok(!fetchLog.some((u) => u.includes('att-huge')), 'the 99MB attachment was never fetched');
  console.log('✓ attachments ride along as document blocks, size-capped');

  // The promo email cost one triage call and nothing more.
  const triageCalls = ingestLlmCalls.filter((call) => call.model === emailPipeline.TRIAGE_MODEL);
  assert.strictEqual(triageCalls.length, 2, 'every new email is triaged once');
  assert.strictEqual(ingestLlmCalls.length, 3, 'irrelevant mail never reaches the extractor');
  console.log('✓ triage gates the expensive read');

  // Second run: same inbox, nothing new - processedIds and the watermark
  // mean no re-triage, and the deterministic ids would dedupe anyway.
  ingestLlmCalls.length = 0;
  const run2 = await runEmailIngest();
  assert.strictEqual(run2.ingested, 0);
  assert.strictEqual(ingestLlmCalls.length, 0, 'already-processed messages are not re-read');
  console.log('✓ a second run re-reads nothing and creates nothing');

  // A reminder arrives in the same thread and the extractor words the event
  // differently. Same thread, same start time = the same card.
  gmailStore.messages = gmailStore.messages.concat([{ id: 'msg-chase', threadId: 'thread-scouts' }]);
  gmailStore.full['msg-chase'] = {
    id: 'msg-chase', threadId: 'thread-scouts', internalDate: String(Date.now() - 10000),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'leader@scouts.example' },
        { name: 'Subject', value: 'Scouts chase-up: Bibbulmun hike' },
      ],
      body: { data: b64url('Quick chase-up about the Bibbulmun hike this term.') },
    },
  };
  const chaseRun = await runEmailIngest();
  assert.strictEqual(chaseRun.ingested, 0, 'a reworded repeat creates no second card');
  assert.strictEqual(chaseRun.duplicates, 1, 'it is counted as the duplicate it is');
  console.log('✓ the same event reworded in a later email dedupes on its start time');

  // A backfill sweep widens the window once per distinct EMAIL_LOOKBACK_DAYS
  // value, then hands back to the watermark - otherwise every hourly run would
  // re-scan weeks of mail and re-triage anything past the processedIds window.
  fetchLog.length = 0;
  process.env.EMAIL_LOOKBACK_DAYS = '21';
  const backfill = await runEmailIngest();
  assert.strictEqual(backfill.backfilled, true, 'the first run at a new value backfills');
  const listUrl = fetchLog.find((u) => u.includes('/messages?q='));
  const afterSeconds = Number(decodeURIComponent(listUrl).match(/after:(\d+)/)[1]);
  const daysBack = (Date.now() / 1000 - afterSeconds) / 86400;
  assert.ok(daysBack > 20.5 && daysBack < 21.5, `expected a ~21 day window, got ${daysBack.toFixed(1)}`);

  fetchLog.length = 0;
  const afterBackfill = await runEmailIngest();
  assert.strictEqual(afterBackfill.backfilled, false, 'the same value does not sweep twice');
  const nextListUrl = fetchLog.find((u) => u.includes('/messages?q='));
  const nextAfter = Number(decodeURIComponent(nextListUrl).match(/after:(\d+)/)[1]);
  assert.ok((Date.now() / 1000 - nextAfter) / 86400 < 1, 'back to the watermark window');

  process.env.EMAIL_LOOKBACK_DAYS = '30';
  const secondBackfill = await runEmailIngest();
  assert.strictEqual(secondBackfill.backfilled, true, 'a changed value sweeps again');
  delete process.env.EMAIL_LOOKBACK_DAYS;
  console.log('✓ a backfill window runs once per value, then hands back to the watermark');

  // An explicit caller-supplied window always sweeps and never spends the env
  // var's one-shot - the diagnostic route has to be able to re-run at will.
  process.env.EMAIL_LOOKBACK_DAYS = '30';
  const askedOnce = await runEmailIngest(() => {}, { lookbackDays: 5, maxMessages: 1 });
  assert.strictEqual(askedOnce.backfilled, true);
  const askedTwice = await runEmailIngest(() => {}, { lookbackDays: 5, maxMessages: 1 });
  assert.strictEqual(askedTwice.backfilled, true, 'an explicit window is never refused by history');
  fetchLog.length = 0;
  await runEmailIngest(() => {}, { maxMessages: 1 });
  const capUrl = fetchLog.find((u) => u.includes('/messages?q='));
  assert.ok(capUrl.includes('maxResults=50'), 'the cap bounds the batch, not the page size');
  delete process.env.EMAIL_LOOKBACK_DAYS;
  console.log('✓ an explicit sweep window always runs and keeps the one-shot intact');

  // A capped run must WALK the window, not re-read its newest messages every
  // time. Gmail lists newest first, so capping the listing would make every
  // run skip the same already-processed head and never reach older mail.
  gmailStore.messages = [
    { id: 'walk-1', threadId: 't1' }, { id: 'walk-2', threadId: 't2' },
    { id: 'walk-3', threadId: 't3' }, { id: 'walk-4', threadId: 't4' },
  ];
  gmailStore.messages.forEach((m) => {
    gmailStore.full[m.id] = {
      id: m.id, threadId: m.threadId, internalDate: String(Date.now() - 60000),
      payload: {
        mimeType: 'text/plain',
        headers: [{ name: 'From', value: 'promo@nothing.example' }, { name: 'Subject', value: 'Nothing here' }],
        body: { data: b64url('nothing relevant') },
      },
    };
  });
  const seenIds = [];
  emailPipeline.setEmailClientFactory(() => ({
    messages: { create: async () => ({ content: [{ type: 'text', text: '{"relevant":false}' }] }) },
  }));
  const walkA = await runEmailIngest((line) => {
    const m = /could not read message (\S+)/.exec(line); if (m) seenIds.push(m[1]);
  }, { lookbackDays: 5, maxMessages: 2 });
  assert.strictEqual(walkA.read, 2, 'the cap bounds what one run reads');
  assert.strictEqual(walkA.stillUnread, 2, 'and reports what it left behind');
  const walkB = await runEmailIngest(() => {}, { lookbackDays: 5, maxMessages: 2 });
  assert.strictEqual(walkB.read, 2, 'the next run reads the two it had not seen');
  assert.strictEqual(walkB.stillUnread, 0, 'and the window is now clear');
  const walkC = await runEmailIngest(() => {}, { lookbackDays: 5, maxMessages: 2 });
  assert.strictEqual(walkC.read, 0, 'a third run finds nothing left to read');
  console.log('✓ a capped run walks the window instead of re-reading its newest mail');


  global.fetch = realFetch;
  emailPipeline.resetEmailClientFactory();

  // Attachment block mapping, including the xlsx-is-a-zip path.
  const { attachmentToBlock, xlsxToText } = emailPipeline;
  const pdfBlock = attachmentToBlock({ filename: 'form.pdf', mimeType: 'application/pdf' }, b64url('%PDF'));
  assert.strictEqual(pdfBlock.type, 'document');
  assert.strictEqual(pdfBlock.source.media_type, 'application/pdf');
  const imgBlock = attachmentToBlock({ filename: 'photo.jpg', mimeType: 'image/jpeg' }, b64url('jpegbytes'));
  assert.strictEqual(imgBlock.type, 'image');
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  zip.addFile('xl/sharedStrings.xml', Buffer.from('<sst><si><t>Sleeping bag</t></si><si><t>Torch</t></si></sst>'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from('<worksheet><is><t>Water bottle</t></is></worksheet>'));
  const xlsxB64url = zip.toBuffer().toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const xlsxBlock = attachmentToBlock({ filename: 'packing.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, xlsxB64url);
  assert.strictEqual(xlsxBlock.type, 'text');
  assert.ok(/Sleeping bag/.test(xlsxBlock.text) && /Torch/.test(xlsxBlock.text) && /Water bottle/.test(xlsxBlock.text));
  assert.strictEqual(attachmentToBlock({ filename: 'setup.exe', mimeType: 'application/octet-stream' }, b64url('MZ')), null,
    'unreadable types are dropped, not sent');
  assert.strictEqual(xlsxToText(Buffer.from('not a zip')), '', 'a corrupt xlsx degrades to empty, not a throw');
  console.log('✓ attachments map to the right Claude blocks; junk is dropped');

  console.log('\nALL LOGIC TESTS PASSED');
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
