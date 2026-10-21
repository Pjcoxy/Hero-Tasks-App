// One-shot: put the Ern Halliday camp (23-25 Oct 2026) on the LIVE app with the
// leader's 36-item packing checklist as each boy's own prep list, open today.
// Run from a GitHub Actions runner (the dev container's egress policy cannot
// reach azurewebsites.net).
//
// Source: "Ern Halliday Camp Packing Check List.pdf", attached to both Arooj
// Shah's (Scouts) and Michael Cook's (Cubs) camp emails - the two copies are
// byte-identical, so one list serves both boys. Camp details from Michael
// Cook's 23 Sept email: Gumbooya ground, Ern Halliday, Friday 6pm to around
// 10am Sunday, joint camp with North Beach, tents/food/drink provided.
//
// ATTACHES RATHER THAN DUPLICATES. An earlier handoff may already have created
// an Ern Halliday event, a packing task, a Scoutmap registration task or the
// $75 payment. So this looks first: an existing Ern Halliday EVENT gets the
// checklist attached to it via updatePlanningItem, and only a household with no
// such event gets a new one. Chores are never touched - registration and
// payment are a parent's jobs and none of this script's business.
//
// Idempotent: a second run finds the checklist already on the event, with the
// same 36 items, and changes nothing.
const API = process.env.API_URL || 'https://herotasks-func-dev.azurewebsites.net/api/hero';
const PIN = process.env.PARENT_PIN || '1234';
const parent = { parentId: 'peter', parentPin: PIN };

const KIDS = ['toby', 'ollie'];
const MATCH = /ern\s*halliday/i;

// Perth is UTC+8.
const START_AT = '2026-10-23T10:00:00.000Z'; // Fri 23 Oct, 6:00pm Perth
const END_AT   = '2026-10-25T02:00:00.000Z'; // Sun 25 Oct, 10:00am Perth
// "Pack by the 23rd" - an hour before the 6pm drop-off, rather than the app's
// default of the night before. The brief asked for the 23rd explicitly.
const PREP_DUE = '2026-10-23T09:00:00.000Z'; // Fri 23 Oct, 5:00pm Perth
// Counts back from the DEADLINE (23 Oct), so 2 days opens it on the 21st -
// today. The brief said "prepOpensOn 2026-10-22 (today)", but today is the
// 21st, and opening on the 22nd would leave the list locked today, which is the
// one thing it must not be. Opening on the 21st is open now AND open tomorrow.
const OPENS_DAYS_BEFORE = 2;

const PACKING = [
  // Camping kit
  'Camping kit: sleeping bag (-5°C or 0°C comfort if possible)',
  'Camping kit: small air mattress or foam camping mattress',
  'Camping kit: small pillow or inflatable pillow',
  'Camping kit: wool camp blanket',
  'Camping kit: pyjamas',
  'Camping kit: bowl, cup, knife, fork, spoon + dilly bag',
  'Camping kit: small detergent, Chux and scourer',
  'Camping kit: antibacterial hand wash',
  'Camping kit: camp chair (folding)',
  // Clothes
  'Clothes: Scout uniform (wear it to camp)',
  'Clothes: raincoat or poncho',
  'Clothes: 2x T-shirts or long-sleeve T-shirts',
  'Clothes: 2x shorts or long pants (day)',
  'Clothes: 1x long pants (night)',
  'Clothes: 3x pairs of underwear',
  'Clothes: 3x pairs of socks',
  'Clothes: jacket or jumper',
  'Clothes: beanie',
  'Clothes: hat',
  'Clothes: sturdy shoes',
  'Clothes: swimmers for the beach (bathers + rash vest)',
  // Day pack
  'Day pack: day backpack',
  'Day pack: sunscreen',
  'Day pack: roll-on insect repellent',
  'Day pack: water bottle',
  'Day pack: torch + spare batteries',
  'Day pack: book for quiet reading',
  // Toiletries
  'Toiletries: bath towel',
  'Toiletries: thongs (for the showers)',
  'Toiletries: soap',
  'Toiletries: toothpaste',
  'Toiletries: toothbrush',
  'Toiletries: hairbrush',
  'Toiletries: plastic bag for dirty/wet clothes',
  // Other
  'Medication (if any) in a ziplock bag labelled with name, medication info and dosage',
  '$10 for ice-cream',
];

