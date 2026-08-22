# The agent pipeline — how work flows

Four labels drive everything. You add a label; agents do the rest.

```
  backlog issue
       │  YOU add label: elaborate     <- the only click
       ▼
  ELABORATOR (Claude)   → audits the code, writes sub-issues with
       │                   acceptance criteria, links them to the parent
       │  Elaborator adds 'architect' where design is genuinely needed,
       │  and 'build' on every sub-issue (which queues, does not start)
       ▼
  ARCHITECT (Claude)    → posts "Technical approach" as a comment
       │
       │  BUILD QUEUE wakes on merges and labels, oldest first,
       │  skipping epics and anything with an open dependency
       ▼
  DEVELOPER (Copilot)   → branch + pull request
       │
       ├── TESTER (Copilot review)  → comments on the diff
       │       ADVISORY ONLY - does not block the merge
       │
       ├── CI (ci.yml)              → API tests + frontend checks
       │       THE ACTUAL GATE - red CI stops the merge
       │
       └── auto-merge once CI is green
       │
       ▼
  DEPLOY → Azure (Function App and/or Static Web App, whichever changed)
```

> **Which of those two actually stops a bad change?** Only CI. Copilot's review
> posts comments and the merge proceeds regardless — so on a fast PR the review
> may land *after* it has merged. Treat it as a record to read, not a gate.
>
> To make it a real gate, require an approving review on `main` (Settings →
> Branches → branch protection). Expect that to stall most PRs waiting on you,
> since the reviewer usually finds *something* — which is why it is off.

## The four labels

| Label | What happens | Cost |
|---|---|---|
| `elaborate` | Elaborator breaks the issue into sub-issues | ~$0.35 |
| `architect` | Architect posts a technical approach | ~$0.50 |
| `build` | Copilot writes the code and opens a PR | ~40–55 Copilot credits |
| `elaborated` / `architected` | Applied *by* the agents — markers, not triggers | — |

The tester needs no label: Copilot's review is requested automatically on every
agent-authored PR (`request-review.yml`).

