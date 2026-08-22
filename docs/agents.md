# Agent Team

> **Update:** the team is moving to Claude Managed Agents, starting with the
> Elaborator — see [`managed-agents.md`](managed-agents.md). The role
> definitions below still describe each agent's job; the "working model"
> section reflects the earlier Copilot-based approach.

This repository is designed to be worked on with GitHub-based agents,
defined in `.github/agents/*.agent.md`:

- [`architect`](../.github/agents/architect.agent.md)
- [`elaborator`](../.github/agents/elaborator.agent.md)
- [`project-manager`](../.github/agents/project-manager.agent.md)
- [`tester`](../.github/agents/tester.agent.md)
- [`developer`](../.github/agents/developer.agent.md)

## How they work
1. `project-manager` selects and sequences backlog work.
2. `elaborator` expands an issue into an actionable spec, splitting broad
   issues into smaller ones.
3. `architect` validates the technical approach and system design.
4. `developer` implements the change.
5. `tester` verifies the result against acceptance criteria.

## Working model (important)
GitHub's Copilot coding agent only has one output mode: a branch + a pull
request with file changes. There is no "just leave a comment" or "just
create issues" mode, regardless of which custom agent persona is used.

So in practice:
- **Planning work** (`project-manager`, `elaborator`, `architect`
  write-ups, splitting issues, docs) happens as direct commits/issues on
  `main` — no PR needed, since there's no code being reviewed.
- **Implementation work** (`developer`; verification via `tester`) is
  assigned to GitHub's Copilot coding agent, which opens a real PR for
  human review before merge — appropriate since actual code/infra is
  changing.

## Suggested repo workflow
- Track work in GitHub Issues (see `.github/ISSUE_TEMPLATE/feature.md`).
- Small, focused PRs for implementation work.
- Keep the repo usable entirely from GitHub web/mobile if desired.
- Deploy from GitHub to Azure via GitHub Actions.
