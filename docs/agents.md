# Agent Team

This repository is worked on by a team of AI agents, each with a defined role.
The team spans **two engines** — work whose output is *thinking* runs on
Claude Managed Agents; work whose output is *a pull request* runs on GitHub
Copilot. You are the gate between them.

## The roles and where each runs

| Role | Engine | Trigger | Output |
|---|---|---|---|
| **Elaborator** | Claude Managed Agents | `elaborate` label on an issue | Sub-issues with acceptance criteria + an audit comment |
| **Architect** | Claude Managed Agents | *(not built yet)* | A technical-approach comment on the issue |
| **Project manager** | Claude Managed Agents | *(not built yet)* — scheduled, Perth time | A backlog status summary |
| **Developer** | GitHub Copilot | Assign the issue to Copilot in the GitHub UI | A branch + pull request |
| **Tester** | GitHub Copilot | Copilot code review on the PR | Review comments on the PR |

Personas live in `.github/agents/*.agent.md`. Those files are **Copilot custom
agent definitions** — they drive the Copilot roles directly. For the Claude
roles they are reference only: the live persona is the `SYSTEM_PROMPT` in that
agent's setup script under `ops/`, and editing the `.agent.md` file does not
change the Claude agent.

> **Naming note.** "GitHub agents" and "Copilot agents" are the same thing.
> GitHub is the platform; Copilot is its AI product. The `.github/agents/`
> folder and the repo's **Agents** tab both refer to Copilot custom agents.

## Why the split

Copilot's coding agent has exactly one output mode: a branch and a pull
request. That is ideal for the developer role and wrong for a business
analyst, who needs to create issues and comment. Claude Managed Agents can
produce whatever the role needs, and additionally supports scheduled runs and
multi-agent orchestration, which Copilot does not.

Cost follows the same logic: Copilot is bundled in the Copilot subscription,
so the code-heavy roles are effectively free, while metered Claude spend stays
on the cheaper thinking roles.

## The flow

1. You add the `elaborate` label to a backlog issue.
2. **Elaborator** audits the codebase, then splits the remaining work into
   sub-issues with checkable acceptance criteria, labelled `role:developer` or
   `role:architect`, and links each as a **native GitHub sub-issue** of the
   parent so the parent shows a real "N of M complete" progress bar. The
   parent stays open as the umbrella and loses its `role:*` label.
3. *(Future)* **Architect** reviews anything labelled `role:architect` and
   posts the technical approach.
4. You assign a sub-issue to **Copilot** — it writes the code and opens a PR.
5. **Copilot code review** checks the PR against the acceptance criteria.
6. You review and merge. Deployment to Azure follows (see issue #29 — still
   manual today).

Handoff between engines is by **label and assignment only** — there is no
integration code between them, and neither engine calls the other.

## Ground rules

- **One issue per Elaborator run**, triggered deliberately. Nothing runs on a
  schedule yet.
- **Agents never merge.** Every code change reaches `main` through a PR you
  approve.
- **Claude agents never get Azure credentials.** They read the repo and write
  GitHub issues; deployment stays outside their reach.
- **Epics are not implementation tasks.** Once elaborated, a parent issue
  should not carry a `role:*` label — the sub-issues do. Assigning an epic to
  Copilot produces sprawling, unreviewable PRs.
- **Sub-issues are linked, not just mentioned.** Use GitHub's native sub-issue
  relationship, not a "Part of #N" line alone — otherwise the parent has no
  progress bar and the backlog flattens out as it grows.
- **A parent closes when its sub-issues are done**, by hand. Nothing closes
  issues automatically, and no workflow moves an epic's board status.

## Where things are documented

| Topic | File |
|---|---|
| Elaborator: setup, cost controls, troubleshooting | `docs/managed-agents.md` |
| Persona definitions | `.github/agents/*.agent.md` |
| Product scope and rules | `docs/mvp-scope-v1.md` |
| Deployment | `docs/deploy-app.md` |

## Status

- ✅ **Elaborator** — live (`docs/managed-agents.md`)
- ⬜ **Architect**, **Project manager** — designed, not built. Deferred until
  the Elaborator's output quality is tuned
- ⬜ **Developer**, **Tester** — personas exist; not yet exercised under this
  model
- ⬜ **Automated Azure deployment** — issue #29, blocks the developer chain
