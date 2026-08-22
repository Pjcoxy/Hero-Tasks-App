const { randomUUID } = require('crypto');
const { container } = require('./cosmos');
const { HOUSEHOLD_ID } = require('./seed');

async function logAuditEvent({ actorId, actorName, action, entityType, entityId, details }) {
  try {
    await container('auditEvents').items.create({
      id: randomUUID(),
      householdId: HOUSEHOLD_ID,
      actorId,
      actorName,
      action,
      entityType,
      entityId,
      details: details || null,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('logAuditEvent failed', err && err.message ? err.message : err);
  }
}

module.exports = { logAuditEvent };
