# The agent pipeline — how work flows

Four labels drive everything. You add a label; agents do the rest.

```
  backlog issue
       │  add label: elaborate
       ▼
  ELABORATOR (Claude)   → audits the code, writes sub-issues with
       │                   acceptance criteria, links them to the parent
       │  add label: architect   (only where the design isn't obvious)
       ▼
  ARCHITECT (Claude)    → posts "Technical approach" as a comment
       │
       │  add label: build
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
| `build` | **You** — Copilot credits are finite and monthly | ~40–55 credits |

The Elaborator decides the architect question because it has just read the
codebase and the issue, so it is better placed than you are to know whether a
design decision remains. Its criteria are in the `SYSTEM_PROMPT` in
`ops/elaborator/setup_elaborator.py`: new data shapes others build on,
external services, security/privacy/auth, ongoing per-use cost, or a real
choice between approaches the existing code does not already settle. CRUD
following an existing pattern does not qualify. It must say in its comment
which sub-issues it flagged and why, so the call is reviewable.

`build` stays yours deliberately: Copilot credits are the scarce resource
(~20–28 per month), so that is the one place worth a human deciding what is
worth spending them on.

**Never label an epic `build`.** The workflow refuses and says so, but the
rule is: build the sub-issues, not the parent.

## Guards

| Guard | Limit | Why |
|---|---|---|
| Elaborator runs | 10 / rolling 24h | Anthropic spend |
| Architect runs | 10 / rolling 24h | Anthropic spend |
| Copilot builds | 8 / rolling 24h | Copilot credits are finite and monthly |
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
- **CI** (`ci.yml`) runs `node api/test-logic.js` plus a frontend parse check
  on every PR. Red CI blocks the auto-merge; the PR just waits. **This is the
  only automatic check that can stop a change reaching the app.**
- **Copilot's review** (`request-review.yml`) is advisory. It does not block
  anything — read it after the fact, or turn on branch protection if you want
  it to gate.
- **Deployment** (`deploy.yml`) runs on push to `main` and deploys only what
  changed — API to `herotasks-func-dev`, frontend to `herotasks-swa-dev`.

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
