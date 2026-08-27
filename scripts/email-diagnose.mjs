// Runs the email import on the LIVE app and prints what it did, from a GitHub
// Actions runner (the dev container's egress policy cannot reach
// azurewebsites.net - the proxy answers 403 to CONNECT).
//
// This exists so a failed import can be diagnosed without the owner
// copy-pasting terminal output: the workflow log holds the full answer, and
// whoever is debugging can read it straight from the run.
const BASE = process.env.API_BASE || 'https://herotasks-func-dev.azurewebsites.net/api';
const KEY = process.env.EMAIL_INGEST_KEY;
const lookbackDays = Number(process.env.LOOKBACK_DAYS) || 21;
const maxMessages = Number(process.env.MAX_MESSAGES) || 60;

if (!KEY) {
  console.error('EMAIL_INGEST_KEY is not set as a repository secret - add it in');
  console.error('Settings -> Secrets and variables -> Actions -> New repository secret.');
  process.exit(1);
}

const res = await fetch(`${BASE}/email-ingest-run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ingestKey: KEY, lookbackDays, maxMessages }),
});
const body = await res.json().catch(() => null);

console.log(`HTTP ${res.status}`);
if (!body) {
  console.error('No JSON body came back.');
  process.exit(1);
}

console.log('\n=== SUMMARY ===');
console.log(JSON.stringify(body.summary || { error: body.error, stack: body.stack }, null, 2));
console.log('\n=== LOG ===');
(body.log || []).forEach((line) => console.log(line));

// What the run actually produced, so the extraction quality can be judged
// from the same log rather than a second round-trip through the app.
const stateRes = await fetch(`${BASE}/hero`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'state' }),
});
const state = await stateRes.json().catch(() => ({}));
const proposals = state.proposals || [];
console.log(`\n=== PENDING PROPOSALS (${proposals.length}) ===`);
proposals.forEach((p) => {
  console.log(JSON.stringify({
    title: p.title,
    classification: p.classification,
    personId: p.personId,
    startAt: p.startAt,
    endAt: p.endAt,
    proposedPrepDueBy: p.proposedPrepDueBy,
    summary: p.summary,
    payments: p.payments,
    prepLists: p.prepLists,
    adultActions: p.adultActions,
    from: p.sourceMeta && p.sourceMeta.from,
    subject: p.sourceMeta && p.sourceMeta.subject,
  }, null, 2));
});

if (body.ok === false) process.exit(1);
