const { app } = require('@azure/functions');
const { randomUUID } = require('crypto');
const { container } = require('../lib/cosmos');
const { ensureSeeded, HOUSEHOLD_ID } = require('../lib/seed');
const { sendPush } = require('../lib/push');
const { extractVoiceIntent } = require('../lib/llm');
const { findConflicts, suggestAlternateSlots } = require('../lib/calendar');

// Everything this app calls "today", or "9pm", means the family's local day -
// not UTC. Perth runs UTC+8, and with no conversion at all the two collide
// badly: a chore ticked at 7am was stamped with yesterday's date, and quiet
// hours set for the evening landed in the middle of the school day. The
// frontend was already using browser-local dates, so for the eight hours
// either side of UTC midnight the two ends of the app disagreed about what
// day it was and a just-completed chore rendered as still outstanding.
//
// Intl does the conversion, DST included, with no dependency and no
// hand-rolled offset arithmetic to drift. 'en-CA' is here because it formats
// as YYYY-MM-DD, which is the shape every date in this codebase already uses.
const HOUSEHOLD_TZ = process.env.HOUSEHOLD_TIMEZONE || 'Australia/Perth';

const LOCAL_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: HOUSEHOLD_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const LOCAL_TIME_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: HOUSEHOLD_TZ,
  hour: '2-digit',
  minute: '2-digit',
  // h23 rather than hour12:false - the latter renders midnight as 24 on some
  // ICU builds, which would put it a whole day out of range.
  hourCycle: 'h23',
});

function todayStr(now = new Date()) {
  return LOCAL_DATE_FORMAT.format(now);
}

// Minutes since local midnight, for comparing against an HH:MM setting.
function localMinutes(now = new Date()) {
  const parts = LOCAL_TIME_FORMAT.formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour').value);
  const minute = Number(parts.find((part) => part.type === 'minute').value);
  return (hour * 60) + minute;
}

const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DUE_REMINDER_SCHEDULE = '0 */15 * * * *';
const VOICE_INTENT_CONFIRMATION_THRESHOLD = 0.6;

function hhmmToMinutes(value) {
  const [h, m] = String(value).split(':');
  return (Number(h) * 60) + Number(m);
}

function isInQuietHours(quietHours, now = new Date()) {
  if (!quietHours || !HHMM_RE.test(quietHours.start || '') || !HHMM_RE.test(quietHours.end || '')) {
    return false;
  }
  const start = hhmmToMinutes(quietHours.start);
  const end = hhmmToMinutes(quietHours.end);
  const nowMinutes = localMinutes(now);
  if (start === end) return true;
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  return nowMinutes >= start || nowMinutes < end;
}

// Windows are when a chore is due. A recurring chore carries no time of its
// own - "daily" says how often, never by when - so before this there was
// nothing for a deadline to be measured against and nothing could be late.
//
// Three named windows for the whole household rather than a clock per chore:
// three choices to set up instead of one per task, and a nudge can say "before
// bed" rather than "at 18:00". Defaults live here rather than on the household
// record on purpose - ensureSeeded() only writes when the household is absent,
// so seeding them would do nothing for a household created weeks ago. A
// household may override them; when it has not, these apply immediately.
const DEFAULT_WINDOWS = Object.freeze([
  Object.freeze({ id: 'morning',     label: 'Morning',      closesAt: '08:30' }),
  Object.freeze({ id: 'afterschool', label: 'After school', closesAt: '18:00' }),
  Object.freeze({ id: 'evening',     label: 'Evening',      closesAt: '21:00' }),
]);

// What a chore with no window set means. Existing chores predate the concept,
// and an undated chore has always been understood as "some time today", so the
// last window of the day is the honest reading rather than exempting it.
const FALLBACK_WINDOW_ID = 'evening';