**`architect` is applied for you** by the Elaborator where a genuine technical
choice exists. CRUD-shaped work goes straight from `elaborate` to `build`. You
can still add it by hand to any issue — the older backlog items that predate
this (#12, #15, #16, #21, #5, #43) need it applied manually.

### Label kinds

Every label in this repo is one of three things. Keeping the distinction sharp
matters, because two of them cost money and one does not.

| Kind | Labels | Effect |
|---|---|---|
| **Trigger** | `elaborate`, `architect`, `build` | Live wire — adding it starts an agent and spends |
| **Marker** | `elaborated`, `architected` | Applied *by* an agent; records what has been done |

Every label is live. `role:developer` and `role:tester` were deleted (every
sub-issue is developer work by default, and the tester runs automatically on
every PR), and `role:architect` was replaced by the Elaborator applying
`architect` itself.

### Who applies which trigger

| Trigger | Applied by | Spends |
|---|---|---|
| `elaborate` | **You** — deciding an item is worth working on | ~$0.35 |
| `architect` | **The Elaborator**, on sub-issues it judges need design | ~$0.50 each |
| `build` | **The Elaborator**, on every sub-issue — but it *queues* rather than builds | ~40–55 credits, when the queue reaches it |

### The build queue

`build` means **queued**, not "build now". A scheduled worker
(`build-queue.yml`, every 6 hours) picks the next queued issue and hands it to
Copilot — one at a time, oldest first.

Two reasons it is a queue rather than a direct trigger, both learned the hard
way:

- **Credits are finite and monthly** (~20–28 builds). Labelling four
  sub-issues at once would blow through a daily cap, and a skipped workflow run
  never retries — that work would silently never get built.
- **Sub-issues have dependencies.** Building #34 before #33 lands means Copilot
  writes against an API that does not exist yet, and invents one.

The queue skips anything that is an epic, already assigned to Copilot, or has
an open issue named in a `Depends on #N` line in its body.

**It runs on events, not a clock.** The queue wakes whenever something could
have changed what is buildable:

| Event | Why it matters |
|---|---|
| A `build` label is added | That issue may be ready to start immediately |
| A pull request is merged or closed | Whatever depended on it may now be unblocked |
| An issue is closed | Same |
| Hourly schedule | Safety net only, for events that get missed |

So a chain like #33 → #34 → #35 flows straight through: #33's PR merges, #33
closes, the queue wakes within seconds and starts #34 and #35 — no waiting for
a timer.

**Up to 6 start at once** (`MAX_PER_RUN` in the workflow), with no daily cap.
Deliberate for the initial build-out: the Copilot credit budget is the real
limit, it fails safe, and a second ceiling underneath it only stalls the run.

**Afterwards, restore the guards:** `MAX_PER_RUN=1`, the daily guard in
`build.yml` back to ~8, the guards in `elaborate.yml` / `architect.yml` back to
~10, and disable the auto-approve workflow.

**The dependency check is not a pacing device** and stays whatever the speed:
it stops Copilot writing against code that does not exist yet.

To jump the queue for one issue: Actions → *Build an issue with Copilot* → Run
workflow → issue number.

The Elaborator decides the architect question because it has just read the
codebase and the issue, so it is better placed than you are to know whether a
design decision remains. Its criteria are in the `SYSTEM_PROMPT` in
`ops/elaborator/setup_elaborator.py`: new data shapes others build on,
external services, security/privacy/auth, ongoing per-use cost, or a real
choice between approaches the existing code does not already settle. CRUD
following an existing pattern does not qualify. It must say in its comment
which sub-issues it flagged and why, so the call is reviewable.

Nothing needs a click from you after `elaborate`: the Elaborator queues the
work and decides what needs design, and the queue paces the spend. Your control
is the pace (the cron), the daily caps, and removing `build` from anything you
do not want built.

**Never label an epic `build`.** The workflow refuses and says so, but the
rule is: build the sub-issues, not the parent.

## Guards

| Guard | Limit | Why |
|---|---|---|
| Elaborator runs | 20 / rolling 24h | Anthropic spend |
| Architect runs | 20 / rolling 24h | Anthropic spend |
| Copilot builds | 6 at a time via the queue; **no daily cap during the build-out** | The Copilot credit budget is the real limit and fails safe on its own |

> Those numbers are raised for the initial build-out. See *The build queue*
> below for what to set them back to afterwards.
| Per session | $2.00 hard cap | A runaway session pauses rather than spends |
| Epic guard | build refuses issues with sub-issues | Prevents unreviewable PRs |

Copilot credits are the real constraint: **1,500/month, ~40–55 per build**, so
roughly 20–28 builds per month. Elaboration is cheap and unmetered by
comparison — elaborate freely, build selectively. Check usage at
[github.com/settings/copilot](https://github.com/settings/copilot); overage is
disabled, so it hard-stops rather than billing you.

## What merges, and what deploys

- **Copilot's PRs auto-merge** once CI passes (`auto-merge.yml`). Your own PRs
  do not — you merge those.
- **Copilot opens its PRs as drafts** and works for several minutes, then just
  renames the title from `[WIP] …` and stops. It never fires a
  `ready_for_review` event, so there is no "finished" signal to react to.
  `auto-merge.yml` therefore polls every 5 minutes for Copilot drafts whose
  title has lost its `[WIP]` prefix, marks those ready and enables auto-merge.
  Acting on `opened` instead would mark half-written work ready and merge it.
- **CI** (`ci.yml`) runs `node api/test-logic.js` plus a frontend parse check
  on every PR. Red CI blocks the auto-merge; the PR just waits. **This is the
  only automatic check that can stop a change reaching the app.**
- **Copilot's review** (`request-review.yml`) is advisory. It does not block
  anything — read it after the fact, or turn on branch protection if you want
  it to gate.
- **Deployment** (`deploy.yml`) deploys only what changed — API to
  `herotasks-func-dev`, frontend to `herotasks-swa-dev`. It runs on push to
  `main`, **and sweeps every 5 minutes** for anything merged that the push
  event missed. See below for why that sweep is not optional.

### Why deployment needs a sweep as well as a push trigger

When `auto-merge.yml` merges a Copilot PR it acts as `github-actions[bot]`,
using the built-in `GITHUB_TOKEN`. GitHub deliberately raises **no workflow
events** for anything that token does — otherwise a workflow could trigger
itself in a loop. So an auto-merged PR lands on `main` and **no deploy run
fires at all**.

This bit us for real: #48 and #49 (the Rewards UI) merged cleanly, sat on
`main`, and never reached Azure. The dashboard looked correct on GitHub and the
live app had no Rewards section.

So `deploy.yml` keeps its own record of what is live — a git tag called
**`deployed`** — and each run deploys everything changed *since that tag*,
moving it forward only after a successful deploy. That means:

- a failed deploy leaves the tag behind and the next sweep retries it;
- a merge that fired no push event is picked up within 5 minutes;
- the diff is against what is actually on Azure, not against `HEAD^`, so
  nothing gets skipped when several commits land together.

Worst-case lag between an auto-merge and the live app is about 10 minutes
(5 for the merge poll, 5 for the deploy sweep). If you ever want it instant,
give `HEROTASK_GITHUB_TOKEN` **Contents: Read and write** and **Pull requests:
Read and write** and use it in `auto-merge.yml` — merges by a real token do
raise events. The sweep exists so that is a nice-to-have rather than a
requirement.

### Deployment secrets (add these once)

Settings → Secrets and variables → Actions:

| Secret | Where to get it |
|---|---|
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | Portal → `herotasks-swa-dev` → Manage deployment token |
| `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` | Portal → `herotasks-func-dev` → Get publish profile (download, paste the whole XML) |

Until both exist the deploy jobs **skip with a notice** rather than failing —
merges are never blocked by missing credentials, the live app just doesn't
change.

## Setting up the agents (one-time)

1. *Elaborator — one-time setup* (Actions tab) — creates the environment,
   vault and Elaborator agent
2. *Architect — one-time setup* — reuses that environment and vault, creates
   the Architect agent
3. Create the labels: `architect`, `build`, `architected` (you already have
   `elaborate` and `elaborated`)

Re-run either setup workflow after editing a persona; agents version in place.

## Turning it off

- **One issue** — remove its label before the run starts, or close the PR
- **Auto-merge only** — disable `auto-merge.yml` in the Actions tab
- **Everything** — disable the workflows, or remove the
  `HEROTASK_ANTHROPIC_KEY` secret (Anthropic agents stop immediately; Copilot
  builds are unaffected)
