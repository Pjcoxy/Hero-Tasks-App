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

// The scheduled import is OFF unless this app setting says otherwise. Every
// run triages each new email through the Claude API, which costs money hourly
// whether or not anything useful arrives - so running on a timer is a
// deliberate choice, made in the portal, not a side-effect of deploying. The
// on-demand route below is unaffected: a run you asked for still runs.
function scheduledIngestEnabled() {
  return String(process.env.EMAIL_INGEST_ENABLED || '').trim().toLowerCase() === 'true';
}

const STATE_DOC_ID = 'email-ingest-state';
// Three weeks of a family inbox comfortably exceeds 200, and a silently
// truncated sweep reads exactly like a complete one - so this is raised, and
// hitting it is logged.
const MAX_MESSAGES = Number(process.env.EMAIL_MAX_MESSAGES) || 500;
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

// What makes two extractions the same event. Not the title: the model's
// wording of one drifts between runs (an en-dash for a hyphen, a longer or
// shorter phrasing), and that drift is what put the same aviation meeting in
// the queue twice. The event's own start instant does not drift.
function eventKey(startAt) {
  const ms = Date.parse(startAt);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16) : '';
}

function slug(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// options lets the diagnostic route run a small, bounded sweep on demand:
// maxMessages caps how many UNREAD-BY-US messages one run works through (so
// the HTTP call cannot outlive its timeout), and lookbackDays forces a window
// without spending the env var's one-shot.
async function runEmailIngest(log = () => {}, options = {}) {
  const missing = configMissing();
  if (missing.length) {
    log(`emailIngest skipped - missing app settings: ${missing.join(', ')}`);
    return { skipped: true, missing };
  }

  const token = await gmail.getAccessToken();
  const state = (await readIngestState()) || {};
  const watermarkMs = Number(state.watermarkMs) || (Date.now() - 24 * 60 * 60 * 1000);
  const processed = new Set(Array.isArray(state.processedIds) ? state.processedIds : []);

  // A backfill sweep, once per distinct value of EMAIL_LOOKBACK_DAYS. Left to
  // apply on every run it would re-scan weeks of mail hourly, and since
  // processedIds only holds the last few hundred ids, anything older would be
  // re-triaged forever. Change the number to sweep again.
  const askedLookback = Number(options.lookbackDays);
  const oneShotLookback = Number(process.env.EMAIL_LOOKBACK_DAYS);
  const requestedLookback = Number.isFinite(askedLookback) && askedLookback > 0
    ? askedLookback : oneShotLookback;
  const lookbackDays = Number.isFinite(requestedLookback) && requestedLookback > 0
    ? requestedLookback : null;
  // An explicit options.lookbackDays always sweeps; the env var only sweeps
  // once per value, so a caller asking directly is never refused by history.
  const backfilling = lookbackDays !== null
    && (Number.isFinite(askedLookback) || state.lookbackDoneFor !== lookbackDays);
  const spendsOneShot = backfilling && !Number.isFinite(askedLookback);

  // The batch cap limits how many messages this run READS, not how many it
  // lists. Listing is cheap metadata; capping it there would be worse than
  // useless for a backfill, because Gmail returns newest first - every run
  // would re-list the same newest N, find them all already processed, and
  // never walk backwards through the window.
  const batchLimit = Number(options.maxMessages) > 0 ? Number(options.maxMessages) : MAX_MESSAGES;
  const sinceMs = backfilling
    ? Date.now() - lookbackDays * 24 * 60 * 60 * 1000
    : watermarkMs - WATERMARK_OVERLAP_MS;
  if (backfilling) log(`emailIngest: sweeping ${lookbackDays} days`);
  const refs = await gmail.listMessagesSince(token, Math.floor(sinceMs / 1000), MAX_MESSAGES);
  log(`emailIngest: ${refs.length} messages in the window`);
  if (refs.length >= MAX_MESSAGES) {
    log(`emailIngest: hit the ${MAX_MESSAGES}-message list cap - older mail in this window was not listed`);
  }

  const kids = await listKids();
  let maxInternalMs = watermarkMs;
  let relevant = 0;
  let ingested = 0;
  let duplicates = 0;

  let readThisRun = 0;
  let unread = 0;
  for (const ref of refs) {
    if (processed.has(ref.id)) continue;
    // Out of budget for this run: count what is left so a truncated sweep
    // never reads as a finished one, and let the next run pick it up.
    if (readThisRun >= batchLimit) { unread += 1; continue; }
    readThisRun += 1;
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
        log(`emailIngest: relevant - "${email.subject}" from ${email.from}`);
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
        log(`emailIngest: ${blocks.length} attachment block(s), ${extraction.items.length} item(s) extracted`);
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
            // them lands on the same ref and dedupes. Title only as a last
            // resort, when the item somehow arrived without a usable date.
            externalRef: `gmail-${email.threadId}:${eventKey(item.startAt) || slug(item.title)}`,
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
    lookbackDoneFor: spendsOneShot ? lookbackDays : (state.lookbackDoneFor ?? null),
  });

  if (unread) log(`emailIngest: ${unread} message(s) in the window still unread - run again to continue`);
  const summary = {
    skipped: false, listed: refs.length, read: readThisRun, stillUnread: unread,
    relevant, ingested, duplicates, backfilled: backfilling,
  };
  log(`emailIngest: ${JSON.stringify(summary)}`);
  return summary;
}

app.timer('emailIngest', {
  schedule: EMAIL_INGEST_SCHEDULE,
  handler: async (_timer, context) => {
    if (!scheduledIngestEnabled()) {
      context.log('emailIngest: scheduled runs are off (EMAIL_INGEST_ENABLED is not true)');
      return;
    }
    try {
      await runEmailIngest((line) => context.log(line));
    } catch (err) {
      context.error(err);
    }
  },
});

// Ops endpoint: run the import now and hand back, line by line, what it did.
// This plan offers no log stream, so a failed run is otherwise completely
// invisible - which is exactly how the first live run went. Same ingest key as
// the write path guards it; it reads mail and writes proposals, nothing more.
app.http('emailIngestRun', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'email-ingest-run',
  handler: async (request, context) => {
    const req = await request.json().catch(() => ({}));
    const key = process.env.EMAIL_INGEST_KEY;
    if (!key || String(req.ingestKey || '') !== key) {
      return { status: 401, jsonBody: { ok: false, error: 'Bad ingest key' } };
    }
    const lines = [];
    const capture = (line) => { lines.push(line); context.log(line); };
    try {
      const summary = await runEmailIngest(capture, {
        maxMessages: req.maxMessages,
        lookbackDays: req.lookbackDays,
      });
      return { jsonBody: { ok: true, summary, log: lines.slice(-200) } };
    } catch (err) {
      // The whole point of this route: the error reaches the caller instead of
      // vanishing into a log nobody can read.
      return {
        status: 500,
        jsonBody: {
          ok: false,
          error: err && err.message ? err.message : String(err),
          stack: String(err && err.stack || '').split('\n').slice(0, 6),
          log: lines.slice(-200),
        },
      };
    }
  },
});

module.exports = { runEmailIngest, configMissing, scheduledIngestEnabled, EMAIL_INGEST_SCHEDULE };
