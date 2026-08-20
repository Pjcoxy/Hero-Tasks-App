// Standalone logic test — mocks Cosmos DB in-memory so the actual business logic in
// hero.js runs for real (seed, add/complete/approve a chore, check points+streak),
// without needing a live Cosmos DB or Azure Functions host. Not part of the deployed app.
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

const assert = require('assert');
const { ensureSeeded, HOUSEHOLD_ID } = require('./src/lib/seed.js');

async function main() {
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
  const { getState, calcStreak } = require('./src/functions/hero.js');

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
  assert.strictEqual(state.tasks.length, 1);
  assert.strictEqual(state.stats.toby.points, 0, 'pending completion should not award points yet');
  console.log('✓ pending completion correctly awards 0 points');

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

  console.log('\nALL LOGIC TESTS PASSED');
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
