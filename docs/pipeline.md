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

**All three are queues.** Adding any of them means *queued*, not *now*. Label
the whole backlog `elaborate` in one go and walk away — they drain one at a
time, oldest first, and the label is removed as each is finished. So the labels
on the board are always the work still outstanding.

### What actually bounds the Anthropic spend

Not the run ceiling — **the labels**. An issue runs once and loses its label, so
the total is (issues you label) × ~$0.35, with a $2 hard cap per session on top.
Labelling is the budget.

The 80-runs ceiling is only there to stop a loop, and it counts *runs*. Keep any
ceiling comfortably clear of however often the workflow fires: a ceiling of 20
against a 5-minute sweep was crossed within two hours and then held forever,
turning the guard itself into the outage.

### Why every trigger has to be a queue

Two GitHub behaviours quietly destroy work, and both bit this repo:

- **The concurrency queue holds exactly one pending run.** Label three issues in
  quick succession and the middle run is **cancelled**, with no error anywhere.
  Runs #4, #5 and #6 of `elaborate.yml` were lost exactly that way.
- **A skipped or guarded run never retries.** #11 was labelled `elaborate`, hit
  the old 4-per-day cap, and simply never ran again — the label sat there
  looking queued while nothing was going to happen.

Reading the queue from the labels rather than from the event fixes both: a
cancelled or guarded run costs nothing, because the work is still sitting there
labelled and the next wake finds it. The event is just a hint to look; the
labels are the truth.

### The build queue

`build` means **queued**, not "build now". `build-queue.yml` picks the next
queued issues and hands them to Copilot, oldest first, waking on any event that
could change what is buildable.

Two reasons it is a queue rather than a direct trigger, both learned the hard
way:

- **Credits are finite and monthly** (~20–28 builds). Labelling four
  sub-issues at once would blow through a daily cap, and a skipped workflow run
  never retries — that work would silently never get built.
- **Sub-issues have dependencies.** Building #34 before #33 lands means Copilot
  writes against an API that does not exist yet, and invents one.

The queue skips anything that is an epic, already assigned to Copilot, or has
an open issue named in a `Depends on #N` line in its body.

**Red CI goes back to Copilot, not to you.** `fix-red-ci.yml` watches for a
failed CI run on a `copilot/` branch and comments on the pull request tagging
`@copilot` with the tail of the failing log. Copilot's agent starts a new
session when someone with write access mentions it on a pull request it wrote,
so it fixes and pushes by itself. The comment comes from the personal token
deliberately — one from `github-actions[bot]` would not reach it.

**Capped at three attempts.** If Copilot cannot fix it in three goes it is not
going to, and each attempt spends credits and can make the diff worse. After
that the pull request is left alone and labelled `needs-human`, which is the
one thing genuinely worth looking at when you come back.

**Staying merge-able.** Before merging, `auto-merge.yml` checks whether the
branch is behind `main` and, if so, updates it and waits for CI to re-run
against the merged result. Between that and building one at a time, a conflict
needing a human should be rare — but if one does appear, GitHub says "This
branch has conflicts that must be resolved" and it will sit there, because
nothing in this pipeline can resolve a conflict.

**It runs on events, not a clock.** The queue wakes whenever something could
have changed what is buildable:

| Event | Why it matters |
|---|---|
| A `build` label is added | That issue may be ready to start immediately |
| A pull request is merged or closed | Whatever depended on it may now be unblocked |
| An issue is closed | Same |

There is no schedule here any more — see **the bot-token trap** above. With
merges made by a real token the events fire, so a chain like #33 → #34 → #35
flows straight through: #33's PR auto-merges, #33 closes, and the queue wakes
within seconds to start #34 and #35.

**One build at a time** (`MAX_PER_RUN=1`), with no daily cap.

Parallel builds look faster and are not. Almost every sub-issue edits
`api/src/functions/hero.js` or `frontend/index.html`, so concurrent Copilot
branches conflict: the first merges, the rest need a human to resolve, and
**auto-merge cannot resolve a conflict** — those pull requests just sit there.
#57 and #58 hit this within minutes of each other and needed a hand-resolved
merge.

Serialising means each build branches off code that already contains the one
before it, so the conflict mostly cannot arise. That is what actually keeps the
pipeline unattended; six at once does not.

**Afterwards, restore the guards:** the daily guard in
`build.yml` back to ~8. Leave the
`elaborate.yml` / `architect.yml` ceilings alone — they are runaway protection,
not a budget, and lowering them below the sweep rate stalls the queue for good
(see below).

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
| Elaborator runs | 80 / rolling 24h | Runaway protection, **not** a budget |
| Architect runs | 80 / rolling 24h | Runaway protection, **not** a budget |
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
  Acting on `opened` instead would mark half-written work ready and merge it.
  `auto-merge.yml` looks for Copilot PRs whose title has lost its `[WIP]`
  prefix, marks them ready and merges them once CI is green.

  It is woken by **CI completing** (`workflow_run`), which is the moment the
  merge gate could newly pass — and by then Copilot has finished and renamed
  the title, because it renames when it stops working while CI is still running
  on its last push. A cron still runs as a backstop, but nothing depends on it;
  see the throttling note below.

  Draft state is **not** part of the filter. It used to require `draft == true`,
  which meant any PR already marked ready — by hand, or by an earlier pass that
  found CI still running — fell out of the candidate set permanently and needed
  a human. Whether it is a draft says nothing about whether Copilot has
  finished; the title does.
