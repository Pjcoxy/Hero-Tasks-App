const { app } = require('@azure/functions');
const { randomUUID } = require('crypto');
const { container } = require('../lib/cosmos');
const { ensureSeeded, HOUSEHOLD_ID } = require('../lib/seed');
const { sendPush } = require('../lib/push');
const { extractVoiceIntent } = require('../lib/llm');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
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
  const nowMinutes = (now.getUTCHours() * 60) + now.getUTCMinutes();
  if (start === end) return true;
  if (start < end) return nowMinutes >= start && nowMinutes < end;
  return nowMinutes >= start || nowMinutes < end;
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
      dueBy: t.dueBy || null,
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
    normalized.push({ personId: personCheck.personId, items });
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

async function addTask(req) {
  await requireParent(req.parentId, req.parentPin);
  await container('chores').items.create({
    id: randomUUID(),
    householdId: HOUSEHOLD_ID,
    kidId: req.kidId,
    title: req.title,
    points: Number(req.points) || 5,
    cycle: req.cycle || 'daily',
    // Due date/time only applies to one-off tasks — daily/weekly recurrence already
    // defines "when", and a recurring due-time is a separate feature (ties into
    // reminders, issue #11) rather than a natural extension of this field.
    dueBy: req.cycle === 'oneoff' && req.dueBy ? req.dueBy : null,
    createdAt: todayStr(),
    active: true,
  });
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
  return { ok: true, item: validated.item };
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
  return { ok: true, item: validated.item };
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
      if (chore.cycle === 'daily' || (chore.cycle === 'weekly' && day.getUTCDay() === anchor.getUTCDay())) {
        schedule.push({
          kind: 'chore',
          taskId: chore.id,
          kidId: chore.kidId,
          title: chore.title,
          points: chore.points,
          cycle: chore.cycle,
          occurrenceAt: utcDateIso(day),
          occurrenceDate: toDateOnlyIso(day),
        });
      }
    }
  }

  return {
    ok: true,
    personId: filterPersonId || callerKidId,
    items: schedule.sort((a, b) => {
      const aWhen = a.startAt || a.occurrenceAt || '';
      const bWhen = b.startAt || b.occurrenceAt || '';
      return aWhen < bWhen ? -1 : aWhen > bWhen ? 1 : 0;
    }),
  };
}

async function completeTask(req) {
  const chores = await queryHousehold('chores');
  const chore = chores.find((t) => t.id === req.taskId);
  if (!chore) return { ok: false, error: 'Task not found' };
  await requireSelf(req.personId, req.pin, chore.kidId);
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
    completion.status = 'rejected';
    completion.decidedAt = new Date().toISOString();
    await completions.item(req.completionId, HOUSEHOLD_ID).replace(completion);
    const quietHours = await getHouseholdQuietHours();
    await sendPushIfAllowed(completion.kidId, {
      title: 'Chore reviewed',
      body: `${completion.title} needs another try — give it another go!`,
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
  },
});

module.exports = { getState, calcStreak, calcBadges, ROUTES, updateQuietHours, isInQuietHours, sendDueReminders };
