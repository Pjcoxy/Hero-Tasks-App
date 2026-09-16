// One-shot: put Toby's Manjedal Scout Camp on the LIVE app, with the leader's
// packing list as a prep list he can tick off. Run from a GitHub Actions runner
// (the dev container's egress policy cannot reach azurewebsites.net).
//
// Every fact below comes from the email and its two attachments
// (Arooj Shah, Scouts WA, 1 Sept 2026, "Manjedal Scout Camp 18-19 Sept 2026"):
//
//   - times, location and leader: the filled Y3 form's own fields
//   - the packing list: "Manjedal Camp Packing Check List (1).xlsx"
//
// On the dates. The SUBJECT line of the first email says "18-19 Sept" and is
// simply wrong. Everything else agrees: that email's body ("18-20 September"),
// the Y3's Activity Date field ("18 to 20 Sept 2026"), the Y3's finish date
// (20/09/2026, 10.00am), and the leader's later gate-code email - "Arrival:
// Friday 18th Sept from 5pm. Departure: Sunday 20th Sept 10am." The camp runs
// Friday evening to Sunday morning.
//
// The gate code and the LAIR/CASTLE detail come from that second email.
//
// Idempotent: externalRef is the Gmail thread plus the start minute, so a
// second run updates nothing and the API refuses it as a duplicate rather than
// writing a second camp.
const API = process.env.API_URL || 'https://herotasks-func-dev.azurewebsites.net/api/hero';
const PIN = process.env.PARENT_PIN || '1234';
const parent = { parentId: 'peter', parentPin: PIN };

// Perth is UTC+8. Y3: start 5.00pm Fri 18/09/2026, finish 10.00am Sun 20/09.
const START_AT = '2026-09-18T09:00:00.000Z'; // Fri 18 Sept, 5:00pm Perth
const END_AT   = '2026-09-20T02:00:00.000Z'; // Sun 20 Sept, 10:00am Perth
const THREAD_ID = '1a05a751d0e0624e';

// The leader's checklist, in her order. Column C of the spreadsheet is what
// goes in the bag; the "Food", "Tents" and "Medication" columns are notes
// about the camp rather than things to pack, so they are in notes below.
const PACKING = [
  // Camping kit
  'Sleeping bag (-5°C or 0°C comfort if possible)',
  'Small air mattress or camping foam mattress',
  'Small pillow or inflatable pillow',
  'Wool camp blanket',
  'Pyjamas',
  'Bowl, cup, knife, fork, spoon, dilly bag',
  // Day pack
  'Day pack (day-style backpack)',
  'Sunscreen',
  'Roll-on insect repellent',
  'Water bottle',
  'Torch and spare batteries',
  // Clothes
  'Scout uniform — arrive in uniform',
  'Rain coat or poncho',
  '2x T-shirts or long T-shirts',
  '2x shorts or long pants (day)',
  '1x long pants (night)',
  '3x pairs of underwear',
  '3x pairs of socks',
  '1x jacket or jumper',
  'Beanie',
  'Hat',
  'Sturdy shoes',
  // Toiletries
  '1x bath towel',
  'Thongs (for showering in)',
  'Soap',
  'Toothpaste',
  'Toothbrush',
  'Hairbrush (if required)',
  'Plastic bag for dirty or wet clothes',
];

const NOTES = [
  // First line on purpose: this is the one fact you need while sitting at a
  // locked gate at 5pm on Friday, and notes are shown from the top.
  'Gate code: 2907',
  'Manjedal Activity Centre, 163 Manjedal Rd, Karrakup WA 6122.',
  'Drop off Fri 5:00pm, pick up Sun 10:00am — both at Manjedal.',
  'Camping at the LAIR camp ground; the cabins are at the CASTLE area.',
  'Arrive in uniform. Have dinner at home before arriving Friday.',
  'Scouts supply the food and the tents (youths put the tents up themselves).',
  'Activities: mountain biking (no bike gear needed), hiking, camp cooking.',
  'Leader: Arooj “Stingray” Shah — 0466 465 404.',
  '$100, already paid.',
].join('\n');

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

// addPlanningItem returns the existing item on a duplicate but does not flag
// it, so look first - otherwise a second run prints "created" about something
// it did not create.
const EXTERNAL_REF = `gmail-${THREAD_ID}:${START_AT.slice(0, 16)}`;
const before = await post({
  action: 'calendar', ...parent,
  start: '2026-09-15T00:00:00.000Z', end: '2026-09-22T00:00:00.000Z',
});
const already = (before.items || []).find((i) => i.externalRef === EXTERNAL_REF);

const result = await post({
  action: 'addPlanningItem', ...parent,
  type: 'event',
  title: 'Scouts Camp — Manjedal',
  personId: 'toby',
  startAt: START_AT,
  endAt: END_AT,
  notes: NOTES,
  externalRef: EXTERNAL_REF,
  prepLists: [{ personId: 'toby', points: 20, items: PACKING.map((text) => ({ text })) }],
  // Only a parent can do this one, so it is an adult action rather than a line
  // on Toby's list.
  adultActions: [{ text: 'Medication (if any) in a ziplock bag labelled with Toby’s name, dosage included' }],
  // prepDueBy is deliberately left off: the default is the last window's close
  // the day before, which is Thursday 9pm - the night before they leave, not
  // the Friday afternoon he is still at school for.
  //
  // But the list must be tickable NOW. Prep normally opens on the day it is
  // due, and a 29-item camp pack is not a one-evening job - Toby starts filling
  // the bag days ahead. The lead counts back from the DEADLINE (Thursday), so
  // two days opens it Tuesday and leaves Thursday 9pm exactly where it was.
  prepOpensDaysBefore: 2,
});

console.log(already ? 'already there - nothing created' : 'created the camp');
console.log(JSON.stringify({
  id: result.item && result.item.id,
  title: result.item && result.item.title,
  personId: result.item && result.item.personId,
  startAt: result.item && result.item.startAt,
  endAt: result.item && result.item.endAt,
  prepItems: result.item && result.item.prepLists && result.item.prepLists[0]
    ? result.item.prepLists[0].items.length : 0,
  points: result.item && result.item.prepLists && result.item.prepLists[0]
    ? result.item.prepLists[0].points : 0,
}, null, 2));

if (result.conflicts && result.conflicts.length) {
  console.log('\nclashes with:');
  for (const c of result.conflicts) console.log(`  ${c.title} | ${c.startAt}`);
}

const cal = await post({
  action: 'calendar', ...parent,
  start: '2026-09-15T00:00:00.000Z', end: '2026-09-22T00:00:00.000Z',
});
console.log('\nthat week:');
for (const i of (cal.items || []).filter((x) => x.kind !== 'chore')) {
  console.log(`  ${i.title} | ${i.startAt} | ${i.personId || 'everyone'}`);
}
const camp = (cal.items || []).find((i) => i.externalRef === EXTERNAL_REF);
if (camp) {
  console.log(`\npacking opens: ${camp.prepOpensDate || '(none)'}`);
  console.log(`packing is due: ${camp.prepDueDate || '(none)'} ${camp.prepDueTime || ''}`);
}
console.log('DONE');
