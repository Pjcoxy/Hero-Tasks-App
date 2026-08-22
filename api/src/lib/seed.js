const { container } = require('./cosmos');

// v1 is a single-household MVP (docs/mvp-scope-v1.md) — no household creation UI yet,
// so this is the one fixed household everyone belongs to.
const HOUSEHOLD_ID = 'default';

const SEED_PEOPLE = [
  { id: 'peter', name: 'Peter', emoji: '🧔', pin: '1234', role: 'parent' },
  { id: 'tymanda', name: 'Tymanda', emoji: '👩', pin: '1234', role: 'parent' },
  { id: 'toby', name: 'Toby', emoji: 'svg:3d-printer', pin: '1234', role: 'kid' },
  { id: 'ollie', name: 'Ollie', emoji: 'svg:quokka', pin: '1234', role: 'kid' },
];

// One-time corrections to people who were seeded BEFORE a default changed.
//
// SEED_PEOPLE only applies when the household does not yet exist, so editing it
// does nothing for a household already in the database - which is every real
// one. #88 changed Toby and Ollie to custom SVG avatars and shipped green, but
// the live app kept showing the old emoji because only the seed had moved.
//
// Each entry is applied only when the person still holds the exact value they
// were originally seeded with. If a parent has since chosen something else,
// `from` will not match and their choice is left alone.
const AVATAR_MIGRATIONS = [
  { id: 'toby', from: '\u{1F996}', to: 'svg:3d-printer' },
  { id: 'ollie', from: '\u{1F98A}', to: 'svg:quokka' },
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

  const people = container('people');

  if (!household) {
    await households.items.create({ id: HOUSEHOLD_ID, name: 'Our Household' });
    for (const p of SEED_PEOPLE) {
      await people.items.create({ ...p, householdId: HOUSEHOLD_ID });
    }
  } else {
    await applyAvatarMigrations(people);
  }

  seeded = true;
}


// Only touches a person whose avatar is still the value they were seeded with,
// so a parent's own choice is never overwritten. Best-effort: a failure here
// must not stop the app serving, so each one is caught individually.
async function applyAvatarMigrations(people) {
  for (const m of AVATAR_MIGRATIONS) {
    try {
      const { resource: person } = await people
        .item(m.id, HOUSEHOLD_ID)
        .read()
        .catch(() => ({ resource: null }));

      if (person && person.emoji === m.from) {
        await people.item(m.id, HOUSEHOLD_ID).replace({ ...person, emoji: m.to });
      }
    } catch {
      // Leave the old avatar in place rather than failing the request.
    }
  }
}

module.exports = { ensureSeeded, HOUSEHOLD_ID };
