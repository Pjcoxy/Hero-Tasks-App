const webPush = require('web-push');
const { container } = require('./cosmos');
const { HOUSEHOLD_ID } = require('./seed');

let configuredVapidKey = '';

function ensurePushConfigured() {
  const publicKey = process.env.VAPID_PUBLIC_KEY || '';
  const privateKey = process.env.VAPID_PRIVATE_KEY || '';
  if (!publicKey || !privateKey) {
    throw new Error('Web push is not configured');
  }

  const configKey = `${publicKey}:${privateKey}`;
  if (configuredVapidKey === configKey) return;

  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:no-reply@herotasks.local',
    publicKey,
    privateKey
  );
  configuredVapidKey = configKey;
}

async function getSubscriptionsForPerson(personId) {
  const { resources } = await container('pushSubscriptions')
    .items.query({
      query: 'SELECT * FROM c WHERE c.householdId = @h',
      parameters: [{ name: '@h', value: HOUSEHOLD_ID }],
    })
    .fetchAll();
  return resources.filter((doc) => doc.personId === personId);
}

function getStatusCode(err) {
  return err && (err.statusCode || err.status || err.code);
}

async function sendPush(personId, payload) {
  if (!personId) return { sent: 0, removed: 0 };

  ensurePushConfigured();
  const subscriptions = await getSubscriptionsForPerson(personId);
  const errors = [];
  let removed = 0;

  for (const subscription of subscriptions) {
    try {
      await webPush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: subscription.keys,
        },
        JSON.stringify(payload)
      );
    } catch (err) {
      const statusCode = getStatusCode(err);
      if (statusCode === 404 || statusCode === 410) {
        removed += 1;
        await container('pushSubscriptions')
          .item(subscription.id, HOUSEHOLD_ID)
          .delete()
          .catch(() => {});
        continue;
      }
      errors.push(err);
    }
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Failed to send push notifications');

  return { sent: subscriptions.length - removed, removed };
}

module.exports = { sendPush };
