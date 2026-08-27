# Email import — one-time setup (#41)

The `emailIngest` timer Function reads the family Gmail inbox hourly between
5am and 10pm Perth time, triages every new email, deep-reads the relevant
ones (attachments included), and drops what it finds into the app as
proposals for the kids and parents to act on.

The code ships with the app, but it **does nothing until five app settings
exist** on the Function App. Missing settings = the run logs a skip and
exits; nothing is ever half-configured.

## What Pete does once (~15 minutes)

### 1. Create a Google OAuth client

1. Go to [console.cloud.google.com](https://console.cloud.google.com) →
   your existing project (or make one called `hero-tasks`).
2. **APIs & Services → Library** → search **Gmail API** → Enable.
3. **APIs & Services → OAuth consent screen**: user type **External**,
   fill in the app name (`Hero Tasks`), your email in both contact fields,
   save through the steps. Under **Test users**, add the Gmail address the
   app should read.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   application type **Web application**, name `hero-tasks-gmail`. Under
   **Authorized redirect URIs** add exactly:
   `https://developers.google.com/oauthplayground`
5. Copy the **Client ID** and **Client Secret** it shows you.

### 2. Mint the refresh token (OAuth playground)

1. Go to [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground).
2. Click the ⚙️ gear (top right) → tick **Use your own OAuth credentials**
   → paste the Client ID and Client Secret from step 1.
3. In the left panel, scroll to **Gmail API v1** and tick
   `https://www.googleapis.com/auth/gmail.readonly` (read-only — the app can
   never send, delete, or change anything).
4. Click **Authorize APIs**, sign in with the family Gmail account, allow.
5. Click **Exchange authorization code for tokens**.
6. Copy the **Refresh token** shown. (Ignore the access token — it expires
   in an hour; the refresh token is the one that lasts.)

### 3. Add the app settings

Azure Portal → the Function App (`herotasks-func-dev`) →
**Settings → Environment variables** → add:

| Setting | Value |
|---|---|
| `GMAIL_CLIENT_ID` | from step 1 |
| `GMAIL_CLIENT_SECRET` | from step 1 |
| `GMAIL_REFRESH_TOKEN` | from step 2 |
| `EMAIL_INGEST_KEY` | any long random string (e.g. from a password generator) — it locks the ingest route so only the timer can feed the app |
| `LLM_API_KEY` | already set for voice reminders — check it exists |

Save; the Function App restarts itself.

### 4. Done — what to expect

- Within the hour (5am–10pm Perth), the timer runs. First run reads the
  last 24 hours of mail; after that it picks up from where it left off.
- Kid-choice finds (hikes, camps, discos) ping the kid **and** the parents;
  the kid gets a "want to go?" card, parents get the proposal card and can
  approve over the top at any time.
- Parent-direct finds (fees, forms, purchases) go straight to the parents.
- Informational finds (club newsletters with dates) land directly on the
  calendar with a 📧 mark — no approval step.
- Payment details from emails are **displayed** on the proposal card for
  you to pay manually. Nothing is ever paid automatically.

## Sweeping older mail (first run, or a catch-up)

With no history, a run only looks back 24 hours - which on a quiet day finds
nothing, and "working, nothing to report" looks identical to "broken". To sweep
a few weeks instead, add an app setting:

| Setting | Value |
|---|---|
| `EMAIL_LOOKBACK_DAYS` | e.g. `21` |

The sweep runs **once per value**. After it, the next run goes back to reading
only new mail; change the number (say to `30`) if you want another sweep. It is
left in place safely - it does not re-scan every hour, which would re-read the
same weeks of mail over and over.

Anything already imported comes back as a duplicate rather than a second card,
so a sweep can overlap earlier runs harmlessly. `EMAIL_MAX_MESSAGES` (default
500) caps how many messages one run reads; if a sweep hits the cap, the run
logs that older mail in the window went unread.

## Troubleshooting

- **Nothing appears**: Function App → the `emailIngest` function →
  **Invocations**. A "skipped - missing app settings" line names exactly
  which setting is absent.
- **`Gmail token refresh failed: 400`**: the refresh token was revoked or
  the consent screen is still in "Testing" with the token >7 days old.
  Either publish the consent screen (**OAuth consent screen → Publish
  app**) or re-mint the token (step 2) — published apps' refresh tokens
  do not expire.
- **Same event proposed twice**: only happens if it arrived in two separate
  email threads with different titles. Decline the extra one; declined
  proposals never come back (same thread + same title always dedupes).
- **Pausing the whole thing**: delete the `EMAIL_INGEST_KEY` app setting.
  The timer keeps running but skips harmlessly until you restore it.

## For the agent (how it hangs together)

- `api/src/functions/emailIngest.js` — the timer (NCRONTAB
  `0 0 21-23,0-14 * * *` UTC = hourly 05:00–22:00 Perth; override with the
  `EMAIL_INGEST_SCHEDULE` app setting). Watermark + processed-ids live in a
  `email-ingest-state` doc in the `households` container (read by id only,
  so no household query ever sees it).
- `api/src/lib/gmail.js` — token refresh, message listing/reading,
  attachment fetch, MIME walking. Read-only scope.
- `api/src/lib/emailPipeline.js` — haiku triage, then sonnet extraction
  with attachments as native document/image blocks (xlsx unzipped to text
  via adm-zip). Returns items shaped for `ingestEmailItem`.
- Writes go through `ROUTES.ingestEmailItem` in-process — same idempotency,
  classification behaviour, and pushes as the tested route. `externalRef`
  is `gmail-<threadId>:<title-slug>`, so chase-up emails in the same thread
  dedupe while two events in one email stay distinct.
