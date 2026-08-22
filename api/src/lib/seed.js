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

// The reward shop shipped with no rewards at all, so renderRewardShop() always
// took its empty branch and every kid saw "Ask your grown-up to add some!"
// permanently - including the "N more points to go" progress text, which has
// therefore never been seen by anyone.
//
// Costs are pitched against 5 points per chore and roughly track what each one
// costs a parent. The soccer player is deliberately the CHEAPEST: it is an ~80c
// in-game purchase and the one that actually motivates Ollie, so it is the
// first-win reward - the thing that proves the system pays out before a kid
// loses interest. Do not make it aspirational. "Pick dinner" is dearest despite
// costing nothing, because it has real social value and no natural price.
const SEED_REWARDS = [
  { title: 'A player for your soccer game', cost: 15 },
  { title: "Ice cream from McDonald's", cost: 25 },
  { title: 'Ice cream from the Italian place', cost: 50 },
  { title: 'Pick dinner one night this week — from 3 options Mum and Dad give you', cost: 80 },
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

  // Runs for BOTH branches on purpose. Adding to a seed list only affects
  // households created afterwards, and every real one already exists - that is
  // exactly how #88's avatars shipped green and changed nothing.
  await topUpRewards();

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


// Adds any seeded reward that is not already there, matched on title. Existing
// rewards are never touched, so a cost a parent has edited stays edited; and a
// reward they deliberately deleted is NOT resurrected, because delete is a soft
// delete (active: false) and the title still matches.
//
// Best-effort: the app must still serve if this fails.
async function topUpRewards() {
  try {
    const rewards = container('rewards');
    const { resources: existing } = await rewards.items
      .query({
        query: 'SELECT * FROM c WHERE c.householdId = @h',
        parameters: [{ name: '@h', value: HOUSEHOLD_ID }],
      })
      .fetchAll();

    const seen = new Set((existing || []).map((r) => r.title));

    for (const r of SEED_REWARDS) {
      if (seen.has(r.title)) continue;
      await rewards.items.create({
        id: `seed-reward-${r.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`,
        householdId: HOUSEHOLD_ID,
        type: 'reward',
        title: r.title,
        cost: r.cost,
        needsApproval: true,
        active: true,
        createdAt: new Date().toISOString(),
      });
    }
  } catch {
    // Leave the shop as it is rather than failing the request.
  }
}

module.exports = { ensureSeeded, HOUSEHOLD_ID };
