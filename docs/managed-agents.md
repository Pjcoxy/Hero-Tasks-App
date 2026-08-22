# Managed Agents — the Elaborator (phase 1)

This is the start of running the agent team in `docs/agents.md` on **Claude
Managed Agents** instead of GitHub Copilot. Phase 1 wires up the **Elaborator**
only; architect / developer / tester come later once its output is tuned.

## How it works

```
You add "elaborate" label to an issue  (or run the workflow manually)
        │
        ▼
GitHub Action (elaborate.yml)  ── guard: max 4 runs per rolling 24h
        │
        ▼
Anthropic Managed Agents (cloud)
  Agent  = "HeroTasks Elaborator" (persisted config: persona, model, tools)
  Session = one run: sandbox container with this repo mounted read-only,
            GitHub MCP server for issues, hard $5.00 budget cap
        │
        ▼
Output lands on GitHub: sub-issues created + a comment on the original issue
```

Key ideas:

- **Agent vs session.** The agent is created *once* on Anthropic's backend
  (its IDs live in `ops/elaborator/agent_config.json`). Every run is a fresh
  *session* pointing at that agent. Updating the persona = edit
  `setup_elaborator.py` and re-run the setup workflow (it versions the agent
  in place).
- **Audit-first rule.** The Elaborator reads the actual code before writing a
  spec. This is where the cost goes (~165k input tokens a run) and also where
  the value is: it catches work that is already built, corrects wrong
  dependencies, and — the part that matters most — grounds acceptance criteria
  in real function names, so a coding agent can build from them without
  inventing anything structural.
- **One issue per run, confirmed by you.** Nothing runs until you add the
  `elaborate` label (or dispatch manually). That is the per-item confirmation
  gate.

## Cost controls

| Layer | Control |
|---|---|
| Per session | Hard $2.00 budget cap — the session pauses (not fails) if reached |
| Per day | Workflow refuses a 5th run in any rolling 24h window (~$8/day worst case) |
| Per month | Set a workspace spend limit yourself at platform.claude.com → Settings → Limits |

A typical run costs ~$0.35. There is no per-24h dollar cap in the Anthropic
API itself — the runs/day guard × per-run cap is the equivalent, and the
Console monthly limit is the backstop.

**Cost is dominated by input tokens** (~165k per run, from reading the
codebase — the audit is the expensive part and also the valuable part). So the
model's *input* price is the main lever:

| Model | Input $/M | Est. per run |
|---|---|---|
| Claude Opus 5 | $5.00 | ~$1.00 |
| **Claude Sonnet 5** (current, `effort: low`) | $3.00 | **~$0.35** |
| Claude Haiku 4.5 | $1.00 | ~$0.20 (no `effort` support — it errors) |

Change the model in `ops/elaborator/setup_elaborator.py` and re-run the setup
workflow. Raise it again if the audits start missing things.

Times/quotas use a **rolling 24h window** (timezone-proof); any future
scheduled sweep should be created with `timezone: "Australia/Perth"`.

## One-time setup (Peter)

1. **Anthropic API key** — at [platform.claude.com](https://platform.claude.com):
   sign in → API keys → Create key, named `herotasks-agents` (that label is
   Anthropic-side only — it is how you spot this project's spend in the key
   list). Make sure billing has credit.
2. **GitHub token** — GitHub → Settings → Developer settings →
   Fine-grained personal access tokens → Generate new token, named
   `herotasks-agents`:
   - Repository access: *Only select repositories* → `Hero-Tasks-App`
   - Permissions: **Contents: Read-only**, **Issues: Read and write**,
     **Metadata: Read-only** (auto-selected)
3. **Add both as repo secrets** — Hero-Tasks-App → Settings → Secrets and
   variables → Actions → New repository secret:
   - `HEROTASK_ANTHROPIC_KEY`
   - `HEROTASK_GITHUB_TOKEN`
4. **Run setup** — Actions tab → *Elaborator — one-time setup* → Run
   workflow. It creates the agent/environment/vault and commits their IDs to
   `ops/elaborator/agent_config.json`.
5. **Create the `elaborate` label** (once) — Issues → Labels → New label →
   `elaborate`. Optionally also `elaborated` (the agent tags finished issues
   with it if it exists).

## Running it

- **First run (agreed): issue #10 Rewards system.** Actions tab → *Elaborate
  backlog issue* → Run workflow → issue number `10`. Or just add the
  `elaborate` label to #10.
- Watch it live: the workflow log prints a `platform.claude.com/...` session
  URL showing every tool call and message as it happens.
- The result appears on the issue itself: an audit comment + linked
  sub-issues.

Each subsequent issue: add the `elaborate` label when you're happy to spend a
run on it.

## If something goes wrong

- **Workflow fails fast with an auth error** — check the two repo secrets.
- **Session pauses at its budget** — the workflow log says so; open the
  Console session link, review, and raise the budget there to let it finish.
- **"Daily limit of 4 elaborator runs reached"** — wait, or raise the number
  in `.github/workflows/elaborate.yml`.
- **Agent behaves oddly** — its persona is the `SYSTEM_PROMPT` in
  `ops/elaborator/setup_elaborator.py`; edit, then re-run the setup workflow.
- **Session sits `Idle` doing nothing** — open the Console session link and
  scroll to the end of the transcript. Unanswered **Approve / Deny** buttons
  mean it is parked waiting for a human; the **Tools** panel shows which tool
  is set to *Ask*. Tools are configured `always_allow` so this should not
  happen — if it does, the tool policy in `setup_elaborator.py` has drifted.
  The run itself now reports this and exits rather than hanging.

### Reading a session in the Console

1. The status pill beside the session title: **Running** (working), **Idle**
   (stopped — finished *or* blocked), **Terminated** (ended).
2. End of the transcript: buttons = blocked on you; plain text = finished.
3. **Tools** panel: per-tool permission, call counts, failures. The Overview
   box at the bottom (`Completed` vs `In flight`) tells you whether work is
   actually progressing.
4. **Events** tab: the raw event stream, when the transcript is ambiguous.
5. The cost figure beside the title (e.g. `US$0.17 / US$2.00`) is spend
   against the session budget.

## Phase 2+ (not built yet)

- Architect / developer / tester as rostered agents under a coordinator
  (multiagent sessions — they share the sandbox, developer opens PRs).
- An approval gate: elaboration posted → you add `approved` → build chain runs.
- Optional Perth-time nightly sweep as an Anthropic scheduled deployment.
