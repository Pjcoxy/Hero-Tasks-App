# Claude Code Agent Guidance — Hero Tasks

Instructions for Claude (AI agent) working on this project. This file is also
Pete's reusable template for how he wants to build software with Claude: copy
it to a new repo, change the "Project context" section, keep the rest.

## User profile

- **Owner:** Pete Cox (`Pjcoxy`) — non-technical, hands-off. He describes what
  he wants (often as a screenshot with a circle on it, or a terse message with
  typos) and expects the finished thing, live, without back-and-forth.
- **Family:** Peter, Tymanda (parents), Toby, Ollie (kids). Times are always
  **Australia/Perth**.
- **Communication:** direct and concise. Confirm what changed and that it's
  live. Don't over-explain. Clarifying questions are rare and only when
  genuinely ambiguous — offer options ("Should I A or B?"), one at a time.

## Project context

- Kids' chore and family-organisation PWA on Azure: Static Web App frontend
  (one HTML file, no build step), Azure Functions API (`api/src/functions/hero.js`),
  Cosmos DB, managed identity everywhere, web push.
- Design rules live in `docs/design-system.md` and are enforced by
  `scripts/check-design.js`. "Appy not wordy": pills and chips, not sentences.
- Scope discipline: build what Pete asked, flag what's coming (e.g. #41 Gmail
  import is designed and parked — do not start it unless he says go).
  "Stop scope creeping before we've built basics" is a direct quote.

## The delivery loop (every change)

1. **Issue first.** Open a GitHub issue for the request before coding:
   a `> **User story**` blockquote at the top (plain language, the repo
   convention), then what's being built and how it'll be verified. Quality
   without ceremony — a few lines, not a spec. Related small fixes from one
   conversation can share one feature-track issue.
2. **Branch** from latest `main` (`claude/<short-name>`).
3. **Build small.** Only what the request needs. Match existing code style.
   No abstractions for the future, no refactors of working code.
4. **Verify locally before pushing** — all of:
   - `node api/test-logic.js`
   - `node scripts/check-frontend.js` (frontend parses + behaviours)
   - `node scripts/check-design.js` (design tokens, no external assets)
   - the full Playwright smoke suite in `tests/smoke/`
5. **PR** with a full write-up: the user story / Pete's ask, what changed and
   why, what was tested. PRs auto-merge culture: **squash-merge as soon as CI
   is green** — Pete has explicitly said he wants auto-merge, do not hold PRs
   for review.
6. **Verify the deploy, not the green tick.** After merge, check the "Deploy
   to Azure" run's actual job steps ("Deploy to Static Web App" / "Deploy to
   Function App") succeeded AND that the `deployed` git tag moved to the merge
   commit. Only then tell Pete it's live.
7. **Close the issue** as completed, referencing the PR.
8. **Update docs in the same PR** when behaviour, config or conventions
   change — `docs/design-system.md` for UI/UX rules, `docs/pipeline.md` for
   process. Never leave docs behind the code.

## Standing agreements and hard-won rules

- **Auto-merge is wanted.** Never ask permission to merge a green PR.
- **Screenshots are bug reports.** Each one gets investigated and usually
  produces a PR; answer the question in it AND fix the thing.
- **Questions get answers, not commits.** When Pete asks "how does X work?",
  read the code and explain simply; only change things when he asks.
- **Times:** all reasoning, seeds and tests in Perth local time. The app's
  timezone handling is `HOUSEHOLD_TZ` in `hero.js` — never format dates with
  UTC getters.
- **Windows model:** hard close (no reopening a missed window); kid must
  submit before close, parent approval is not time-bound; points sit on the
  work and are parent-priced.
- **Live-app operations** (seeding, wiping data) cannot run from the dev
  container — its egress policy blocks `azurewebsites.net`. Run them via
  dispatch-only GitHub Actions workflows (`seed-demo.yml` is the pattern).
- **Agents hold no Azure credentials.** Infra code is written by agents,
  deployed by Pete. Flag exposed secrets to Pete; don't rotate them yourself.
- **Don't queue the label-driven Copilot build pipeline** for chat work — it
  spends money. Chat-driven work goes straight through the loop above.
- **Tests earn their keep.** Compute expectations from the same rules the
  server enforces (a hardcoded "6 occurrences" broke on a Tuesday). Never
  format "now" the same way the code under test does — two matching mistakes
  cancel out. Tolerances follow the design system (spacing < 4px is rounding).
- **No model names in artifacts.** Commit messages, PR bodies and code carry
  no Claude model identifiers; attribution is `Co-Authored-By: Claude`.

## Ways this can go wrong (and what to do)

- **Breakage Pete reports:** find the commit, fix forward with a new PR,
  document the lesson in the relevant doc.
- **Flaky CI:** a failure is assumed real; re-run at most once and only to
  confirm an identical unrelated error. Never skip or quarantine a test.
- **Docs out of sync:** code is the truth; update the doc to match.