async function getHouseholdWindows() {
  const { resource: household } = await container('households')
    .item(HOUSEHOLD_ID, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  const custom = household && Array.isArray(household.windows) ? household.windows : null;
  return custom && custom.length ? custom : DEFAULT_WINDOWS;
}

function resolveWindow(windows, windowId) {
  return windows.find((w) => w.id === windowId)
    || windows.find((w) => w.id === FALLBACK_WINDOW_ID)
    || windows[windows.length - 1]
    || null;
}

// Whether the window has already shut today. Comparing minutes-since-local-
// midnight needs no date arithmetic: the count resets at local midnight, so at
// 00:30 the next day the same window reads as open again, which is exactly the
// daily reset a recurring chore wants.
function isWindowClosed(windowDef, now = new Date()) {
  if (!windowDef || !HHMM_RE.test(windowDef.closesAt || '')) return false;
  return localMinutes(now) >= hhmmToMinutes(windowDef.closesAt);
}

async function getHouseholdQuietHours() {
  const { resource: household } = await container('households')
    .item(HOUSEHOLD_ID, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  return household && household.quietHours ? household.quietHours : null;
}

async function sendPushIfAllowed(personId, payload, quietHours) {
  if (!personId || isInQuietHours(quietHours)) return { sent: 0, removed: 0, suppressed: true };
  try {
    return await sendPush(personId, payload);
  } catch (err) {
    // Push delivery is a side-effect. Never fail the underlying action because
    // push is unavailable or misconfigured.
    console.warn('sendPush failed', err && err.message ? err.message : err);
    return { sent: 0, removed: 0, failed: true };
  }
}

async function queryHousehold(containerName) {
  const { resources } = await container(containerName)
    .items.query({
      query: 'SELECT * FROM c WHERE c.householdId = @h',
      parameters: [{ name: '@h', value: HOUSEHOLD_ID }],
    })
    .fetchAll();
  return resources;
}

const BADGES = [
  { id: 'first-steps',     emoji: '🌱', label: 'First Steps',      test: (count, _streak) => count >= 1  },
  { id: 'getting-started', emoji: '💪', label: 'Getting Started',   test: (count, _streak) => count >= 10 },
  { id: 'chore-champion',  emoji: '🏅', label: 'Chore Champion',    test: (count, _streak) => count >= 25 },
  { id: 'on-a-roll',       emoji: '🔥', label: 'On a Roll',         test: (_count, streak) => streak >= 3  },
  { id: 'week-warrior',    emoji: '⚡', label: 'Week Warrior',       test: (_count, streak) => streak >= 7  },
  { id: 'unstoppable',     emoji: '👑', label: 'Unstoppable',        test: (_count, streak) => streak >= 14 },
];

function calcBadges(approvedCount, streak) {
  return BADGES.map((b) => ({
    id: b.id,
    emoji: b.emoji,
    label: b.label,
    earned: b.test(approvedCount, streak),
  }));
}

// Streak = consecutive days with >=1 pending/approved completion, not counting
// today against you if nothing's been done yet today.
function calcStreak(completions) {
  const days = new Set();
  completions.forEach((c) => {
    if (c.status === 'approved' || c.status === 'pending') days.add(c.date);
  });
  const fmt = (d) => d.toISOString().slice(0, 10);
  let streak = 0;
  const cursor = new Date();
  if (!days.has(fmt(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  while (days.has(fmt(cursor))) {
    streak++;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

async function getState() {
  const { resource: household } = await container('households')
    .item(HOUSEHOLD_ID, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  const people = await queryHousehold('people');
  const chores = (await queryHousehold('chores')).filter((t) => t.active !== false);
  const completions = await queryHousehold('completions');
  const rewardDocs = (await queryHousehold('rewards')).filter((r) => r.type === 'reward' && r.active !== false);
  const allRewardRows = await queryHousehold('rewards');
  const redemptionDocs = allRewardRows.filter((r) => r.type === 'redemption');

  const windows = await getHouseholdWindows();

  const stats = {};
  people
    .filter((p) => p.role === 'kid')
    .forEach((p) => {
      const mine = completions.filter((c) => c.kidId === p.id);
      const points = mine.filter((c) => c.status === 'approved').reduce((s, c) => s + (c.points || 0), 0);
      const spent = redemptionDocs
        .filter((r) => r.kidId === p.id && (r.status === 'pending' || r.status === 'approved'))
        .reduce((s, r) => s + (r.cost || 0), 0);
      const approvedCount = mine.filter((c) => c.status === 'approved').length;
      const streak = calcStreak(mine);
      stats[p.id] = { points, streak, spent, balance: points - spent, badges: calcBadges(approvedCount, streak) };
    });

  return {
    ok: true,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
    // `closed` is computed HERE, not in the browser. The server is the only
    // clock: it is the thing that enforces the close, and a phone whose OS
    // timezone differs from the household's would otherwise show a different
    // truth than the API acts on. Stale-while-open is acceptable - the display
    // refreshes on every state fetch, and a submit against a window that shut
    // in between gets the API's own refusal with a clear message.
    windows: windows.map((w) => ({ ...w, closed: isWindowClosed(w) })),
    fallbackWindowId: FALLBACK_WINDOW_ID,
    people: people.map((p) => ({ id: p.id, name: p.name, emoji: p.emoji, role: p.role, hasPin: !!p.pin })),
    rewards: rewardDocs.map((r) => ({ id: r.id, title: r.title, cost: r.cost, needsApproval: r.needsApproval })),
    redemptions: redemptionDocs
      .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))
      .map((r) => ({
        id: r.id,
        rewardId: r.rewardId,
        kidId: r.kidId,
        title: r.title,
        cost: r.cost,
        status: r.status,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt || null,
      })),
    tasks: chores.map((t) => ({
      id: t.id,
      kidId: t.kidId,
      title: t.title,
      points: t.points,
      cycle: t.cycle,
      windowId: t.windowId || null,
      days: Array.isArray(t.days) && t.days.length ? t.days : null,
      dueBy: t.dueBy || null,
      // Chores created before reordering existed have no order field. Falling
      // back to 0 here keeps them ahead of nothing in particular rather than
      // sorting as undefined, which would scatter them unpredictably.
      order: t.order ?? 0,
      createdAt: t.createdAt,
    })),
    completions: completions.map((c) => ({
      id: c.id,
      taskId: c.taskId || '',
      kidId: c.kidId,
      title: c.title,
      points: c.points || 0,
      date: c.date,
      status: c.status,
      windowId: c.windowId || null,
      comment: c.comment || null,
      createdAt: c.createdAt,
      decidedAt: c.decidedAt || null,
    })),
    stats,
    quietHours: household && household.quietHours ? household.quietHours : null,
    today: todayStr(),
  };
}

async function requireParent(parentId, parentPin) {
  if (!parentId || !parentPin) {
    throw Object.assign(new Error('Missing parent credentials'), { status: 401 });
  }
  const { resource: person } = await container('people')
    .item(parentId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (!person || person.role !== 'parent' || String(person.pin) !== String(parentPin)) {
    throw Object.assign(new Error('Wrong parent PIN'), { status: 401 });
  }
}

async function requireSelf(personId, pin, expectedId) {
  if (!personId || !expectedId) {
    throw Object.assign(new Error('Missing person credentials'), { status: 401 });
  }
  const { resource: person } = await container('people')
    .item(personId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (!person) {
    throw Object.assign(new Error('Person not found'), { status: 401 });
  }
  if (String(person.pin) !== '' && String(person.pin) !== String(pin || '')) {
    throw Object.assign(new Error('Wrong PIN'), { status: 401 });
  }
  if (String(personId) !== String(expectedId)) {
    throw Object.assign(new Error('Not allowed'), { status: 401 });
  }
}

async function readPerson(personId) {
  const { resource: person } = await container('people')
    .item(personId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  return person;
}

function parseIso(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const asDate = new Date(value);
  if (Number.isNaN(asDate.getTime())) return null;
  return value;
}

async function validatePlanningPersonId(personId) {
  if (personId === null) return { ok: true, personId: null };
  const normalized = String(personId || '').trim();
  if (!normalized) return { ok: false, error: 'personId must be a kid id or null' };
  const person = await readPerson(normalized);
  if (!person || person.role !== 'kid') return { ok: false, error: 'personId must be a kid id or null' };
  return { ok: true, personId: normalized };
}

async function validatePrepLists(prepLists) {
  if (!Array.isArray(prepLists)) return { ok: false, error: 'prepLists must be an array' };
  const normalized = [];
  for (const list of prepLists) {
    if (!list || typeof list !== 'object') return { ok: false, error: 'prepLists entries must be objects' };
    const personCheck = await validatePlanningPersonId(list.personId);
    if (!personCheck.ok || personCheck.personId === null) return { ok: false, error: 'prepLists personId must be a kid id' };
    if (!Array.isArray(list.items)) return { ok: false, error: 'prepLists items must be an array' };
    const items = [];
    for (const item of list.items) {
      const text = String(item && item.text || '').trim();
      if (!text) return { ok: false, error: 'prepLists item text is required' };
      items.push({ text, done: !!(item && item.done) });
    }
    let points = 0;
    if (list.points !== undefined && list.points !== null && list.points !== '') {
      points = Number(list.points);
      if (!Number.isInteger(points) || points < 0) return { ok: false, error: 'prepLists points must be a whole number' };
    }
    normalized.push({ personId: personCheck.personId, items, points });
  }
  return { ok: true, prepLists: normalized };
}

function validateAdultActions(adultActions) {
  if (!Array.isArray(adultActions)) return { ok: false, error: 'adultActions must be an array' };
  const normalized = [];
  for (const action of adultActions) {
    const text = String(action && action.text || '').trim();
    if (!text) return { ok: false, error: 'adultActions text is required' };
    normalized.push({ text, done: !!(action && action.done) });
  }
  return { ok: true, adultActions: normalized };
}

async function findActivePlanningItemByExternalRef(externalRef, excludeId) {
  if (!externalRef) return null;
  const items = await queryHousehold('planningItems');
  return items.find((item) => (
    item.active !== false
    && item.externalRef === externalRef
    && item.id !== excludeId
  )) || null;
}

async function validatePlanningPayload(req, currentItem = null) {
  const next = currentItem ? { ...currentItem } : {
    id: randomUUID(),
    householdId: HOUSEHOLD_ID,
    source: 'manual',
    createdAt: new Date().toISOString(),
    active: true,
    prepLists: [],
    adultActions: [],
    notes: null,
    externalRef: null,
    allDay: false,
  };

  if (!currentItem || req.type !== undefined) {
    const type = String(req.type || next.type || '').trim();
    if (!['event', 'reminder'].includes(type)) return { ok: false, error: 'type must be event or reminder' };
    next.type = type;
  }

  if (!currentItem || req.title !== undefined) {
    const title = String(req.title || '').trim();
    if (!title) return { ok: false, error: 'title is required' };
    next.title = title;
  }

  if (!currentItem || req.startAt !== undefined) {
    const startAt = parseIso(req.startAt);
    if (!startAt) return { ok: false, error: 'startAt must be an ISO datetime' };
    next.startAt = startAt;
  }

  if (!currentItem || req.personId !== undefined) {
    const personCheck = await validatePlanningPersonId(req.personId);
    if (!personCheck.ok) return personCheck;
    next.personId = personCheck.personId;
  }

  if (req.notes !== undefined) {
    if (req.notes === null || req.notes === '') {
      next.notes = null;
    } else if (typeof req.notes === 'string') {
      next.notes = req.notes;
    } else {
      return { ok: false, error: 'notes must be a string' };
    }
  }

  if (req.endAt !== undefined) {
    if (req.endAt === null || req.endAt === '') {
      next.endAt = null;
    } else {
      const endAt = parseIso(req.endAt);
      if (!endAt) return { ok: false, error: 'endAt must be an ISO datetime' };
      next.endAt = endAt;
    }
  }

  if (req.allDay !== undefined) next.allDay = !!req.allDay;

  if (req.source !== undefined) {
    if (!['manual', 'voice', 'email'].includes(req.source)) return { ok: false, error: 'invalid source' };
    next.source = req.source;
  }

  if (req.externalRef !== undefined) {
    if (req.externalRef === null || req.externalRef === '') {
      next.externalRef = null;
    } else if (typeof req.externalRef === 'string') {
      next.externalRef = req.externalRef;
    } else {
      return { ok: false, error: 'externalRef must be a string or null' };
    }
  }

  if (req.prepLists !== undefined) {
    const prepCheck = await validatePrepLists(req.prepLists);
    if (!prepCheck.ok) return prepCheck;
    next.prepLists = prepCheck.prepLists;
  }

  if (req.adultActions !== undefined) {
    const actionCheck = validateAdultActions(req.adultActions);
    if (!actionCheck.ok) return actionCheck;
    next.adultActions = actionCheck.adultActions;
  }

  if (next.type === 'reminder') {
    if (req.endAt !== undefined && req.endAt !== null && req.endAt !== '') {
      return { ok: false, error: 'reminders cannot include endAt' };
    }
    if (req.prepLists !== undefined && req.prepLists.length) {
      return { ok: false, error: 'reminders cannot include prepLists' };
    }
    if (req.adultActions !== undefined && req.adultActions.length) {
      return { ok: false, error: 'reminders cannot include adultActions' };
    }
    next.endAt = null;
    next.prepLists = [];
    next.adultActions = [];
  } else if (next.endAt === undefined) {
    next.endAt = null;
  }

  if (next.externalRef) {
    const duplicate = await findActivePlanningItemByExternalRef(next.externalRef, next.id);
    if (duplicate) return { ok: true, duplicate };
  }

  return { ok: true, item: next };
}

async function login(req) {
  const { resource: person } = await container('people')
    .item(req.personId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (!person) return { ok: false, error: 'Person not found' };
  if (String(person.pin) !== '' && String(person.pin) !== String(req.pin || '')) {
    return { ok: false, error: 'Wrong PIN' };
  }
  return { ok: true, role: person.role };
}

async function savePushSubscription(req) {
  const personId = String(req.personId || '').trim();
  await requireSelf(personId, req.pin, personId);
  const subscription = req.subscription || {};
  const endpoint = String(subscription.endpoint || '').trim();
  const p256dh = String(subscription.keys && subscription.keys.p256dh || '').trim();
  const auth = String(subscription.keys && subscription.keys.auth || '').trim();

  if (!personId || !endpoint || !p256dh || !auth) {
    return { ok: false, error: 'Invalid push subscription' };
  }

  const existing = (await queryHousehold('pushSubscriptions')).find(
    (doc) => doc.personId === personId && doc.endpoint === endpoint
  );
  await container('pushSubscriptions').items.upsert({
    id: existing && existing.id ? existing.id : randomUUID(),
    householdId: HOUSEHOLD_ID,
    personId,
    endpoint,
    keys: { p256dh, auth },
    createdAt: existing && existing.createdAt ? existing.createdAt : new Date().toISOString(),
  });
  return { ok: true };
}

async function removePushSubscription(req) {
  const personId = String(req.personId || '').trim();
  await requireSelf(personId, req.pin, personId);
  const endpoint = String(req.endpoint || '').trim();
  if (!personId || !endpoint) return { ok: false, error: 'personId and endpoint are required' };

  const matches = (await queryHousehold('pushSubscriptions')).filter(
    (doc) => doc.personId === personId && doc.endpoint === endpoint
  );
  await Promise.all(
    matches.map((doc) =>
      container('pushSubscriptions')
        .item(doc.id, HOUSEHOLD_ID)
        .delete()
        .catch(() => {})
    )
  );
  return { ok: true };
}

// Which weekdays a weekly chore falls on: 0=Sunday .. 6=Saturday.
//
// Before this existed, `weekly` meant "the weekday this chore happened to be
// created on" - real recurrence, but nobody could see or choose the day. Rather
// than migrate those rows, an absent or empty `days` still falls back to the
// creation-day anchor, so every chore written before today keeps landing where
// it always has. Anything created since carries its own days.
function normaliseChoreDays(value) {
  if (!Array.isArray(value)) return null;
  const days = [...new Set(value.map(Number))];
  if (!days.length) return null;
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return null;
  return days.sort((a, b) => a - b);
}

function choreFallsOnDay(chore, day, anchor) {
  const days = Array.isArray(chore.days) && chore.days.length
    ? chore.days
    : [anchor.getUTCDay()];
  return days.includes(day.getUTCDay());
}

async function addTask(req) {
  await requireParent(req.parentId, req.parentPin);
  const windows = await getHouseholdWindows();
  let windowId = null;
  if (req.windowId !== undefined && req.windowId !== null && req.windowId !== '') {
    if (!windows.some((w) => w.id === req.windowId)) return { ok: false, error: 'unknown window' };
    windowId = req.windowId;
  }
  let days = null;
  if (req.cycle === 'weekly' && req.days !== undefined) {
    days = normaliseChoreDays(req.days);
    if (!days) return { ok: false, error: 'pick at least one weekday' };
  }
  await container('chores').items.create({
    id: randomUUID(),
    householdId: HOUSEHOLD_ID,
    kidId: req.kidId,
    title: req.title,
    points: Number(req.points) || 5,
    cycle: req.cycle || 'daily',
    // Which window it is due by. Null reads as the fallback window.
    windowId,
    // Only meaningful on a weekly chore. Null falls back to the creation day.
    days,
    // Due date/time only applies to one-off tasks — daily/weekly recurrence already
    // defines "when", and a recurring due-time is a separate feature (ties into
    // reminders, issue #11) rather than a natural extension of this field.
    dueBy: req.cycle === 'oneoff' && req.dueBy ? req.dueBy : null,
    // New chores go to the end of that kid's list, so adding one never
    // reshuffles an order the kid set themselves.
    order: await nextChoreOrder(req.kidId),
    createdAt: todayStr(),
    active: true,
  });
  return getState();
}

async function nextChoreOrder(kidId) {
  const chores = await queryHousehold('chores');
  const mine = chores.filter((c) => c.active !== false && c.kidId === kidId);
  return mine.length ? Math.max(...mine.map((c) => c.order ?? 0)) + 1 : 0;
}

// Reordering is the one thing a kid may change about a chore a parent set them.
// It writes `order` and nothing else - title, points, cycle and kidId stay
// behind updateTask's requireParent gate. Reading the doc and assigning a
// single field (rather than spreading the request over it) is what makes that
// true by construction rather than by remembering to check.
async function reorderTasks(req) {
  await requireSelf(req.personId, req.pin, req.kidId);
  const ids = Array.isArray(req.taskIds) ? req.taskIds.map(String) : null;
  if (!ids) return { ok: false, error: 'taskIds must be an array' };

  const chores = container('chores');
  const all = await queryHousehold('chores');
  const mine = all.filter((c) => c.active !== false && c.kidId === req.kidId);

  // The id set must match this kid's chores exactly. That rejects a foreign id
  // and a partial list in one check - a partial list would silently renumber
  // only some rows and leave the rest colliding.
  const mineIds = mine.map((c) => String(c.id)).sort();
  const sent = [...ids].sort();
  if (mineIds.length !== sent.length || mineIds.some((id, i) => id !== sent[i])) {
    return { ok: false, error: 'taskIds must list exactly your own tasks' };
  }

  await Promise.all(ids.map(async (id, index) => {
    const chore = mine.find((c) => String(c.id) === id);
    if (chore.order === index) return;
    chore.order = index;
    await chores.item(chore.id, HOUSEHOLD_ID).replace(chore);
  }));
  return getState();
}

async function updateTask(req) {
  await requireParent(req.parentId, req.parentPin);
  const chores = container('chores');
  const { resource: chore } = await chores
    .item(req.taskId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (!chore || chore.active === false) return { ok: false, error: 'Task not found' };
  if (req.title !== undefined) {
    const title = (req.title || '').trim();
    if (!title) return { ok: false, error: 'title is required' };
    chore.title = title;
  }
  if (req.points !== undefined) {
    const points = Number(req.points);
    if (!Number.isInteger(points) || points <= 0) return { ok: false, error: 'points must be a positive integer' };
    chore.points = points;
  }
  if (req.cycle !== undefined) {
    if (!['daily', 'weekly', 'oneoff'].includes(req.cycle)) return { ok: false, error: 'invalid cycle' };
    chore.cycle = req.cycle;
  }
  if (req.kidId !== undefined) {
    const { resource: kid } = await container('people')
      .item(req.kidId, HOUSEHOLD_ID)
      .read()
      .catch(() => ({ resource: null }));
    if (!kid || kid.role !== 'kid') return { ok: false, error: 'Kid not found' };
    chore.kidId = req.kidId;
  }
  if (req.windowId !== undefined) {
    if (req.windowId === null || req.windowId === '') {
      chore.windowId = null;
    } else {
      const windows = await getHouseholdWindows();
      if (!windows.some((w) => w.id === req.windowId)) return { ok: false, error: 'unknown window' };
      chore.windowId = req.windowId;
    }
  }
  if (req.days !== undefined && req.days !== null) {
    const days = normaliseChoreDays(req.days);
    if (!days) return { ok: false, error: 'pick at least one weekday' };
    chore.days = days;
  }
  // Same shape as dueBy below: a field that only means anything for one cycle
  // is cleared when the chore moves off it, so a task switched to Every day and
  // back does not quietly keep the weekdays it had two edits ago.
  if (chore.cycle !== 'weekly') {
    chore.days = null;
  }
  if (chore.cycle !== 'oneoff') {
    chore.dueBy = null;
  } else if (req.dueBy !== undefined) {
    chore.dueBy = req.dueBy || null;
  }
  await chores.item(req.taskId, HOUSEHOLD_ID).replace(chore);
  return getState();
}

async function deleteTask(req) {
  await requireParent(req.parentId, req.parentPin);
  const chores = container('chores');
  const { resource: chore } = await chores
    .item(req.taskId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (chore) {
    chore.active = false;
    await chores.item(req.taskId, HOUSEHOLD_ID).replace(chore);
  }
  return getState();
}

// Compute conflicts and alternate suggestions for a planning item against the active
// schedule on the same UTC day. Excludes the item itself so it never conflicts with itself.
async function getConflictsForItem(item) {
  const startDate = new Date(item.startAt);
  if (Number.isNaN(startDate.getTime())) return { conflicts: [], suggestedTimes: [] };

  const dayStart = new Date(Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate()
  ));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const [allPlanningItems, allChores] = await Promise.all([
    queryHousehold('planningItems'),
    queryHousehold('chores'),
  ]);

  const schedule = [];

  for (const pi of allPlanningItems) {
    if (pi.active === false) continue;
    if (pi.id === item.id) continue; // exclude self
    const when = new Date(pi.startAt);
    if (Number.isNaN(when.getTime())) continue;
    if (when.getTime() < dayStart.getTime() || when.getTime() > dayEnd.getTime()) continue;
    schedule.push({ ...pi, kind: pi.type });
  }

  for (const chore of allChores) {
    if (chore.active === false) continue;
    if (chore.cycle !== 'oneoff' || !chore.dueBy) continue;
    const due = new Date(chore.dueBy);
    if (Number.isNaN(due.getTime())) continue;
    if (due.getTime() < dayStart.getTime() || due.getTime() >= dayEnd.getTime()) continue;
    schedule.push({
      kind: 'chore',
      taskId: chore.id,
      kidId: chore.kidId,
      title: chore.title,
      cycle: chore.cycle,
      occurrenceAt: chore.dueBy,
    });
  }

  const candidate = { ...item, kind: item.type };
  const conflicts = findConflicts(candidate, schedule);
  const suggestedTimes = conflicts.length > 0 ? suggestAlternateSlots(candidate, schedule) : [];
  return { conflicts, suggestedTimes };
}

// When prep for an event is due: the close of the LAST window on the day
// before the event - "packed for Sunday soccer by Saturday 9pm". Being ready
// the night before is the thing being rewarded, which is why the deadline is
// not the event's own morning. A per-event override (prepDueBy, ISO) wins
// when set.
async function prepDeadlinePassed(item, now = new Date()) {
  if (item.prepDueBy) {
    const override = new Date(item.prepDueBy);
    if (!Number.isNaN(override.getTime())) return now.getTime() >= override.getTime();
  }
  const eventDate = todayStr(new Date(item.startAt));
  const nowDate = todayStr(now);
  if (nowDate > eventDate) return true;    // the event day is over
  if (nowDate === eventDate) return true;  // the night before has passed
  // Some earlier day. Only the day immediately before can close it.
  const dayBefore = new Date(new Date(`${eventDate}T12:00:00Z`).getTime() - 86400000)
    .toISOString().slice(0, 10);
  if (nowDate !== dayBefore) return false;
  const windows = await getHouseholdWindows();
  const lastClose = Math.max(...windows
    .filter((w) => HHMM_RE.test(w.closesAt || ''))
    .map((w) => hhmmToMinutes(w.closesAt)));
  return Number.isFinite(lastClose) && localMinutes(now) >= lastClose;
}

// A kid ticking one item on their own prep list. requireSelf plus a check the
// list is actually theirs - the parent-only updatePlanningItem stays the only
// way to touch anyone else's.
async function tickPrepItem(req) {
  const personId = String(req.personId || '').trim();
  await requireSelf(personId, req.pin, personId);
  const planningItems = container('planningItems');
  const { resource: item } = await planningItems
    .item(req.planningItemId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (!item || item.active === false) return { ok: false, error: 'Not found' };
  const list = (item.prepLists || []).find((l) => l.personId === personId);
  if (!list) return { ok: false, error: 'Not your list' };
  const index = Number(req.itemIndex);
  if (!Number.isInteger(index) || index < 0 || index >= list.items.length) {
    return { ok: false, error: 'No such item' };
  }
  if (await prepDeadlinePassed(item)) {
    return { ok: false, error: 'Too late — packing closed the night before.', windowClosed: true };
  }
  list.items[index].done = !!req.done;
  await planningItems.item(req.planningItemId, HOUSEHOLD_ID).replace(item);
  return { ok: true, item };
}

// Everything ticked and the kid says "packed". Creates a pending completion -
// the same shape as any chore, so the parent's approval flow needs nothing
// new. Idempotent by id, like a miss.
async function confirmPrep(req) {
  const personId = String(req.personId || '').trim();
  await requireSelf(personId, req.pin, personId);
  const planningItems = container('planningItems');
  const { resource: item } = await planningItems
    .item(req.planningItemId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (!item || item.active === false) return { ok: false, error: 'Not found' };
  const list = (item.prepLists || []).find((l) => l.personId === personId);
  if (!list) return { ok: false, error: 'Not your list' };
  if (!list.items.length || !list.items.every((entry) => entry.done)) {
    return { ok: false, error: 'Tick everything off first.' };
  }
  if (await prepDeadlinePassed(item)) {
    return { ok: false, error: 'Too late — packing closed the night before.', windowClosed: true };
  }
  try {
    await container('completions').items.create({
      id: `prep-${item.id}-${personId}`,
      householdId: HOUSEHOLD_ID,
      taskId: '',
      planningItemId: item.id,
      kidId: personId,
      title: `Packed for ${item.title}`,
      points: Number(list.points) || 0,
      date: todayStr(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    if (!err || err.code !== 409) throw err;
    // Already confirmed - not an error worth showing a kid.
  }
  return getState();
}

async function addPlanningItem(req) {
  await requireParent(req.parentId, req.parentPin);
  const validated = await validatePlanningPayload({
    ...req,
    source: 'manual',
  });
  if (!validated.ok) return validated;
  if (validated.duplicate) return { ok: true, item: validated.duplicate };
  validated.item.source = 'manual';
  await container('planningItems').items.create(validated.item);
  const { conflicts, suggestedTimes } = await getConflictsForItem(validated.item);
  return { ok: true, item: validated.item, conflicts, suggestedTimes };
}

async function updatePlanningItem(req) {
  await requireParent(req.parentId, req.parentPin);
  const planningItems = container('planningItems');
  const { resource: planningItem } = await planningItems
    .item(req.planningItemId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (!planningItem || planningItem.active === false) return { ok: false, error: 'Planning item not found' };
  const validated = await validatePlanningPayload(req, planningItem);
  if (!validated.ok) return validated;
  if (validated.duplicate) return { ok: true, item: validated.duplicate };
  await planningItems.item(req.planningItemId, HOUSEHOLD_ID).replace(validated.item);
  const { conflicts, suggestedTimes } = await getConflictsForItem(validated.item);
  return { ok: true, item: validated.item, conflicts, suggestedTimes };
}

async function deletePlanningItem(req) {
  await requireParent(req.parentId, req.parentPin);
  const planningItems = container('planningItems');
  const { resource: planningItem } = await planningItems
    .item(req.planningItemId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (!planningItem || planningItem.active === false) return { ok: false, error: 'Planning item not found' };
  planningItem.active = false;
  await planningItems.item(req.planningItemId, HOUSEHOLD_ID).replace(planningItem);
  return { ok: true };
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function toDateOnlyIso(date) {
  return date.toISOString().slice(0, 10);
}

function utcDateIso(date) {
  return `${toDateOnlyIso(date)}T00:00:00.000Z`;
}

async function calendar(req) {
  const startAt = parseIso(req.start);
  const endAt = parseIso(req.end);
  if (!startAt || !endAt) return { ok: false, error: 'start and end must be ISO datetimes' };
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (start.getTime() > end.getTime()) return { ok: false, error: 'start must be before end' };

  let callerRole = 'parent';
  let callerKidId = null;
  let filterPersonId = null;

  if (req.parentId || req.parentPin) {
    await requireParent(req.parentId, req.parentPin);
    if (req.personId !== undefined && req.personId !== null) {
      const personCheck = await validatePlanningPersonId(req.personId);
      if (!personCheck.ok) return personCheck;
      filterPersonId = personCheck.personId;
    }
  } else {
    const personId = String(req.personId || '').trim();
    await requireSelf(personId, req.pin, personId);
    const person = await readPerson(personId);
    if (!person || person.role !== 'kid') return { ok: false, error: 'personId must be a kid id or null' };
    callerRole = 'kid';
    callerKidId = personId;
    filterPersonId = personId;
  }

  const [planningItems, chores] = await Promise.all([
    queryHousehold('planningItems'),
    queryHousehold('chores'),
  ]);

  const schedule = [];

  for (const item of planningItems) {
    if (item.active === false) continue;
    const when = new Date(item.startAt);
    if (Number.isNaN(when.getTime())) continue;
    if (when.getTime() < start.getTime() || when.getTime() > end.getTime()) continue;
    if (filterPersonId && item.personId !== null && item.personId !== filterPersonId) continue;
    const row = {
      ...item,
      kind: item.type,
    };
    if (callerRole === 'kid') delete row.adultActions;
    schedule.push(row);
  }

  const rangeStartDay = startOfUtcDay(start);
  const rangeEndDay = startOfUtcDay(end);

  for (const chore of chores) {
    if (chore.active === false) continue;
    if (filterPersonId && chore.kidId !== filterPersonId) continue;

    if (chore.cycle === 'oneoff') {
      if (!chore.dueBy) continue;
      const due = new Date(chore.dueBy);
      if (Number.isNaN(due.getTime())) continue;
      if (due.getTime() < start.getTime() || due.getTime() > end.getTime()) continue;
      schedule.push({
        kind: 'chore',
        taskId: chore.id,
        kidId: chore.kidId,
        title: chore.title,
        points: chore.points,
        cycle: chore.cycle,
        occurrenceAt: chore.dueBy,
      });
      continue;
    }

    const anchor = startOfUtcDay(new Date(chore.createdAt || startAt));
    for (let day = new Date(rangeStartDay); day.getTime() <= rangeEndDay.getTime(); day.setUTCDate(day.getUTCDate() + 1)) {
      if (day.getTime() < anchor.getTime()) continue;
      if (chore.cycle === 'daily' || (chore.cycle === 'weekly' && choreFallsOnDay(chore, day, anchor))) {
        schedule.push({
          kind: 'chore',
          taskId: chore.id,
          kidId: chore.kidId,
          title: chore.title,
          points: chore.points,
          cycle: chore.cycle,
          // The client matches completions per day when a chore names its days,
          // so it has to be able to see them on the occurrence.
          days: Array.isArray(chore.days) && chore.days.length ? chore.days : null,
          occurrenceAt: utcDateIso(day),
          occurrenceDate: toDateOnlyIso(day),
        });
      }
    }
  }

  schedule.sort((a, b) => {
    const aWhen = a.startAt || a.occurrenceAt || '';
    const bWhen = b.startAt || b.occurrenceAt || '';
    return aWhen < bWhen ? -1 : aWhen > bWhen ? 1 : 0;
  });

  for (const item of schedule) {
    const others = schedule.filter((x) => x !== item);
    item.conflictsWith = findConflicts(item, others).map((c) => c.id).filter(Boolean);
    item.suggestedTimes = item.conflictsWith.length > 0 ? suggestAlternateSlots(item, others) : [];
  }

  return {
    ok: true,
    personId: filterPersonId || callerKidId,
    items: schedule,
  };
}

async function completeTask(req) {
  const chores = await queryHousehold('chores');
  const chore = chores.find((t) => t.id === req.taskId);
  if (!chore) return { ok: false, error: 'Task not found' };
  await requireSelf(req.personId, req.pin, chore.kidId);

  // The window is what makes the points real: submit inside it or they are
  // gone. There is no late award and no parent override - that was settled
  // deliberately, because a door that always reopens is not a deadline.
  //
  // One-off chores are left alone. They carry their own dueBy, which is a
  // different mechanism with its own overdue display, and folding the two
  // together is a separate decision rather than a detail of this one.
  if (chore.cycle !== 'oneoff') {
    const windows = await getHouseholdWindows();
    const choreWindow = resolveWindow(windows, chore.windowId);
    if (isWindowClosed(choreWindow)) {
      return {
        ok: false,
        error: `The ${String(choreWindow.label).toLowerCase()} window closed at ${choreWindow.closesAt}.`,
        windowClosed: true,
      };
    }
  }

  // Idempotency: if a client-generated key is supplied, skip creating a
  // duplicate completion record when the same request is replayed (e.g. after
  // an offline sync retry).
  if (req.idempotencyKey) {
    const existing = await queryHousehold('completions');
    if (existing.some((c) => c.idempotencyKey === req.idempotencyKey)) {
      return getState();
    }
  }

  await container('completions').items.create({
    id: randomUUID(),
    householdId: HOUSEHOLD_ID,
    taskId: chore.id,
    kidId: chore.kidId,
    title: chore.title,
    points: Number(chore.points) || 0,
    date: todayStr(),
    status: 'pending',
    createdAt: new Date().toISOString(),
    ...(req.idempotencyKey ? { idempotencyKey: req.idempotencyKey } : {}),
  });
  const [people, quietHours] = await Promise.all([
    queryHousehold('people'),
    getHouseholdQuietHours(),
  ]);
  const kid = people.find((p) => p.id === chore.kidId);
  const kidName = kid && kid.name ? kid.name : 'A kid';
  const parents = people.filter((p) => p.role === 'parent');
  await Promise.all(
    parents.map((parent) => sendPushIfAllowed(parent.id, {
      title: 'Approval needed',
      body: `${kidName} completed ${chore.title}`,
      url: '/',
    }, quietHours))
  );
  return getState();
}

async function uncomplete(req) {
  const completions = container('completions');
  const { resource: completion } = await completions
    .item(req.completionId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (completion && completion.status === 'pending') {
    await requireSelf(req.personId, req.pin, completion.kidId);
    await completions.item(req.completionId, HOUSEHOLD_ID).delete();
  }
  return getState();
}

async function addExtra(req) {
  await requireSelf(req.personId, req.pin, req.kidId);
  await container('completions').items.create({
    id: randomUUID(),
    householdId: HOUSEHOLD_ID,
    taskId: '',
    kidId: req.kidId,
    title: req.title,
    points: 0,
    date: todayStr(),
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  return getState();
}

async function validateVoiceNote(req) {
  await requireSelf(req.personId, req.pin, req.personId);
  const transcript = String(req.transcript || '').trim();
  if (!transcript) return { ok: false, error: 'Transcript is required' };

  const kids = (await queryHousehold('people'))
    .filter((person) => person.role === 'kid')
    .map((person) => ({
      id: person.id,
      name: person.name,
      isRequester: person.id === req.personId,
    }));

  const { available, intent, confidence } = await extractVoiceIntent(transcript, kids);
  const needsConfirmation = !available || Object.values(confidence)
    .some((value) => Number(value) < VOICE_INTENT_CONFIRMATION_THRESHOLD);

  return { ok: true, available, intent, confidence, needsConfirmation };
}

// A parent's note on a decision. Trimmed, and capped so one pasted essay cannot
// distort every kid card that renders it.
const DECISION_COMMENT_MAX = 280;

function normaliseDecisionComment(value) {
  const text = String(value == null ? '' : value).trim();
  return text ? text.slice(0, DECISION_COMMENT_MAX) : '';
}

async function approve(req) {
  await requireParent(req.parentId, req.parentPin);
  const completions = container('completions');
  const { resource: completion } = await completions
    .item(req.completionId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (completion) {
    if (req.points !== undefined && req.points !== null && req.points !== '') {
      completion.points = Number(req.points);
    }
    completion.status = 'approved';
    completion.comment = normaliseDecisionComment(req.comment);
    completion.decidedAt = new Date().toISOString();
    await completions.item(req.completionId, HOUSEHOLD_ID).replace(completion);
    const quietHours = await getHouseholdQuietHours();
    await sendPushIfAllowed(completion.kidId, {
      title: 'Nice work! 🎉',
      body: `You earned ${Number(completion.points) || 0} points for ${completion.title}`,
      url: '/',
    }, quietHours);
  }
  return getState();
}

async function reject(req) {
  await requireParent(req.parentId, req.parentPin);
  const completions = container('completions');
  const { resource: completion } = await completions
    .item(req.completionId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (completion) {
    // Required on a decline, unlike approve. A rejection with no reason leaves
    // the kid with a red cross and no idea what to change, which is the whole
    // problem this solves - so it is enforced here, not only in the UI.
    const comment = normaliseDecisionComment(req.comment);
    if (!comment) return { ok: false, error: 'Tell them what to do to get it approved' };

    completion.status = 'rejected';
    completion.comment = comment;
    completion.decidedAt = new Date().toISOString();
    await completions.item(req.completionId, HOUSEHOLD_ID).replace(completion);
    const quietHours = await getHouseholdQuietHours();
    await sendPushIfAllowed(completion.kidId, {
      // The reason travels in the notification too - reading it on the lock
      // screen is the fastest way for the kid to know what to fix.
      title: 'Chore reviewed',
      body: `${completion.title}: ${comment}`,
      url: '/',
    }, quietHours);
  }
  return getState();
}

async function addKid(req) {
  await requireParent(req.parentId, req.parentPin);
  await container('people').items.create({
    id: randomUUID(),
    householdId: HOUSEHOLD_ID,
    name: req.name,
    emoji: req.emoji || '🙂',
    pin: req.pin || '',
    role: 'kid',
  });
  return getState();
}

async function addReward(req) {
  await requireParent(req.parentId, req.parentPin);
  const title = (req.title || '').trim();
  if (!title) return { ok: false, error: 'title is required' };
  const cost = Number(req.cost);
  if (!Number.isInteger(cost) || cost <= 0) return { ok: false, error: 'cost must be a positive integer' };
  await container('rewards').items.create({
    id: randomUUID(),
    householdId: HOUSEHOLD_ID,
    type: 'reward',
    title,
    cost,
    needsApproval: !!req.needsApproval,
    active: true,
    createdAt: new Date().toISOString(),
  });
  return getState();
}

async function deleteReward(req) {
  await requireParent(req.parentId, req.parentPin);
  const rewards = container('rewards');
  const { resource: reward } = await rewards
    .item(req.rewardId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (reward) {
    reward.active = false;
    await rewards.item(req.rewardId, HOUSEHOLD_ID).replace(reward);
  }
  return getState();
}

async function updateReward(req) {
  await requireParent(req.parentId, req.parentPin);
  const rewards = container('rewards');
  const { resource: reward } = await rewards
    .item(req.rewardId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (!reward) return { ok: false, error: 'Reward not found' };
  if (req.title !== undefined) {
    const title = (req.title || '').trim();
    if (!title) return { ok: false, error: 'title is required' };
    reward.title = title;
  }
  if (req.cost !== undefined) {
    const cost = Number(req.cost);
    if (!Number.isInteger(cost) || cost <= 0) return { ok: false, error: 'cost must be a positive integer' };
    reward.cost = cost;
  }
  if (req.needsApproval !== undefined) reward.needsApproval = !!req.needsApproval;
  await rewards.item(req.rewardId, HOUSEHOLD_ID).replace(reward);
  return getState();
}

async function updateQuietHours(req) {
  await requireParent(req.parentId, req.parentPin);
  const start = req.start;
  const end = req.end;
  const clearQuietHours = start === null && end === null;
  const validQuietHours = typeof start === 'string' && typeof end === 'string'
    && HHMM_RE.test(start) && HHMM_RE.test(end);
  if (!clearQuietHours && !validQuietHours) {
    return { ok: false, error: 'start and end must both be HH:MM strings or both null' };
  }

  const households = container('households');
  const { resource: household } = await households
    .item(HOUSEHOLD_ID, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (!household) return { ok: false, error: 'Household not found' };
  household.quietHours = clearQuietHours ? null : { start, end };
  await households.item(HOUSEHOLD_ID, HOUSEHOLD_ID).replace(household);
  return getState();
}

async function redeemReward(req) {
  await requireSelf(req.personId, req.pin, req.kidId);
  const rewards = container('rewards');
  const { resource: reward } = await rewards
    .item(req.rewardId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (!reward || reward.type !== 'reward' || reward.active === false) {
    return { ok: false, error: 'Reward not found or inactive' };
  }

  const { resource: kid } = await container('people')
    .item(req.kidId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (!kid || kid.role !== 'kid') {
    return { ok: false, error: 'Kid not found' };
  }

  const allRewardRows = await queryHousehold('rewards');
  const spent = allRewardRows
    .filter((r) => r.type === 'redemption' && r.kidId === req.kidId && (r.status === 'pending' || r.status === 'approved'))
    .reduce((s, r) => s + (r.cost || 0), 0);
  const completions = await queryHousehold('completions');
  const points = completions
    .filter((c) => c.kidId === req.kidId && c.status === 'approved')
    .reduce((s, c) => s + (c.points || 0), 0);
  const balance = points - spent;
  if (reward.cost > balance) {
    return { ok: false, error: 'Insufficient balance' };
  }

  const now = new Date().toISOString();
  const needsApproval = !!reward.needsApproval;
  await rewards.items.create({
    id: randomUUID(),
    householdId: HOUSEHOLD_ID,
    type: 'redemption',
    rewardId: reward.id,
    kidId: req.kidId,
    title: reward.title,
    cost: reward.cost,
    status: needsApproval ? 'pending' : 'approved',
    createdAt: now,
    decidedAt: needsApproval ? null : now,
  });
  return getState();
}

async function approveRedemption(req) {
  await requireParent(req.parentId, req.parentPin);
  const rewards = container('rewards');
  const { resource: redemption } = await rewards
    .item(req.redemptionId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (redemption && redemption.type === 'redemption' && redemption.status === 'pending') {
    redemption.status = 'approved';
    redemption.decidedAt = new Date().toISOString();
    await rewards.item(req.redemptionId, HOUSEHOLD_ID).replace(redemption);
  }
  return getState();
}

async function rejectRedemption(req) {
  await requireParent(req.parentId, req.parentPin);
  const rewards = container('rewards');
  const { resource: redemption } = await rewards
    .item(req.redemptionId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (redemption && redemption.type === 'redemption' && redemption.status === 'pending') {
    redemption.status = 'rejected';
    redemption.decidedAt = new Date().toISOString();
    await rewards.item(req.redemptionId, HOUSEHOLD_ID).replace(redemption);
  }
  return getState();
}

async function cancelRedemption(req) {
  await requireSelf(req.personId, req.pin, req.kidId);
  const rewards = container('rewards');
  const { resource: redemption } = await rewards
    .item(req.redemptionId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (!redemption || redemption.type !== 'redemption') {
    return { ok: false, error: 'Redemption not found' };
  }
  if (redemption.kidId !== req.kidId) {
    return { ok: false, error: 'Not your redemption' };
  }
  if (redemption.status !== 'pending') {
    return { ok: false, error: 'Only pending redemptions can be cancelled' };
  }
  redemption.status = 'cancelled';
  redemption.decidedAt = new Date().toISOString();
  await rewards.item(req.redemptionId, HOUSEHOLD_ID).replace(redemption);
  return getState();
}

// A miss is a record that the points were not earned. Nothing more: nothing is
// deducted, no streak breaks - that was settled in #9, and points-not-earned
// is already the consequence. What the record buys is the pattern ("bins:
// missed 3 of the last 7") and a yesterday that starts from something instead
// of blank. Without it the app knows what was done but never what should have
// been, and every morning looks identical however the day before went.
//
// Misses live in the completions container as status: 'missed' rows rather
// than a container of their own, so one stream holds everything that happened
// to a chore. They carry the forfeited points for display; nothing counts
// them - balances only ever sum approved rows.
//
// The sweep runs from the same 15-minute timer as due reminders. Idempotency
// is the record's own id: miss-<taskId>-<date> is deterministic, so a second
// sweep of the same window finds the create refused and moves on. That also
// holds across restarts, which a "have I run today" flag would not.
function choreDueToday(chore, dateStr) {
  if (chore.cycle === 'daily') return true;
  if (chore.cycle !== 'weekly') return false;
  // The weekday of a local date, taken at UTC noon of that date so no
  // timezone can shift it across midnight.
  const weekday = new Date(`${dateStr}T12:00:00Z`).getUTCDay();
  if (Array.isArray(chore.days) && chore.days.length) return chore.days.includes(weekday);
  const anchor = new Date(`${chore.createdAt || dateStr}T12:00:00Z`);
  return weekday === anchor.getUTCDay();
}

async function recordMisses(now = new Date()) {
  const dateStr = todayStr(now);
  const [chores, completions, windows] = await Promise.all([
    queryHousehold('chores'),
    queryHousehold('completions'),
    getHouseholdWindows(),
  ]);
  const completionsContainer = container('completions');
  const settledToday = new Set(
    completions
      .filter((c) => c.date === dateStr && c.taskId)
      .map((c) => c.taskId)
  );

  let recorded = 0;
  for (const chore of chores) {
    if (chore.active === false) continue;
    if (chore.cycle === 'oneoff') continue; // dueBy is its own mechanism
    if (!choreDueToday(chore, dateStr)) continue;
    const windowDef = resolveWindow(windows, chore.windowId);
    if (!isWindowClosed(windowDef, now)) continue;
    if (settledToday.has(chore.id)) continue; // submitted in time, any status

    try {
      await completionsContainer.items.create({
        // Deterministic id = the idempotency. One miss per chore per day,
        // however many sweeps run.
        id: `miss-${chore.id}-${dateStr}`,
        householdId: HOUSEHOLD_ID,
        taskId: chore.id,
        kidId: chore.kidId,
        title: chore.title,
        // The points that were on the table, for display. Never summed:
        // balances only count approved rows.
        points: Number(chore.points) || 0,
        date: dateStr,
        status: 'missed',
        windowId: windowDef ? windowDef.id : null,
        createdAt: now.toISOString(),
      });
      recorded += 1;
    } catch (err) {
      // 409 means this sweep already ran for this chore today. Anything else
      // is real.
      if (!err || err.code !== 409) throw err;
    }
  }

  // Prep lists miss by the same rule they earn: the night before closed with
  // no confirmation. Only for events still ahead (or today) - the sweep must
  // not backfill history for events that predate the feature.
  const planningItems = await queryHousehold('planningItems');
  for (const item of planningItems) {
    if (item.active === false || item.type !== 'event') continue;
    const eventDate = todayStr(new Date(item.startAt));
    if (eventDate < dateStr) continue;
    if (!(await prepDeadlinePassed(item, now))) continue;
    for (const list of item.prepLists || []) {
      if (!list.items || !list.items.length) continue;
      const confirmed = completions.some((c) => c.id === `prep-${item.id}-${list.personId}`);
      if (confirmed) continue;
      try {
        await completionsContainer.items.create({
          id: `prep-miss-${item.id}-${list.personId}`,
          householdId: HOUSEHOLD_ID,
          taskId: '',
          planningItemId: item.id,
          kidId: list.personId,
          title: `Packed for ${item.title}`,
          points: Number(list.points) || 0,
          date: dateStr,
          status: 'missed',
          createdAt: now.toISOString(),
        });
        recorded += 1;
      } catch (err) {
        if (!err || err.code !== 409) throw err;
      }
    }
  }
  return { recorded };
}

// One nudge to the kid, shortly before a window shuts - not a stream. The
// window's whole design is that the stake is visible in advance, and a single
// "closes at 9" half an hour out is the last moment that information can
// still change the outcome. After the close it is recordMisses' job, not a
// notification's.
const NUDGE_LEAD_MINUTES = 30;

async function sendWindowNudges(now = new Date()) {
  const dateStr = todayStr(now);
  const [chores, completions, windows, quietHours] = await Promise.all([
    queryHousehold('chores'),
    queryHousehold('completions'),
    getHouseholdWindows(),
    getHouseholdQuietHours(),
  ]);
  const choresContainer = container('chores');
  const settledToday = new Set(
    completions.filter((c) => c.date === dateStr && c.taskId).map((c) => c.taskId)
  );
  const nowMinutes = localMinutes(now);

  let sent = 0;
  for (const chore of chores) {
    if (chore.active === false) continue;
    if (chore.cycle === 'oneoff') continue;
    if (!choreDueToday(chore, dateStr)) continue;
    if (settledToday.has(chore.id)) continue;
    // One per chore per day, marked on the chore doc - same shape as the
    // one-off lastReminderSentAt marker that already exists.
    if (chore.nudgedOn === dateStr) continue;
    const windowDef = resolveWindow(windows, chore.windowId);
    if (!windowDef || !HHMM_RE.test(windowDef.closesAt || '')) continue;
    const closeMinutes = hhmmToMinutes(windowDef.closesAt);
    if (nowMinutes < closeMinutes - NUDGE_LEAD_MINUTES || nowMinutes >= closeMinutes) continue;

    await sendPushIfAllowed(chore.kidId, {
      title: 'Closing soon ⏳',
      body: `${chore.title} closes at ${windowDef.closesAt} — ${Number(chore.points) || 0} pts`,
      url: '/',
    }, quietHours);
    chore.nudgedOn = dateStr;
    await choresContainer.item(chore.id, HOUSEHOLD_ID).replace(chore);
    sent += 1;
  }
  return { sent };
}

// One summary to each parent when the last window has shut: what got done,
// what got missed, per kid. A digest, not a stream - the day's single report,
// which is the first time anything in this app has ever told a parent
// anything.
//
// It deliberately bypasses quiet hours: the evening window closes at 21:00
// and a household that sets quiet hours from 21:00 would otherwise never
// receive the one message this feature exists to send. It fires once per day
// and it goes to the adults - that is a different thing from pinging a kid's
// tablet at night.
async function sendEveningSummary(now = new Date()) {
  const dateStr = todayStr(now);
  const windows = await getHouseholdWindows();
  const lastClose = Math.max(...windows
    .filter((w) => HHMM_RE.test(w.closesAt || ''))
    .map((w) => hhmmToMinutes(w.closesAt)));
  if (!Number.isFinite(lastClose) || localMinutes(now) < lastClose) return { sent: 0 };

  const { resource: household } = await container('households')
    .item(HOUSEHOLD_ID, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (!household) return { sent: 0 };
  if (household.summarySentOn === dateStr) return { sent: 0 };

  const [people, chores, completions] = await Promise.all([
    queryHousehold('people'),
    queryHousehold('chores'),
    queryHousehold('completions'),
  ]);
  const kids = people.filter((p) => p.role === 'kid');
  const parents = people.filter((p) => p.role === 'parent');
  const todayRows = completions.filter((c) => c.date === dateStr);

  const lines = [];
  for (const kid of kids) {
    const due = chores.filter((c) =>
      c.active !== false && c.cycle !== 'oneoff' && c.kidId === kid.id && choreDueToday(c, dateStr));
    if (!due.length) continue;
    const missed = todayRows.filter((c) => c.kidId === kid.id && c.status === 'missed').length;
    const doneCount = due.length - missed;
    lines.push(missed === 0
      ? `${kid.name}: all ${due.length} done ✅`
      : `${kid.name}: ${doneCount} of ${due.length} done, ${missed} missed`);
  }
  if (!lines.length) return { sent: 0 };

  // Mark first, then send. If the sends fail the summary is lost for the day
  // rather than repeated on every later tick - for a daily digest, silence is
  // the better failure than a stutter of duplicates.
  household.summarySentOn = dateStr;
  await container('households').item(HOUSEHOLD_ID, HOUSEHOLD_ID).replace(household);

  let sent = 0;
  for (const parent of parents) {
    await sendPushIfAllowed(parent.id, {
      title: 'Today at home',
      body: lines.join(' · '),
      url: '/',
    }, null); // null quiet hours: see the note above
    sent += 1;
  }
  return { sent };
}

async function sendDueReminders(now = new Date()) {
  await ensureSeeded();
  const [chores, completions, quietHours] = await Promise.all([
    queryHousehold('chores'),
    queryHousehold('completions'),
    getHouseholdQuietHours(),
  ]);
  const completedTaskIds = new Set(completions.map((c) => c.taskId).filter(Boolean));
  const choresContainer = container('chores');

  for (const chore of chores) {
    if (chore.active === false) continue;
    if (chore.cycle !== 'oneoff') continue;
    if (!chore.dueBy || chore.lastReminderSentAt) continue;
    if (completedTaskIds.has(chore.id)) continue;
    const dueAt = new Date(chore.dueBy);
    if (Number.isNaN(dueAt.getTime()) || dueAt.getTime() > now.getTime()) continue;

    if (isInQuietHours(quietHours, now)) continue;

    await sendPushIfAllowed(chore.kidId, {
      title: 'Chore due',
      body: `${chore.title} is due now`,
      url: '/',
    }, quietHours);

    chore.lastReminderSentAt = now.toISOString();
    await choresContainer.item(chore.id, HOUSEHOLD_ID).replace(chore);
  }
}

// ---------------------------------------------------------------------------
// My List - a kid's own notes, plans and reminders.
//
// These sit in the same planningItems container as the parent calendar, but on
// their own routes gated by requireSelf rather than requireParent. Separate
// routes rather than loosening the parent ones: validatePlanningPayload demands
// an ISO startAt and only allows event|reminder, and a note jotted down with no
// date fits neither. Widening it to admit undated notes would weaken the
// validation the parent calendar depends on.
//
// This is also why My List exists at all. calendar() skips any item whose
// startAt will not parse, so an undated personal item - including a voice item
// whose "when" could not be read - is invisible everywhere in the app today.
const MY_ITEM_TYPES = ['note', 'reminder', 'plan'];
const MY_ITEM_CATEGORIES = ['school', 'home', 'sport', 'fun', 'other'];

function isMyItem(doc, kidId) {
  return doc
    && doc.active !== false
    && doc.personId === kidId
    && MY_ITEM_TYPES.includes(doc.type);
}

async function readMyItems(kidId) {
  const items = await queryHousehold('planningItems');
  return items
    .filter((doc) => isMyItem(doc, kidId))
    .sort((a, b) => {
      const byOrder = (a.order ?? 0) - (b.order ?? 0);
      if (byOrder !== 0) return byOrder;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
}

async function myItems(req) {
  await requireSelf(req.personId, req.pin, req.kidId);
  return { ok: true, items: await readMyItems(req.kidId) };
}

async function addMyItem(req) {
  await requireSelf(req.personId, req.pin, req.kidId);

  const title = String(req.title || '').trim();
  if (!title) return { ok: false, error: 'title is required' };

  const type = String(req.type || '').trim();
  if (!MY_ITEM_TYPES.includes(type)) {
    return { ok: false, error: `type must be one of: ${MY_ITEM_TYPES.join(', ')}` };
  }

  const category = String(req.category || 'other').trim();
  if (!MY_ITEM_CATEGORIES.includes(category)) {
    return { ok: false, error: `category must be one of: ${MY_ITEM_CATEGORIES.join(', ')}` };
  }

  // New items go to the end of the kid's own list.
  const existing = await readMyItems(req.kidId);
  const order = existing.length
    ? Math.max(...existing.map((doc) => doc.order ?? 0)) + 1
    : 0;

  const doc = {
    id: randomUUID(),
    householdId: HOUSEHOLD_ID,
    personId: req.kidId,
    type,
    title,
    category,
    order,
    status: 'open',
    source: 'manual',
    startAt: null,
    allDay: false,
    active: true,
    createdAt: new Date().toISOString(),
  };
  await container('planningItems').items.create(doc);
  return { ok: true, item: doc };
}

async function updateMyItem(req) {
  await requireSelf(req.personId, req.pin, req.kidId);
  const planningItems = container('planningItems');
  const { resource: doc } = await planningItems
    .item(req.itemId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));

  // The ownership check is the point of this route: a valid PIN proves who you
  // are, not that the item you named is yours.
  if (!isMyItem(doc, req.kidId)) return { ok: false, error: 'Item not found' };

  if (req.title !== undefined) {
    const title = String(req.title || '').trim();
    if (!title) return { ok: false, error: 'title is required' };
    doc.title = title;
  }
  if (req.category !== undefined) {
    const category = String(req.category || '').trim();
    if (!MY_ITEM_CATEGORIES.includes(category)) {
      return { ok: false, error: `category must be one of: ${MY_ITEM_CATEGORIES.join(', ')}` };
    }
    doc.category = category;
  }
  if (req.status !== undefined) {
    const status = String(req.status || '').trim();
    if (!['open', 'done'].includes(status)) return { ok: false, error: 'status must be open or done' };
    doc.status = status;
  }

  await planningItems.item(req.itemId, HOUSEHOLD_ID).replace(doc);
  return { ok: true, item: doc };
}

async function reorderMyItems(req) {
  await requireSelf(req.personId, req.pin, req.kidId);
  const ids = Array.isArray(req.itemIds) ? req.itemIds.map(String) : null;
  if (!ids) return { ok: false, error: 'itemIds must be an array' };

  const mine = await readMyItems(req.kidId);
  const mineIds = mine.map((doc) => String(doc.id)).sort();
  const sent = [...ids].sort();
  if (mineIds.length !== sent.length || mineIds.some((id, i) => id !== sent[i])) {
    return { ok: false, error: 'itemIds must list exactly your own items' };
  }

  const planningItems = container('planningItems');
  await Promise.all(ids.map(async (id, index) => {
    const doc = mine.find((entry) => String(entry.id) === id);
    if (doc.order === index) return;
    doc.order = index;
    await planningItems.item(doc.id, HOUSEHOLD_ID).replace(doc);
  }));
  return { ok: true, items: await readMyItems(req.kidId) };
}

async function deleteMyItem(req) {
  await requireSelf(req.personId, req.pin, req.kidId);
  const planningItems = container('planningItems');
  const { resource: doc } = await planningItems
    .item(req.itemId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (!isMyItem(doc, req.kidId)) return { ok: false, error: 'Item not found' };

  // Soft delete, matching every other write to this container. #120 specified a
  // hard delete, but that was written before the parent calendar CRUD landed -
  // calendar() and the parent routes all test `active === false`, and one row
  // that vanishes instead is a trap for the next person reading this file.
  doc.active = false;
  await planningItems.item(req.itemId, HOUSEHOLD_ID).replace(doc);
  return { ok: true };
}

async function saveVoicePlan(req) {
  await requireSelf(req.personId, req.pin, req.kidId);
  const title = String(req.title || '').trim();
  if (!title) return { ok: false, error: 'title is required' };
  const ALLOWED_TYPES = ['reminder', 'task', 'event'];
  const type = String(req.type || '').trim();
  if (!ALLOWED_TYPES.includes(type)) {
    return { ok: false, error: `type must be one of: ${ALLOWED_TYPES.join(', ')}` };
  }
  const whenRaw = req.when || null;
  const parsedWhen = whenRaw ? parseIso(whenRaw) : null;
  // Determine allDay: true when the raw value looks like a date-only string
  const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
  const allDay = parsedWhen !== null && DATE_ONLY_RE.test(String(whenRaw).trim());
  const startAt = parsedWhen ? (allDay ? `${String(whenRaw).trim()}T00:00:00.000Z` : parsedWhen) : null;
  // When no parseable date, preserve the raw text in notes so nothing is silently dropped
  const notes = startAt === null && whenRaw ? String(whenRaw) : undefined;
  const doc = {
    id: randomUUID(),
    householdId: HOUSEHOLD_ID,
    type,
    title,
    source: 'voice',
    personId: req.kidId,
    startAt,
    allDay,
    active: true,
    transcript: req.transcript || '',
    createdAt: new Date().toISOString(),
  };
  if (notes !== undefined) doc.notes = notes;
  await container('planningItems').items.create(doc);
  return getState();
}

const ROUTES = {
  state: () => getState(),
  login,
  savePushSubscription,
  removePushSubscription,
  addTask,
  updateTask,
  deleteTask,
  addPlanningItem,
  updatePlanningItem,
  deletePlanningItem,
  calendar,
  completeTask,
  uncomplete,
  addExtra,
  validateVoiceNote,
  approve,
  reject,
  addKid,
  addReward,
  deleteReward,
  updateReward,
  updateQuietHours,
  redeemReward,
  approveRedemption,
  rejectRedemption,
  cancelRedemption,
  saveVoicePlan,
  myItems,
  addMyItem,
  updateMyItem,
  deleteMyItem,
  reorderMyItems,
  reorderTasks,
  tickPrepItem,
  confirmPrep,
};

app.http('hero', {
  methods: ['POST', 'GET'],
  authLevel: 'anonymous',
  route: 'hero',
  handler: async (request, context) => {
    try {
      await ensureSeeded();
      let req = {};
      if (request.method === 'POST') {
        req = await request.json().catch(() => ({}));
      }
      const action = req.action || 'state';
      const handlerFn = ROUTES[action];
      if (!handlerFn) {
        return { status: 400, jsonBody: { ok: false, error: 'Unknown action' } };
      }
      const result = await handlerFn(req);
      return { jsonBody: result };
    } catch (err) {
      context.error(err);
      return { status: err.status || 500, jsonBody: { ok: false, error: err.message } };
    }
  },
});

app.timer('choreDueReminder', {
  schedule: DUE_REMINDER_SCHEDULE,
  handler: async (_timer, context) => {
    try {
      await sendDueReminders();
    } catch (err) {
      context.error(err);
    }
    try {
      await recordMisses();
    } catch (err) {
      context.error(err);
    }
    try {
      await sendWindowNudges();
    } catch (err) {
      context.error(err);
    }
    try {
      // After recordMisses on purpose: the tick where the last window shuts
      // records the day's misses first, so the summary counts them.
      await sendEveningSummary();
    } catch (err) {
      context.error(err);
    }
  },
});

module.exports = { getState, calcStreak, calcBadges, ROUTES, updateQuietHours, isInQuietHours, sendDueReminders, recordMisses, sendWindowNudges, sendEveningSummary, todayStr, localMinutes, HOUSEHOLD_TZ, DEFAULT_WINDOWS, isWindowClosed, resolveWindow };
