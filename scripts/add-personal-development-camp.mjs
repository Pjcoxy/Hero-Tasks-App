// One-shot: put the Personal Development Course (9-11 Oct 2026) on the LIVE app
// for Toby and Ollie, with each boy's own food choices and his own packing list.
// Run from a GitHub Actions runner (the dev container's egress policy cannot
// reach azurewebsites.net).
//
// Sources, all from Gmail:
//   - Michael Cook, 3 Aug: the nomination. "Date of course: 9-11 October 2026",
//     invitation-only, Scoutmap event R-004168 (PD2, ages 10-13). Toby Cox and
//     Ollie Cox both listed "Definitely" for PD2.
//   - Michael Cook, 5 Aug: "PD Course 2 ... older cohort of cubs and younger
//     cohort from Scouts, so it is no issue Toby will attend as a Scout."
//   - Scoutmap, 4 Aug: two registration confirmations, one per boy.
//   - Michael Cook, 1 Sept: neither he nor Carol Gwilym can attend; Willetton
//     parent helpers are wanted, registered via Scoutmap.
//   - Georgina Goddard (Mandurah Scout Group), 26 Sept: the food options and the
//     packing list, "please circle options and send back to me asap".
//
// TWO events on purpose, because these are two deadlines, not one:
//   1. the food choices, wanted back "asap" - so they open now and are due
//      days before the camp;
//   2. the camp itself, whose packing is due the night before.
// One event cannot carry both: a kid gets ONE prep list per event, so folding
// them together would make choosing a toastie and packing a sleeping bag the
// same task with the same deadline.
//
// Idempotent: each item carries an externalRef, so a second run creates nothing.
const API = process.env.API_URL || 'https://herotasks-func-dev.azurewebsites.net/api/hero';
const PIN = process.env.PARENT_PIN || '1234';
const parent = { parentId: 'peter', parentPin: PIN };
const REF = 'scoutswa-PD2-R004168';

const KIDS = ['toby', 'ollie'];

// Perth is UTC+8. The emails give the dates but never a time, so the camp is
// all-day rather than inventing a 6pm that nobody wrote down. The menu runs
// Friday night to Sunday breakfast, which is the only timing anyone stated.
const CAMP_START = '2026-10-09T10:00:00.000Z'; // Fri 9 Oct, evening Perth
const CAMP_END   = '2026-10-11T02:00:00.000Z'; // Sun 11 Oct, morning Perth

// Ticking a line IS the choice - the sheet says "circle options". Quantities
// are a tick too ("2" ticked, otherwise 1), because a checkbox cannot hold a
// number and a separate note would get lost.
const FOOD_CHOICES = [
  'Sat breakfast — toastie: ham',
  'Sat breakfast — toastie: cheese',
  'Sat breakfast — toastie: salami',
  'Sat breakfast — toastie: tomato',
  'Sat breakfast — I want 2 toasties (leave unticked for 1)',
  'Lunch — wrap',
  'Lunch — sandwich',
  'Lunch filling: cheese',
  'Lunch filling: tomato',
  'Lunch filling: ham',
  'Lunch filling: salami',
  'Lunch filling: cucumber',
  'Lunch filling: lettuce',
  'Lunch — I want 2 (leave unticked for 1)',
  'Sat morning tea: mandarin',
  'Sat morning tea: red apple',
  'Sat morning tea: green apple',
  'Sat morning tea: choc chip muffin',
  'Sat morning tea: plain muffin',
  'Sat dinner — burger: lettuce',
  'Sat dinner — burger: cucumber',
  'Sat dinner — burger: tomato',
  'Sat dinner — burger: cheese',
  'Sat dinner — I want 2 burgers (leave unticked for 1)',
  'Supper: hot chocolate',
  'Supper: Milo',
  'Sun breakfast: Weet-Bix',
  'Sun breakfast: Corn Flakes',
  'Sun breakfast: Rice Bubbles',
];

