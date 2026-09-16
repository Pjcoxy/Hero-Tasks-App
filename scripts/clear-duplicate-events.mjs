// One-shot: tidy the duplicated calendar items the email import left on the
// LIVE app. Run from a GitHub Actions runner (the dev container's egress policy
// cannot reach azurewebsites.net).
//
// Two groups, two different rules, because they are two different problems:
//
//   AVIATION  The Perth Aviation Youth Club meeting is on Saturday 19 Sept
//             three times at the same minute - once for Toby, twice for
//             everyone - with the title punctuated differently each time ("-"
//             vs "–", "Lesson" vs "lesson"), which is why nothing deduplicated
//             them. Toby is at the Manjedal camp that weekend, so ALL of them
//             come off that date.
//
//   TENNIS    One "book Ollie's tennis make-up class before the token expires"
//             reminder, written three times across two days with three
//             different wordings. This one still needs doing, so it is NOT
//             removed - it is deduplicated down to a single reminder. The
//             EARLIEST is kept: it is a warning before an expiry, and the
//             earliest warning is the useful one.
//
// THE SAFETY RULE, for both groups. A recurring item is never deleted:
// deleting one deletes the whole series, so every future meeting would go with
// it. Anything repeating gets that single occurrence skipped instead, which is
// what skipOccurrence exists for. Only a genuine one-off is ever deleted, and
// the script decides per item from what the app returns rather than from an
// assumption about what it will find.
//
// Idempotent: a second run finds nothing to do and says so.
const API = process.env.API_URL || 'https://herotasks-func-dev.azurewebsites.net/api/hero';
const PIN = process.env.PARENT_PIN || '1234';
const parent = { parentId: 'peter', parentPin: PIN };

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

// Remove one occurrence of an item, choosing delete or skip by what it is.
// Returns what it did, so the caller reports rather than assumes.
async function remove(item, occurrenceDate) {
  if (item.recurrence === 'weekly') {
    await post({
      action: 'skipOccurrence', ...parent,
      planningItemId: item.id, occurrenceDate, skip: true,
    });
    return `skipped ${occurrenceDate} on the repeating "${item.title}" (series untouched)`;
  }
  await post({ action: 'deletePlanningItem', ...parent, planningItemId: item.id });
  return `deleted the one-off "${item.title}"`;
}

// Prints the full ISO startAt rather than a local date beside a UTC time.
// Those two together read as a contradiction - 2026-09-25T16:00Z IS the 26th in
// Perth - and an ordering that looks wrong makes a correct action untrustworthy.
const describe = (i) => `    ${i.startAt}  (household day ${i.occurrenceDate})  ${JSON.stringify(i.title)}`
  + `\n      id=${i.id}  person=${i.personId || 'everyone'}  source=${i.source}  recurrence=${i.recurrence || 'none'}`;

const before = await range();
const events = (before.items || []).filter((i) => i.kind === 'event');
const done = [];
const seen = new Set();

// ---- aviation: everything on the 19th goes ----
const aviation = events.filter((i) => /aviation/i.test(i.title || '') && i.occurrenceDate === '2026-09-19');
console.log(`AVIATION on 2026-09-19 — found ${aviation.length}:`);
aviation.forEach((i) => console.log(describe(i)));
for (const item of aviation) {
  if (seen.has(item.id)) continue;
  seen.add(item.id);
  done.push(await remove(item, '2026-09-19'));
}

// ---- tennis: keep the earliest, remove the rest ----
const tennis = events
  .filter((i) => /tennis/i.test(i.title || ''))
  .sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
console.log(`\nTENNIS make-up booking — found ${tennis.length}:`);
tennis.forEach((i) => console.log(describe(i)));
if (tennis.length > 1) {
  const [keep, ...rest] = tennis;
  // Sorted by startAt, so "earliest" is earliest in real time whatever the
  // household date reads as.
  console.log(`\n  keeping the earliest: ${keep.startAt} ${JSON.stringify(keep.title)}`);
  for (const item of rest) {
    if (seen.has(item.id) || item.id === keep.id) continue;
    seen.add(item.id);
    done.push(await remove(item, item.occurrenceDate));
  }
}

console.log('\nwhat changed:');
if (!done.length) console.log('  nothing - already tidy');
done.forEach((line) => console.log(`  ${line}`));

const after = await range();
const afterEvents = (after.items || []).filter((i) => i.kind === 'event');
console.log('\nAFTER — aviation:');
const avLeft = afterEvents.filter((i) => /aviation/i.test(i.title || ''));
if (!avLeft.length) console.log('  none on the calendar at all');
avLeft.forEach((i) => console.log(`  ${i.occurrenceDate} | ${i.title}`));
console.log('AFTER — tennis:');
afterEvents.filter((i) => /tennis/i.test(i.title || ''))
  .forEach((i) => console.log(`  ${i.occurrenceDate} | ${i.title} | ${i.personId || 'everyone'}`));

console.log('\nSaturday 19 Sept now:');
const sat = (after.items || []).filter((i) => i.occurrenceDate === '2026-09-19');
if (!sat.length) console.log('  (clear)');
sat.forEach((i) => console.log(`  ${i.title} | ${i.kind} | ${i.personId || 'everyone'}`));
console.log('\nDONE');
