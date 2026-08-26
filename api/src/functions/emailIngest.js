// The timer that reads the family inbox and turns what it finds into
// proposals (#41). Runs hourly inside the household's waking hours; each run
// picks up where the last one's watermark left off, triages every new email
// cheaply, deep-reads the relevant ones with their attachments, and hands the
// results to hero.js's ingestEmailItem - the same gate the tests drive, so
// idempotency, classification behaviour and notifications live in one place.

const { app } = require('@azure/functions');
const { container } = require('../lib/cosmos');
const { HOUSEHOLD_ID } = require('../lib/seed');
const { ROUTES, HOUSEHOLD_TZ } = require('./hero');
const gmail = require('../lib/gmail');
const pipeline = require('../lib/emailPipeline');

// Hourly, 21:00-23:00 and 00:00-14:00 UTC = 05:00-22:00 in Perth (UTC+8,
// no DST). Overridable per environment without a deploy.
const EMAIL_INGEST_SCHEDULE = process.env.EMAIL_INGEST_SCHEDULE || '0 0 21-23,0-14 * * *';

const STATE_DOC_ID = 'email-ingest-state';
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const PROCESSED_IDS_KEPT = 300;
// The after: query is re-run from an hour before the watermark, so a message
// that landed mid-run cannot fall between two runs; processedIds and the
// deterministic ingest ids make the overlap harmless.
const WATERMARK_OVERLAP_MS = 60 * 60 * 1000;

const REQUIRED_ENV = ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'EMAIL_INGEST_KEY', 'LLM_API_KEY'];

function configMissing() {
  return REQUIRED_ENV.filter((key) => !String(process.env[key] || '').trim());
}

// The watermark doc lives in the households container: it is only ever read
// by id, and getState reads its own household doc by id too, so nothing that
// queries whole containers ever sees it.
async function readIngestState() {
  const { resource } = await container('households')
    .item(STATE_DOC_ID, HOUSEHOLD_ID)
    .read()
    .catch(() => ({ resource: null }));
  return resource;
}

async function writeIngestState(state) {
  await container('households').items.upsert({
    id: STATE_DOC_ID,
    householdId: HOUSEHOLD_ID,
    ...state,
  });
}

async function listKids() {
  const { resources } = await container('people')
    .items.query({
      query: 'SELECT * FROM c WHERE c.householdId = @h',
      parameters: [{ name: '@h', value: HOUSEHOLD_ID }],
    })
    .fetchAll();
  return resources
    .filter((p) => p.role === 'kid')
    .map((p) => ({ id: p.id, name: p.name }));
}

function slug(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

async function runEmailIngest(log = () => {}) {
  const missing = configMissing();
  if (missing.length) {
    log(`emailIngest skipped - missing app settings: ${missing.join(', ')}`);
    return { skipped: true, missing };
  }

  const token = await gmail.getAccessToken();
  const state = (await readIngestState()) || {};
  const watermarkMs = Number(state.watermarkMs) || (Date.now() - 24 * 60 * 60 * 1000);
  const processed = new Set(Array.isArray(state.processedIds) ? state.processedIds : []);

  const sinceSeconds = Math.floor((watermarkMs - WATERMARK_OVERLAP_MS) / 1000);
  const refs = await gmail.listMessagesSince(token, sinceSeconds);

  const kids = await listKids();
  let maxInternalMs = watermarkMs;
  let relevant = 0;
  let ingested = 0;
  let duplicates = 0;

  for (const ref of refs) {
    if (processed.has(ref.id)) continue;
    let msg;
    try {
      msg = await gmail.getMessage(token, ref.id);
    } catch (err) {
      // One unreadable message must not stall the whole inbox; unprocessed,
      // it is retried next run via the overlap window.
      log(`emailIngest: could not read message ${ref.id}: ${err.message}`);
      continue;
    }
    const internalMs = Number(msg.internalDate) || Date.now();
    const email = {
      id: ref.id,
      threadId: msg.threadId || ref.id,
      from: gmail.header(msg.payload, 'From'),
      subject: gmail.header(msg.payload, 'Subject'),
      receivedAt: new Date(internalMs).toISOString(),
      bodyText: gmail.extractBodyText(msg.payload),
    };

    try {
      const triage = await pipeline.triageEmail(email);
      if (triage.relevant) {
        relevant += 1;
        const blocks = [];
        for (const att of gmail.listAttachments(msg.payload).slice(0, MAX_ATTACHMENTS)) {
          if (att.size > MAX_ATTACHMENT_BYTES) continue;
          try {
            const attachment = await gmail.getAttachment(token, ref.id, att.attachmentId);
            const block = pipeline.attachmentToBlock(att, attachment.data);
            if (block) blocks.push(block);
          } catch (err) {
            log(`emailIngest: attachment ${att.filename} on ${ref.id} skipped: ${err.message}`);
          }
        }
        const extraction = await pipeline.extractProposals(email, blocks, kids, HOUSEHOLD_TZ);
        for (const item of extraction.items) {
          const result = await ROUTES.ingestEmailItem({
            ingestKey: process.env.EMAIL_INGEST_KEY,
            classification: item.classification,
            type: item.type || 'event',
            title: item.title,
            personId: item.personId || null,
            startAt: item.startAt,
            endAt: item.endAt || null,
            allDay: !!item.allDay,
            summary: item.summary || '',
            payments: item.payments || [],
            prepLists: item.prepLists || [],
            adultActions: item.adultActions || [],
            proposedPrepDueBy: item.proposedPrepDueBy || null,
            // Per item, not per thread: one scouts email carries several
            // events, and a chase-up in the same thread re-mentioning one of
            // them lands on the same ref and dedupes.
            externalRef: `gmail-${email.threadId}:${slug(item.title)}`,
            from: email.from,
            subject: email.subject,
            receivedAt: email.receivedAt,
          });
          if (result.ok && result.duplicate) duplicates += 1;
          else if (result.ok) ingested += 1;
          else log(`emailIngest: '${item.title}' refused: ${result.error}`);
        }
      }
    } catch (err) {
      // Triage or extraction failing on one email should not block the rest,
      // but the message stays unprocessed so the next run retries it.
      log(`emailIngest: pipeline failed on ${ref.id}: ${err.message}`);
      continue;
    }

    processed.add(ref.id);
    if (internalMs > maxInternalMs) maxInternalMs = internalMs;
  }

  await writeIngestState({
    watermarkMs: maxInternalMs,
    processedIds: [...processed].slice(-PROCESSED_IDS_KEPT),
    lastRunAt: new Date().toISOString(),
  });

  const summary = { skipped: false, checked: refs.length, relevant, ingested, duplicates };
  log(`emailIngest: ${JSON.stringify(summary)}`);
  return summary;
}

app.timer('emailIngest', {
  schedule: EMAIL_INGEST_SCHEDULE,
  handler: async (_timer, context) => {
    try {
      await runEmailIngest((line) => context.log(line));
    } catch (err) {
      context.error(err);
    }
  },
});

module.exports = { runEmailIngest, configMissing, EMAIL_INGEST_SCHEDULE };