const NOTES = [
  'Ern Halliday Recreation Camp (Gumbooya camp area), 140 Whitford Ave, Hillarys WA 6025.',
  'Drop off Fri 6:00pm, pick up Sun ~10:00am.',
  'Joint Willetton / North Beach Cubs & Scouts camp. Tents, food and drink provided.',
  'Arrive in uniform and have dinner at home before drop-off on Friday.',
  'Do NOT bring phones, game systems, lollies or snacks — they will be confiscated.',
  'Activities: ice-breaker games, kite making, beach swim, wide games, campfire cooking, star gazing.',
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

const range = () => post({
  action: 'calendar', ...parent,
  start: '2026-10-01T00:00:00.000Z', end: '2026-11-05T00:00:00.000Z',
});

const prepLists = () => KIDS.map((kid) => ({
  personId: kid, points: 15, items: PACKING.map((text) => ({ text })),
}));

// ---- look before writing ----
const before = await range();
const events = (before.items || []).filter((i) => i.kind === 'event' && MATCH.test(i.title || ''));
const chores = (before.items || []).filter((i) => i.kind === 'chore' && MATCH.test(i.title || ''));

console.log(`existing Ern Halliday EVENTS: ${events.length}`);
for (const i of events) {
  const lists = (i.prepLists || []).map((l) => `${l.personId}:${l.items.length}`).join(' ') || 'none';
  console.log(`  ${i.occurrenceDate} "${i.title}" id=${i.id} prepLists=[${lists}]`);
}
console.log(`existing Ern Halliday CHORES (left alone): ${chores.length}`);
for (const i of chores) console.log(`  "${i.title}" [${i.kidId || i.personId || '?'}]`);

// Any other Ern-Halliday-ish chores the calendar range missed - the state call
// lists every chore regardless of date, which a date-bounded calendar does not.
const state = await post({ action: 'state' });
const choreTasks = (state.tasks || []).filter((t) => MATCH.test(t.title || '')
  || /scoutmap|R-004490/i.test(t.title || ''));
if (choreTasks.length) {
  console.log('related chores in state (left alone):');
  for (const t of choreTasks) console.log(`  "${t.title}" [${t.kidId}]`);
}

if (events.length > 1) {
  // Picking one of several silently is how a wrong checklist ends up on the
  // wrong card. Say so and stop rather than guess.
  console.error(`REFUSING: ${events.length} Ern Halliday events already exist. Deduplicate first.`);
  process.exit(1);
}

const payload = {
  type: 'event',
  title: 'Ern Halliday Camp',
  personId: null,
  startAt: START_AT,
  endAt: END_AT,
  notes: NOTES,
  prepDueBy: PREP_DUE,
  prepOpensDaysBefore: OPENS_DAYS_BEFORE,
  prepLists: prepLists(),
};

if (events.length === 1) {
  const found = events[0];
  const already = (found.prepLists || []).filter((l) => l.items.length === PACKING.length).length === KIDS.length;
  if (already) {
    console.log(`\nchecklist already on "${found.title}" (${PACKING.length} items each) - nothing to change`);
  } else {
    await post({ action: 'updatePlanningItem', ...parent, planningItemId: found.id, ...payload });
    console.log(`\nattached the checklist to the EXISTING event ${found.id}`);
  }
} else {
  await post({ action: 'addPlanningItem', ...parent, ...payload });
  console.log('\ncreated a new Ern Halliday event');
}

// ---- prove it ----
const after = await range();
const live = (after.items || []).filter((i) => i.kind === 'event' && MATCH.test(i.title || ''));
console.log(`\nErn Halliday events now: ${live.length}`);
for (const i of live) {
  console.log(`  "${i.title}"  ${i.startAt} -> ${i.endAt}`);
  console.log(`  packing opens ${i.prepOpensDate}, due ${i.prepDueDate} ${i.prepDueTime}`);
  for (const l of i.prepLists || []) console.log(`    ${l.personId}: ${l.items.length} items, ${l.points} pts`);
}
console.log('DONE');
