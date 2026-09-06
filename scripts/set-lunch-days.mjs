// Moves the school-lunch chore on the LIVE app to Sunday-Thursday evening, in
// place. Run from a GitHub Actions runner (the dev container's egress policy
// cannot reach azurewebsites.net).
//
// Why this exists at all: editing scripts/seed-demo.mjs only changes households
// created AFTERWARDS, and the real one already exists - the same trap that made
// #88's avatars ship green and change nothing. Re-seeding would fix the days but
// wipe every point the kids have earned, which is not an acceptable price for a
// schedule tweak. So this updates the chores that are already there and touches
// nothing else.
//
// Idempotent: a chore already on the right title and days is skipped, so running
// it twice is safe.
import { LUNCH_TITLE, LUNCH_DAYS, isLunchChore } from './lunch-chore.mjs';

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

const sameDays = (a, b) =>
  Array.isArray(a) && a.length === b.length && [...a].sort().every((d, i) => d === [...b].sort()[i]);

const state = await post({ action: 'state' });
const lunches = (state.tasks || []).filter(isLunchChore);

if (!lunches.length) {
  console.log('no school-lunch chore found - nothing to do');
}

let changed = 0;
for (const task of lunches) {
  if (task.title === LUNCH_TITLE && task.cycle === 'weekly' && sameDays(task.days, LUNCH_DAYS)) {
    console.log(`already right: ${task.title} (${task.kidId})`);
    continue;
  }
  // cycle goes with days on purpose: the API clears `days` on any chore whose
  // cycle is not weekly, so sending the days without the cycle would silently
  // do nothing to a chore someone had switched to Every day.
  await post({
    action: 'updateTask', ...parent, taskId: task.id,
    title: LUNCH_TITLE, cycle: 'weekly', days: LUNCH_DAYS,
  });
  changed += 1;
  console.log(`updated: ${task.kidId} -> ${LUNCH_TITLE}, Sun-Thu`);
}

const after = await post({ action: 'state' });
for (const task of (after.tasks || []).filter(isLunchChore)) {
  console.log(`now: ${task.kidId} | ${task.title} | days=${JSON.stringify(task.days)} | ${task.cycle}`);
}
console.log(`DONE - ${changed} chore(s) changed`);
