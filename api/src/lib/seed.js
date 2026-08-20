const { container } = require('./cosmos');

// v1 is a single-household MVP (docs/mvp-scope-v1.md) — no household creation UI yet,
// so this is the one fixed household everyone belongs to.
const HOUSEHOLD_ID = 'default';

const SEED_PEOPLE = [
  { id: 'peter', name: 'Peter', emoji: '🧔', pin: '1234', role: 'parent' },
  { id: 'tymanda', name: 'Tymanda', emoji: '👩', pin: '1234', role: 'parent' },
  { id: 'toby', name: 'Toby', emoji: '🦖', pin: '1234', role: 'kid' },
  { id: 'ollie', name: 'Ollie', emoji: '🦊', pin: '1234', role: 'kid' },
];

let seeded = false;

// Runs once per warm Function instance (the `seeded` flag), and is itself idempotent
// against Cosmos DB even across cold starts (checks for the household doc first).
async function ensureSeeded() {
  if (seeded) return;

  const households = container('households');
  const { resource: household } = await households
    .item(HOUSEHOLD_ID, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));

  if (!household) {
    await households.items.create({ id: HOUSEHOLD_ID, name: 'Our Household' });
    const people = container('people');
    for (const p of SEED_PEOPLE) {
      await people.items.create({ ...p, householdId: HOUSEHOLD_ID });
    }
  }

  seeded = true;
}

module.exports = { ensureSeeded, HOUSEHOLD_ID };