// Georgina's list, in her order and her words.
const PACKING = [
  'Wear full uniform to camp',
  'Sleeping mat (self-inflating only)',
  'Sleeping bag (-5 degree)',
  'Pillow',
  'Blanket',
  'Camp blanket',
  'Medication (if more than 1, in a Webster pack)',
  'Toiletries',
  'Towel',
  'Activity shirt',
  'Extra pair of shoes',
  'Crocs for showers (no thongs)',
  'Oodie or similar for warmth at night',
  'Jumper x2',
  'Warm socks x6',
  'Change of clothes x2',
  'Pyjamas x2',
  'Underwear x4',
  'Dilly bag — plate, bowl, cup, cutlery',
  'Day bag',
  'Hat',
  'Drink bottle',
  'Sunscreen (no aerosols)',
  'Mosquito spray (no aerosols)',
  'Tissues',
  'Small first aid kit',
  'Rain jacket',
  'Wet weather pants',
  'Torch / head lamp & spare batteries',
  'Beanie',
  'Optional: neck warmer',
  'Optional: gloves',
  'Optional: thermal wear',
  'Optional: extra wet weather gear',
];

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
  start: '2026-09-25T00:00:00.000Z', end: '2026-10-14T00:00:00.000Z',
});

const before = await range();
const has = (ref) => (before.items || []).some((i) => i.externalRef === ref);
const listFor = (items, points) => KIDS.map((kid) => ({
  personId: kid, points, items: items.map((text) => ({ text })),
}));

// ---- 1. the food choices, wanted back asap ----
if (has(`${REF}:food`)) {
  console.log('food choices: already there');
} else {
  const food = await post({
    action: 'addPlanningItem', ...parent,
    type: 'event',
    title: 'Camp food choices — pick yours',
    personId: null,
    startAt: '2026-09-28T01:00:00.000Z', // Mon 28 Sept, 9am Perth
    allDay: true,
    externalRef: `${REF}:food`,
    notes: [
      'Personal Development Course, 9-11 Oct. Georgina needs everyone’s choices back ASAP.',
      'Tick what you want. Ticking is choosing — it is not a job to do.',
      'Already fixed, nothing to pick: Friday sausage sizzle, Friday supper biscuits,',
      'Saturday afternoon tea popcorn & muesli bar, Saturday supper biscuits.',
    ].join('\n'),
    // Opens today rather than on its due day: they can pick whenever, and
    // Georgina asked for these back asap.
    prepOpensDaysBefore: 2,
    prepLists: listFor(FOOD_CHOICES, 5),
    adultActions: [
      { text: 'Send both boys’ food choices back to Georgina Goddard (0478 257 489)' },
    ],
  });
  console.log(`food choices: created, ${food.item.prepLists[0].items.length} options each`);
}

// ---- 2. the camp itself ----
if (has(`${REF}:camp`)) {
  console.log('camp: already there');
} else {
  const camp = await post({
    action: 'addPlanningItem', ...parent,
    type: 'event',
    title: 'Personal Development Course',
    personId: null,
    startAt: CAMP_START,
    endAt: CAMP_END,
    allDay: true,
    externalRef: `${REF}:camp`,
    notes: [
      'Personal Development Course 2 (ages 10-13). Fri 9 - Sun 11 Oct 2026.',
      'Invitation only — Toby and Ollie were both nominated by the Willetton leaders.',
      'Counts towards the Peak Award (Grey Wolf).',
      'Both already registered on Scoutmap (event R-004168). Paid to Mandurah Scout Group.',
      'Organiser: Georgina Goddard, Mandurah Scout Group — 0478 257 489.',
      'Wear full uniform to camp. Willetton provides nothing — pack the list.',
      'No start or finish time was given in any email. The food runs Friday night',
      'to Sunday breakfast, so it is a Friday-evening arrival — worth confirming.',
      'Location is not stated either; the packing list file is named "camp list',
      'mandajel", so most likely Manjedal. Worth confirming.',
      'Neither Michael Cook nor Carol Gwilym can attend — Willetton parent helpers',
      'are wanted, registered via Scoutmap.',
    ].join('\n'),
    // Opens the Monday of that week, so packing is not a Thursday-night scramble.
    prepOpensDaysBefore: 3,
    prepLists: listFor(PACKING, 15),
    adultActions: [
      { text: 'Confirm start/finish times and the venue with Georgina or Michael' },
      { text: 'Consider registering as a parent helper via Scoutmap (R-004168)' },
    ],
  });
  console.log(`camp: created, ${camp.item.prepLists[0].items.length} packing items each`);
}

const after = await range();
console.log('\nnow on the calendar:');
for (const i of (after.items || []).filter((x) => String(x.externalRef || '').startsWith(REF))) {
  console.log(`  ${i.occurrenceDate}  ${i.title}`);
  console.log(`      opens ${i.prepOpensDate}, due ${i.prepDueDate} ${i.prepDueTime}`);
  for (const l of i.prepLists || []) console.log(`      ${l.personId}: ${l.items.length} items, ${l.points} pts`);
}
console.log('DONE');