- **CI** (`ci.yml`) runs `node api/test-logic.js`, a frontend parse check and a
  workflow-YAML check on every PR. **This is the only automatic check that can
  stop a change reaching the app** — and making that actually true took two
  fixes, both worth knowing about:

  - **CI could not run on agent PRs.** GitHub holds workflow runs on Copilot's
    branches at `action_required` until a maintainer approves, and the approve
    API refuses. So CI only ran on `main` *after* the merge — reporting, not
    gating. Fixed by also triggering on `pull_request_target`, which is not
    subject to that gate. That trigger runs with secrets, so checking out PR
    code under it is normally unsafe; the job is fenced to **same-repo
    branches**, which only someone with write access can push. Fork PRs never
    reach it.
  - **Nothing required the check.** `gh pr merge --auto` merges once the
    *required* checks pass, and with no branch protection nothing is required —
    so it merged immediately regardless. `auto-merge.yml` now enforces the gate
    itself: it merges only when a check run named `test` has actually concluded
    `success` on the pull request's head commit. Red CI leaves the PR open.
- **Copilot's review** (`request-review.yml`) is advisory. It does not block
  anything — read it after the fact, or turn on branch protection if you want
  it to gate.
- **Deployment** (`deploy.yml`) deploys only what changed — API to
  `herotasks-func-dev`, frontend to `herotasks-swa-dev` — on push to `main`.

### The bot-token trap, and why the pipeline has almost no polling

Worth understanding, because it caused the worst bug in this project so far and
it dictates the shape of everything else.

**GitHub raises no workflow events for anything the built-in `GITHUB_TOKEN`
does.** It has to work that way, or a workflow could trigger itself in a loop.

While `auto-merge.yml` merged with that token, an auto-merged PR therefore fired
*nothing*: no `push` (so no deploy), no `pull_request: closed` (so the build
queue never woke), no issue auto-close. #48 and #49 — the Rewards UI — merged
cleanly, sat on `main`, and never reached Azure. GitHub looked perfectly
healthy; the live app just had no Rewards section.

The first fix was polling: every workflow swept on a timer to catch what the
events missed. That worked, but it put GitHub's cron scheduler on the critical
path of everything — the same scheduler the fermenter project deliberately
avoids as unreliable — and it introduced a second bug, where a run-counting
guard counted its own sweeps and stalled the queue permanently.

**The real fix is to merge with a real token.** `auto-merge.yml` uses
`HEROTASK_GITHUB_TOKEN` (Contents: Read and write, Pull requests: Read and
write), so its merges raise events like anyone else's, and every sweep on
`deploy.yml`, `build-queue.yml`, `elaborate.yml` and `architect.yml` was
deleted. Work now moves the instant something unblocks it.

**One timer remains, and it is now only a backstop:**

| Workflow | Why it cannot be an event |
|---|---|
| `auto-merge.yml` (nominally 5 min) | Copilot never signals "finished" — it opens a draft and later just renames the title from `[WIP] …`. There is no event meaning done |
| ~~`approve-agent-workflows.yml`~~ | **Deleted.** It never worked — see below |

### Elaboration is not a build order

The Elaborator used to end with "apply the 'build' label to EVERY sub-issue you
create". That made planning and committing the same act: anything it thought of,
the queue built.

Over one evening that produced calendar views, a schedule-conflict engine with
alternate-slot suggestions, badge gamification and an audit log — while the live
app still had no way to switch users. All three of those areas are named in the
**Non-goals for v1** section of `docs/mvp-scope-v1.md`. Nothing was
malfunctioning: every agent did what it was told, and what it was told had no
word for "not yet".

Two labels now, and the Elaborator must pick one per sub-issue:

- **`build`** — core. Something in the MVP scope or core workflows that is not
  yet built, or a defect stopping the app working. A person cannot do one of the
  things v1 promises until it exists.
- **`enhancement`** — everything else. Still created, still linked to its
  parent, still fully specified. Simply not queued.

The gate is mechanical, not advisory: the build queue only reads `build`. That
matters, because the same lesson has now been learned three times on this
project — the design system held only once CI enforced it, the merge gate held
only once auto-merge checked the check run itself, and scope will hold only
because the queue cannot see `enhancement`.

The Elaborator is also explicitly allowed to **overrule the issue it was given**.
A backlog item can itself be out of scope for v1; when it is, it says so and
labels its sub-issues `enhancement`. It could not do that before, which is the
root of what went wrong — the issues were queued by a human who had not checked
them against the non-goals, and no agent had standing to object.

