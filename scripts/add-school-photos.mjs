// One-shot: put Ollie's school photo days on the LIVE app, with the getting-
// ready prep split the way it actually happens - the work the night before, the
// quick tidy-up on the morning. Run from a GitHub Actions runner (the dev
// container's egress policy cannot reach azurewebsites.net).
//
// From the Kapture slip (Burrendah Primary School, Oliver Cox, Year 5 Room 11):
//
//   Photo days      Mon 26, Tue 27 & Wed 28 October 2026
//   Sibling orders  close MIDDAY Friday 23 October - BEFORE any photo is taken
//   Class/individual close Saturday 7 November; discounted only within 10
//                   calendar days of photo day, and a late order adds $30
//   Codes           Student ID 3448, School Code KQDV5E, kapture.com.au
//
// WHY ALL THREE DAYS. The slip lists three photo days for the school and does
// not say which one Room 11 is on. Neither of us knows, so the morning tidy-up
// runs on all three and Ollie is presentable whichever day it turns out to be.
// The heavy preparation happens ONCE, the Sunday night before, because washing
// a uniform three times is not preparation, it is nagging.
//
// Idempotent. Every item carries an externalRef derived from the school code,
// so the API refuses a second copy; the chores are matched on title first.
const API = process.env.API_URL || 'https://herotasks-func-dev.azurewebsites.net/api/hero';
const PIN = process.env.PARENT_PIN || '1234';
const parent = { parentId: 'peter', parentPin: PIN };
const REF = 'kapture-KQDV5E-3448';

// Perth is UTC+8.
const PHOTO_DAYS = [
  { label: 'Mon',  dueBy: '2026-10-26T00:30:00.000Z' }, // 08:30 Mon 26 Oct
  { label: 'Tue',  dueBy: '2026-10-27T00:30:00.000Z' }, // 08:30 Tue 27 Oct
  { label: 'Wed',  dueBy: '2026-10-28T00:30:00.000Z' }, // 08:30 Wed 28 Oct
];
const EVENT_START = '2026-10-26T00:30:00.000Z'; // 08:30 Mon 26 Oct
const EVENT_END   = '2026-10-28T07:00:00.000Z'; // 15:00 Wed 28 Oct

// The night before: the things that cannot be done in a rush at 8am.
const NIGHT_BEFORE = [
  'Shower',
  'Wash hair',
  'Clean school uniform out ready',
  'School shoes cleaned',
  'Fingernails cut and clean',
];

// The morning: sixty seconds of it, on each of the three possible days.
const MORNING = 'Photo day look: teeth, hair combed, face washed, collar straight';

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
  start: '2026-10-19T00:00:00.000Z', end: '2026-11-10T00:00:00.000Z',
});

const before = await range();
const has = (ref) => (before.items || []).some((i) => i.externalRef === ref);

// ---- 1. the photo days themselves, with the night-before prep ----
if (has(`${REF}:photo-days`)) {
  console.log('photo days: already there');
} else {
  const ev = await post({
    action: 'addPlanningItem', ...parent,
    type: 'event',
    title: 'School Photos — Burrendah',
    personId: 'ollie',
    startAt: EVENT_START,
    endAt: EVENT_END,
    allDay: true,
    externalRef: `${REF}:photo-days`,
    notes: [
      'Year 5, Room 11. The slip lists three photo days and does not say which is Room 11 — the morning tidy-up is set for all three.',
      'Ordering: kapture.com.au — Student ID 3448, School Code KQDV5E.',
      'These codes are not reissued if lost.',
      'Sibling photos close MIDDAY Fri 23 Oct — before any photo is taken.',
      'Class & individual close Sat 7 Nov. Discounted only within 10 days of photo day; a late order adds $30.',
    ].join('\n'),
    // Opens the Thursday before, so a weekend is available for the washing and
    // the shoes rather than one Sunday evening.
    prepOpensDaysBefore: 3,
    prepLists: [{ personId: 'ollie', points: 10, items: NIGHT_BEFORE.map((text) => ({ text })) }],
    adultActions: [
      { text: 'Order SIBLING photos before midday Fri 23 Oct (closes before photo day)' },
      { text: 'Order class & individual photos — discounted for 10 days after photo day, +$30 late' },
    ],
  });
  console.log(`photo days: created (prep ${ev.item.prepLists[0].items.length} items, ${ev.item.prepLists[0].points} pts)`);
}

// ---- 2. one light morning chore per possible day ----
const state = await post({ action: 'state' });
for (const day of PHOTO_DAYS) {
  const title = `${MORNING} (${day.label})`;
  if ((state.tasks || []).some((t) => t.title === title)) {
    console.log(`morning ${day.label}: already there`);
    continue;
  }
  await post({
    action: 'addTask', ...parent, kidId: 'ollie',
    title, points: 5,
    // A one-off carries its own dueBy and is exempt from the window rules -
    // which is what this needs, because it is due at 8:30 on one named morning
    // rather than inside the household's morning window every day.
    cycle: 'oneoff', dueBy: day.dueBy,
  });
  console.log(`morning ${day.label}: created, due ${day.dueBy}`);
}

// ---- 3. the deadline that lands BEFORE photo day ----
if (has(`${REF}:sibling-deadline`)) {
  console.log('sibling reminder: already there');
} else {
  await post({
    action: 'addPlanningItem', ...parent,
    type: 'reminder',
    title: 'Order sibling photos — closes midday tomorrow',
    personId: null,
    startAt: '2026-10-22T10:00:00.000Z', // 18:00 Thu 22 Oct Perth
    externalRef: `${REF}:sibling-deadline`,
    notes: 'Sibling orders close MIDDAY Friday 23 October — three days before the first photo is taken. kapture.com.au, School Code KQDV5E.',
  });
  console.log('sibling reminder: created for Thu 22 Oct 6pm');
}

// ---- what it looks like now ----
const after = await range();
console.log('\nphoto fortnight:');
// A one-off chore has no occurrenceDate - it carries occurrenceAt (its dueBy),
// so fall back to that rather than printing "undefined" next to real dates.
const when = (i) => i.occurrenceDate || String(i.occurrenceAt || i.startAt || '').slice(0, 10) || '?';
const rows = (after.items || []).slice()
  .sort((a, b) => String(a.occurrenceAt || a.startAt).localeCompare(String(b.occurrenceAt || b.startAt)));
for (const i of rows) {
  console.log(`  ${when(i)}  ${i.kind.padEnd(8)} ${i.title}  [${i.personId || i.kidId || 'everyone'}]`);
}
const ev = (after.items || []).find((i) => i.externalRef === `${REF}:photo-days`);
if (ev) {
  console.log(`\nnight-before prep opens ${ev.prepOpensDate}, due ${ev.prepDueDate} ${ev.prepDueTime}`);
}
console.log('DONE');
