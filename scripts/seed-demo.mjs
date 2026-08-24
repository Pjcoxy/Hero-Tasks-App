// One-shot demo seed for the LIVE app, run from a GitHub Actions runner
// (the dev container's egress policy cannot reach azurewebsites.net).
//
// What it does, in order:
//   1. clearActivity     - wipes completions and redemptions (points to zero)
//   2. deletes every chore and every calendar item
//   3. seeds the real family schedule Pete described, exercising every
//      feature shipped this week: windows, weekday chores, prep lists with
//      points, the night-before deadline and the per-event override.
//
// Times are written in UTC but MEAN Perth (UTC+8): 17:30 Perth = 09:30Z.
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

// Next occurrence of a Perth weekday/time, at least `graceHours` away so we
// never seed an event whose prep deadline has already shut.
function nextPerth(weekday, hh, mm, graceHours = 12) {
  const now = Date.now();
  for (let d = 0; d < 15; d += 1) {
    const probe = new Date(now + d * 86400000);
    const perth = new Date(probe.getTime() + 8 * 3600000);
    if (perth.getUTCDay() !== weekday) continue;
    const at = Date.UTC(perth.getUTCFullYear(), perth.getUTCMonth(), perth.getUTCDate(), hh - 8, mm);
    if (at - now > graceHours * 3600000) return new Date(at);
  }
  throw new Error('no slot found');
}

// ---- 1. wipe ----
const cleared = await post({ action: 'clearActivity', ...parent });
console.log('cleared:', JSON.stringify(cleared.cleared));

const state = await post({ action: 'state' });
for (const task of state.tasks || []) {
  await post({ action: 'deleteTask', ...parent, taskId: task.id });
  console.log('deleted chore:', task.title);
}
const from = new Date(Date.now() - 400 * 86400000).toISOString();
const to = new Date(Date.now() + 400 * 86400000).toISOString();
const cal = await post({ action: 'calendar', ...parent, start: from, end: to });
const seen = new Set();
for (const item of cal.items || []) {
  if (item.kind === 'chore' || !item.id || seen.has(item.id)) continue;
  seen.add(item.id);
  await post({ action: 'deletePlanningItem', ...parent, planningItemId: item.id });
  console.log('deleted calendar item:', item.title);
}

// ---- 2. chores: school lunches, Mon-Fri, evening window ----
for (const kid of ['toby', 'ollie']) {
  await post({
    action: 'addTask', ...parent, kidId: kid,
    title: 'Make school lunches', points: 5,
    cycle: 'weekly', days: [1, 2, 3, 4, 5], windowId: 'evening',
  });
  console.log(`chore: Make school lunches (${kid}, Mon-Fri, evening)`);
}

// ---- 3. events with prep ----
// Soccer: Sunday 09:00 Perth, Ollie. Prep worth 10, due the NIGHT BEFORE
// (the default rule - nothing to override).
const soccer = nextPerth(0, 9, 0, 20);
await post({
  action: 'addPlanningItem', ...parent, type: 'event',
  title: 'Soccer', personId: 'ollie', startAt: soccer.toISOString(),
  prepLists: [{ personId: 'ollie', points: 10, items: [
    { text: 'Boots' }, { text: 'Shin pads' }, { text: 'Water bottle' },
    { text: 'Kit' }, { text: 'Club socks' },
  ] }],
});
console.log('event: Soccer', soccer.toISOString(), '(prep due the night before)');

// Cubs: Monday 17:30 Perth, whole family (Toby AND Ollie both go), a prep
// list each. "Uniform on" is same-evening prep, so prepDueBy overrides the
// night-before default to the event start itself.
// Scouts: Thursday 18:00-20:00 Perth, Toby only, same override.
// Calendar items do not recur yet, so seed the next two weeks of each.
for (let week = 0; week < 2; week += 1) {
  const cubs = new Date(nextPerth(1, 17, 30).getTime() + week * 7 * 86400000);
  await post({
    action: 'addPlanningItem', ...parent, type: 'event',
    title: 'Cubs', personId: null, startAt: cubs.toISOString(),
    prepDueBy: cubs.toISOString(),
    prepLists: [
      { personId: 'toby',  points: 3, items: [{ text: 'Cubs uniform on' }] },
      { personId: 'ollie', points: 3, items: [{ text: 'Cubs uniform on' }] },
    ],
  });
  console.log('event: Cubs', cubs.toISOString());

  const scouts = new Date(nextPerth(4, 18, 0).getTime() + week * 7 * 86400000);
  await post({
    action: 'addPlanningItem', ...parent, type: 'event',
    title: 'Scouts', personId: 'toby',
    startAt: scouts.toISOString(),
    endAt: new Date(scouts.getTime() + 2 * 3600000).toISOString(),
    // Pete's rule: uniform on by 5:30, half an hour before the 6pm start.
    prepDueBy: new Date(scouts.getTime() - 30 * 60000).toISOString(),
    prepLists: [{ personId: 'toby', points: 3, items: [{ text: 'Scouts uniform on' }] }],
  });
  console.log('event: Scouts', scouts.toISOString());
}

const finalState = await post({ action: 'state' });
console.log('\nfinal: tasks =', (finalState.tasks || []).length,
  '| balances =', JSON.stringify(Object.fromEntries(
    Object.entries(finalState.stats || {}).map(([k, v]) => [k, v.balance]))));
console.log('SEED COMPLETE');
