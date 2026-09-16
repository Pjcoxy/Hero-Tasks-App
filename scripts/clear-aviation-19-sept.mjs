// One-shot: clear the Perth Aviation Youth Club meeting from Saturday 19 Sept
// 2026 on the LIVE app. Toby is at the Manjedal camp that weekend, and the
// email import wrote the same meeting three times - once for Toby and twice for
// the whole family - with the title punctuated differently each time ("-" vs
// "–", "Lesson" vs "lesson"), which is exactly why nothing deduplicated them.
//
// Run from a GitHub Actions runner (the dev container's egress policy cannot
// reach azurewebsites.net).
//
// THE SAFETY RULE. A recurring item is never deleted: deleting one deletes the
// whole series, so every future aviation meeting would go with it. Anything
// repeating gets that single occurrence skipped instead, which is what
// skipOccurrence exists for. Only a genuine one-off is deleted. The script
// decides per item from what the app actually returns rather than from an
// assumption about what these three are.
//
// Idempotent: a second run finds nothing left on that date and says so.
const API = process.env.API_URL || 'https://herotasks-func-dev.azurewebsites.net/api/hero';
const PIN = process.env.PARENT_PIN || '1234';
const parent = { parentId: 'peter', parentPin: PIN };

const DATE = '2026-09-19';
const MATCH = /aviation/i;

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

const range = () => post({
  action: 'calendar', ...parent,
  start: '2026-09-12T00:00:00.000Z', end: '2026-10-31T00:00:00.000Z',
});

const before = await range();
const onTheDay = (before.items || []).filter((i) =>
  i.kind === 'event' && MATCH.test(i.title || '') && i.occurrenceDate === DATE);

if (!onTheDay.length) {
  console.log(`nothing matching /aviation/i on ${DATE} - nothing to do`);
  process.exit(0);
}

console.log(`found ${onTheDay.length} on ${DATE}:`);
for (const i of onTheDay) {
  console.log(`  id=${i.id}`);
  console.log(`    title:      ${JSON.stringify(i.title)}`);
  console.log(`    person:     ${i.personId || 'everyone'}`);
  console.log(`    source:     ${i.source}   recurrence: ${i.recurrence || 'none'}`);
  console.log(`    externalRef:${i.externalRef || 'none'}`);
}

// Same id can appear once per occurrence; act on each id once.
const seen = new Set();
let deleted = 0;
let skipped = 0;
for (const item of onTheDay) {
  if (seen.has(item.id)) continue;
  seen.add(item.id);
  if (item.recurrence === 'weekly') {
    await post({
      action: 'skipOccurrence', ...parent,
      planningItemId: item.id, occurrenceDate: DATE, skip: true,
    });
    skipped += 1;
    console.log(`\nskipped ${DATE} on the repeating "${item.title}" - the series is untouched`);
  } else {
    await post({ action: 'deletePlanningItem', ...parent, planningItemId: item.id });
    deleted += 1;
    console.log(`\ndeleted the one-off "${item.title}"`);
  }
}

const after = await range();
const left = (after.items || []).filter((i) =>
  i.kind === 'event' && MATCH.test(i.title || '') && i.occurrenceDate === DATE);
console.log(`\non ${DATE} now: ${left.length} aviation item(s)`);

const stillAround = (after.items || []).filter((i) => i.kind === 'event' && MATCH.test(i.title || ''));
console.log(`aviation meetings still on the calendar elsewhere: ${stillAround.length}`);
for (const i of stillAround) console.log(`  ${i.occurrenceDate} | ${i.title}`);

console.log(`\nthat Saturday now:`);
for (const i of (after.items || []).filter((x) => x.occurrenceDate === DATE)) {
  console.log(`  ${i.title} | ${i.kind} | ${i.personId || 'everyone'}`);
}
console.log(`\nDONE - ${deleted} deleted, ${skipped} occurrence(s) skipped`);