### Never count workflow runs to measure work

The elaborate/architect queues each had a "runaway guard" that counted workflow
*runs* in a rolling 24 hours. That is the wrong number, and it caused two
separate stalls.

A run that is cancelled by the concurrency group, skipped by a guard, or that
finds an empty queue costs nothing. Counting it the same as a real run means a
sweep on a timer inflates the count until the ceiling is hit — and then the
ceiling holds forever, because the sweeps keep counting. That is what happened
in #59, and it is why every sweep was deleted rather than fixed.

Both guards now count **issues that carry the `elaborated` / `architected`
label and were updated in the last 24 hours**. That is a direct measure of what
actually costs money — the label goes on exactly once per issue — and it is
completely independent of how often the workflow wakes up. Counting the right
thing is what allowed the backstop schedules to be restored.

Both guards also **fail open**: if the count cannot be read, the run proceeds.
A guard that cannot read its own number must never be the thing that stops the
pipeline.

### A count taken at the start of a run is stale by the end of it

Each queue run picked the oldest labelled issue, recorded how many were left,
and used that number at the end to decide whether to dispatch the next run.

A run takes several minutes. Thirteen issues labelled over ninety seconds all
arrived *after* the first run had already counted — so it believed the queue
held one item, skipped the "wake the next one" step, and the chain stopped dead
after a single issue. The label events for the other twelve were cancelled by
the concurrency group, as designed, and nothing ever came back for them. The
comment in the step said the five-minute sweep would catch it; that sweep had
been deleted in #59, so nothing did.

The wake step now **re-reads the queue at the end of the run** instead of
trusting the earlier count.

The general rule, which has now cost three separate stalls: **anything measured
before a long-running step must be measured again after it.**

### GitHub throttles high-frequency cron, so nothing urgent can hang off it

`auto-merge.yml` is written `*/5 * * * *`. It does not run every five minutes.
Measured gaps between consecutive scheduled runs on this repository, over one
morning: **22, 23, 26, 31, 32, 36, 41, 44 and 48 minutes.** Not once did it fire
on time.

That was the whole reason auto-merge looked broken. It was not — it merged #82
correctly — but on the cron path a finished PR could sit for the better part of
an hour, which is long enough that a human watching the repo always merged it
first. The pipeline looked manual because the automation was too slow to get a
turn, not because it was failing.

The lesson generalises: **GitHub's cron is a backstop, never a mechanism.**
Anything that has to happen promptly must hang off an event. For auto-merge that
event is `workflow_run` on CI completing. This is the same unreliability the
fermenter project hit and worked around with an external scheduler.

`deploy.yml` still keeps its own record of what is live — a git tag called
**`deployed`** — and deploys everything changed *since that tag* rather than
since `HEAD^`, moving it only after a successful deploy. So a failed deploy
retries on the next push, and several commits landing together cannot hide each
other.

### Deployment secrets (add these once)

Settings → Secrets and variables → Actions:

| Secret | Where to get it |
|---|---|
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | Portal → `herotasks-swa-dev` → Manage deployment token |
| `AZURE_FUNCTIONAPP_PUBLISH_PROFILE` | Portal → `herotasks-func-dev` → Get publish profile (download, paste the whole XML) |

Until both exist the deploy jobs **skip with a notice** rather than failing —
merges are never blocked by missing credentials, the live app just doesn't
change.

## Design

[`design-system.md`](design-system.md) holds the visual language — the actual
colour, type, spacing, radius, elevation and motion values, plus component specs
for the shell, cards, buttons, the points number, celebrations, empty states and
Parent HQ.

It exists because "make it feel premium" is an adjective, not a specification.
An agent implements a defined thing well and invents a design poorly, so the
values are written down and the work becomes implementation. The Elaborator
reads it on every run and must ground frontend acceptance criteria in it.

`scripts/check-design.js` enforces the mechanical half in CI. It cannot judge
taste — that is what the written component specs are for.

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

## Why there is no auto-approve workflow

GitHub holds workflow runs on Copilot's branches at `action_required` until a
maintainer approves. A workflow was added to clear that automatically, calling
`POST /actions/runs/{id}/approve`. **It never once succeeded**, and the failure
was hidden behind a hand-written message blaming token permissions. Once the
real error was printed it was obvious:

```
This run is not from a fork pull request or queued by the Actions bot
```

That endpoint only approves **fork** pull requests. Copilot's branches live in
this repository, so no permission and no token could ever make it work.

It does not matter, because the gate no longer blocks anything that counts:
`ci.yml` runs via `pull_request_target`, which is not subject to it. The runs
still held at `action_required` on `copilot/` branches are `build-queue` and the
approver itself, neither of which needs to run there.

So the workflow was deleted. The lesson worth keeping: **a hand-written error
message that guesses at the cause is worse than no message at all.** It sent
several rounds of debugging at the token when the endpoint was wrong from the
start.
