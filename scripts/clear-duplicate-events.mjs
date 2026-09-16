// One-shot: tidy the duplicated calendar items the email import left on the
// LIVE app. Run from a GitHub Actions runner (the dev container's egress policy
// cannot reach azurewebsites.net).
//
// Two groups, two different rules, because they are two different problems:
//
//   AVIATION  The Perth Aviation Youth Club meeting is written three times at
//             the same minute - once for Toby, twice for everyone - with the
//             title punctuated differently each time ("-" vs "–", "Lesson" vs
//             "lesson"), which is why nothing deduplicated them. It happened on
//             19 Sept and again on 24 Oct, the date it was rescheduled to.
//             Two rules, because they are different situations:
//               19 Sept        - Toby is at the Manjedal camp, so ALL of them go.
//               any other date - the meeting IS happening, so it is cut down to
//                                one rather than removed.
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

// Keep the earliest of a group and remove the rest.
//
// Two rules that exist because of a bug this script had in the dry run. Several
// copies of one meeting share a start time to the minute - that is what makes
// them copies - so "earliest" alone does not pick a winner and the tie resolved
// arbitrarily. Worse, when a REPEATING series happened to land on the same
// minute it could win the tie and take all the one-offs with it, throwing away
// the copy that carried the real detail.
//
//   1. Ties break on id, so the choice is deterministic rather than incidental.
//   2. A group mixing a repeating series with one-offs is NOT deduplicated at
//      all. "The series and three one-offs at the same minute" is a genuinely
//      ambiguous situation, and a script that silently picks one is worse than
//      one that says so and leaves it for a human.
async function dedupe(group, label) {
  const repeating = group.filter((i) => i.recurrence === 'weekly');
  if (repeating.length && repeating.length !== group.length) {
    console.log(`\n  SKIPPED ${label}: ${repeating.length} repeating and ${group.length - repeating.length} one-off`
      + ' at the same time. Too ambiguous to pick a winner - left alone.');
    return;
  }
  const sorted = group.slice().sort((a, b) =>
    String(a.startAt).localeCompare(String(b.startAt)) || String(a.id).localeCompare(String(b.id)));
  const [keep, ...rest] = sorted;
  console.log(`\n  keeping the earliest ${label}: ${keep.startAt} ${JSON.stringify(keep.title)}`);
  for (const item of rest) {
    if (seen.has(item.id) || item.id === keep.id) continue;
    seen.add(item.id);
    done.push(await remove(item, item.occurrenceDate));
  }
}

// ---- aviation ----
const aviation = events.filter((i) => /aviation/i.test(i.title || ''));
console.log(`AVIATION — found ${aviation.length}:`);
aviation.forEach((i) => console.log(describe(i)));

// 19 Sept: Toby is at camp, so the whole day goes.
for (const item of aviation.filter((i) => i.occurrenceDate === '2026-09-19')) {
  if (seen.has(item.id)) continue;
  seen.add(item.id);
  done.push(await remove(item, '2026-09-19'));
}

// Every other date: the meeting is happening, so cut each date down to one.
const byDate = new Map();
for (const i of aviation.filter((x) => x.occurrenceDate !== '2026-09-19')) {
  if (!byDate.has(i.occurrenceDate)) byDate.set(i.occurrenceDate, []);
  byDate.get(i.occurrenceDate).push(i);
}
for (const [date, group] of byDate) {
  if (group.length > 1) await dedupe(group, `on ${date}`);
}

// ---- tennis: keep the earliest, remove the rest ----
const tennis = events.filter((i) => /tennis/i.test(i.title || ''));
console.log(`\nTENNIS make-up booking — found ${tennis.length}:`);
tennis.forEach((i) => console.log(describe(i)));
if (tennis.length > 1) await dedupe(tennis, 'tennis reminder');

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
