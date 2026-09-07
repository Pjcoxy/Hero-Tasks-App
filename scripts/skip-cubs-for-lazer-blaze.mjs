// One-shot: take Cubs off Monday 14 September 2026 on the LIVE app, because
// that night IS the Lazer Blaze activity rather than a normal Cubs meeting.
// Run from a GitHub Actions runner (the dev container's egress policy cannot
// reach azurewebsites.net).
//
// This is a skip, not a delete: Cubs runs every other Monday exactly as it did.
// Deleting the item would take the whole series with it.
//
// Idempotent - skipping a night that is already skipped leaves it skipped.
const API = process.env.API_URL || 'https://herotasks-func-dev.azurewebsites.net/api/hero';
const PIN = process.env.PARENT_PIN || '1234';
const parent = { parentId: 'peter', parentPin: PIN };

// The Lazer Blaze night. Household-local date, which is what the calendar
// labels every occurrence with, so no timezone maths happens here.
const NIGHT = '2026-09-14';

const post = async (body) => {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json && json.ok === false) throw new Error(`${body.action}: ${json.error}`);
  return json;
};

const range = async (fromDays, toDays) => post({
  action: 'calendar', ...parent,
  start: new Date(Date.now() + fromDays * 86400000).toISOString(),
  end: new Date(Date.now() + toDays * 86400000).toISOString(),
});

const before = await range(-1, 60);
const cubs = (before.items || []).find((i) =>
  i.kind === 'event' && i.recurrence === 'weekly' && /cubs/i.test(i.title || ''));

if (!cubs) {
  console.log('no weekly Cubs event found - nothing to skip');
  process.exit(0);
}

const nights = (before.items || [])
  .filter((i) => i.id === cubs.id).map((i) => i.occurrenceDate).sort();
console.log(`Cubs ("${cubs.title}") currently runs on: ${nights.join(', ')}`);

if (!nights.includes(NIGHT)) {
  // Either already skipped, or the series does not land on that Monday at all.
  // Both are "nothing to do", but they are not the same thing, so say which.
  console.log(`${NIGHT} is not currently a Cubs night - already skipped, or the series does not fall on it. Nothing to do.`);
  process.exit(0);
}

await post({
  action: 'skipOccurrence', ...parent,
  planningItemId: cubs.id, occurrenceDate: NIGHT, skip: true,
});
console.log(`skipped Cubs on ${NIGHT}`);

const after = await range(-1, 60);
const left = (after.items || [])
  .filter((i) => i.id === cubs.id).map((i) => i.occurrenceDate).sort();
console.log(`Cubs now runs on: ${left.join(', ')}`);

const lazer = (after.items || []).filter((i) => /lazer/i.test(i.title || ''));
console.log(`\non ${NIGHT}:`);
for (const i of (after.items || []).filter((x) => x.occurrenceDate === NIGHT || String(x.startAt).startsWith(NIGHT))) {
  console.log(`  ${i.title} | ${i.startAt} | ${i.kind}`);
}
console.log(`\nLazer Blaze on the calendar: ${lazer.length} (0 until a parent approves the proposal)`);
console.log('DONE');
