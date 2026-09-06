// The one description of the school-lunch chore, shared by the full re-seed
// (seed-demo.mjs) and the in-place fix (set-lunch-days.mjs). It lives in its
// own file because seed-demo.mjs wipes the app the moment it is imported -
// importing the constants from there would run the wipe.
//
// A lunch is made the EVENING BEFORE the school day it is for, so the week
// sits one day earlier than the school week: Sunday evening makes Monday's,
// Thursday evening makes Friday's. Friday evening is off - there is no
// Saturday school day to pack for.
//
// Weekday numbers are the API's: 0=Sunday .. 6=Saturday.
export const LUNCH_TITLE = "Make tomorrow's school lunches";
export const LUNCH_DAYS = [0, 1, 2, 3, 4];

// Any chore already in the household that IS this one, whatever it is called
// today. The live chores were seeded as "Make school lunches"; matching on the
// word rather than the exact title means the rename lands on them too, and
// re-running after the rename is a no-op rather than a duplicate.
export const isLunchChore = (task) => /lunch/i.test(task.title || '');
