const { app } = require('@azure/functions');
const { randomUUID } = require('crypto');
const { container } = require('../lib/cosmos');
const { ensureSeeded, HOUSEHOLD_ID } = require('../lib/seed');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

const HHMM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

async function queryHousehold(containerName) {
  const { resources } = await container(containerName)
    .items.query({
      query: 'SELECT * FROM c WHERE c.householdId = @h',
      parameters: [{ name: '@h', value: HOUSEHOLD_ID }],
    })
    .fetchAll();
  return resources;
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
      stats[p.id] = { points, streak: calcStreak(mine), spent, balance: points - spent };
    });

  return {
    ok: true,
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

async function completeTask(req) {
  const chores = await queryHousehold('chores');
  const chore = chores.find((t) => t.id === req.taskId);
  if (!chore) return { ok: false, error: 'Task not found' };
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
  return getState();
}

async function uncomplete(req) {
  const completions = container('completions');
  const { resource: completion } = await completions
    .item(req.completionId, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  if (completion && completion.status === 'pending') {
    await completions.item(req.completionId, HOUSEHOLD_ID).delete();
  }
  return getState();
}

async function addExtra(req) {
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
    await completions.item(req.completionId, HOUSEHOLD_ID).replace(completion);
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
    await completions.item(req.completionId, HOUSEHOLD_ID).replace(completion);
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

const ROUTES = {
  state: () => getState(),
  login,
  addTask,
  deleteTask,
  completeTask,
  uncomplete,
  addExtra,
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

module.exports = { getState, calcStreak, updateQuietHours };
