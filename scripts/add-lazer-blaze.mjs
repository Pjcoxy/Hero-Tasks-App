// One-shot: put the Cubs Lazer Blaze night into the LIVE app as a proposal the
// boys can say yes to. Run from a GitHub Actions runner (the dev container's
// egress policy cannot reach azurewebsites.net).
//
// Why this is written by hand rather than imported. The email is in Gmail and
// the email pipeline exists to do exactly this - but the live app's Gmail
// refresh token has expired ("invalid_grant: Token has been expired or
// revoked"), so no sweep can read any mail until it is reconnected. That is a
// credential, and credentials are not an agent's to rotate. This posts the same
// payload the pipeline would have posted, through the same ingest action, so
// nothing about the app is special-cased for it.
//
// The email (michael@portereng.com.au, 7 Sept 2026, "Cubs, Lazer Blaze activity
// 14 Sept 2026"): end of term 3 activity night at Lazer Blaze, Southlands in
// Willetton, Monday 14 Sept. Arrive by 5:40pm, first game 6pm. Pay at Lazer
// Blaze direct on the night. Y3 forms for both boys have already been returned.
//
// classification 'kid-choice' with personId null is what puts it to BOTH kids:
// each answers for themselves, and a parent still approves before it reaches
// the calendar.
//
// Idempotent. The externalRef follows the pipeline's own convention
// (gmail-<threadId>:<startAt to the minute>), so ingest hashes it to the same
// document id every time - a second run returns duplicate:true rather than a
// second card, and a future automatic sweep of the same email lands on the same
// id instead of duplicating this.
const API = process.env.API_URL || 'https://herotasks-func-dev.azurewebsites.net/api/hero';
const INGEST_KEY = process.env.EMAIL_INGEST_KEY;

if (!INGEST_KEY) {
  console.error('EMAIL_INGEST_KEY is not set - the ingest action refuses without it.');
  process.exit(1);
}

// 17:40 Perth (UTC+8) on Monday 14 September 2026 = 09:40Z. "Arrive by 5:40pm"
// is the time the family has to be somewhere, so it is the event's start; the
// 6pm first game is detail, and lives in the notes.
const START_AT = '2026-09-14T09:40:00.000Z';
const THREAD_ID = '1a07c1cef8648ed7';

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

const result = await post({
  action: 'ingestEmailItem',
  ingestKey: INGEST_KEY,
  classification: 'kid-choice',
  externalRef: `gmail-${THREAD_ID}:${START_AT.slice(0, 16)}`,
  type: 'event',
  title: 'Cubs — Lazer Blaze',
  startAt: START_AT,
  // Nobody named: the invitation went to the whole Cub pack, so it is offered
  // to both boys and each answers for themselves.
  personId: null,
  summary: 'End of term 3 Cubs activity night at Lazer Blaze, Southlands, Willetton. Pay at Lazer Blaze on the night.',
  notes: [
    'Arrive by 5:40pm — first game 6pm.',
    'Lazer Blaze, Southlands Shopping Centre, Willetton.',
    'Pay at Lazer Blaze direct on the night (no amount given in the email).',
    'Y3 activity forms for Toby and Oliver have already been signed and sent.',
  ].join('\n'),
  // No payments[] on purpose: the email names no amount, and the payments block
  // exists to carry real bank details. "Pay on the night" is in the notes where
  // it belongs rather than invented as a figure.
  from: 'michael@portereng.com.au',
  subject: 'Cubs, Lazer Blaze activity 14 Sept 2026',
  receivedAt: '2026-09-07T13:44:17.000Z',
});

console.log(result.duplicate
  ? 'already there - no second card created'
  : 'created the proposal');
console.log(JSON.stringify({
  id: result.item && result.item.id,
  title: result.item && result.item.title,
  startAt: result.item && result.item.startAt,
  classification: result.item && result.item.classification,
  proposalState: result.item && result.item.proposalState,
  personId: result.item && result.item.personId,
}, null, 2));

const state = await post({ action: 'state' });
console.log(`\npending proposals now: ${(state.proposals || []).length}`);
for (const p of state.proposals || []) {
  console.log(`  ${p.title} | ${p.startAt} | ${p.classification} | ${p.proposalState}`);
}
console.log('DONE');
