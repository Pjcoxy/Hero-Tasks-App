#!/usr/bin/env python3
"""Run the Elaborator managed agent on one backlog issue.

Usage: python run_elaborator.py <issue_number>

Creates a fresh session against the stored agent (see agent_config.json,
produced by setup_elaborator.py), with:
  - the Hero-Tasks-App repository mounted read-only in the sandbox
  - the GitHub MCP vault attached (so it can read/comment/create issues)
  - a hard $5.00 budget cap - the session pauses if it hits the cap

Required environment variables:
  ANTHROPIC_API_KEY
  HEROTASK_GITHUB_TOKEN
"""
import json
import os
import sys
import time

import anthropic

REPO_URL = "https://github.com/Pjcoxy/Hero-Tasks-App"
MOUNT_PATH = "/workspace/hero-tasks-app"
BUDGET_CENTS = "500"  # $5.00 hard cap per session
MAX_RUNTIME_SECONDS = 25 * 60
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_config.json")


def stop_reason_type(event):
    sr = getattr(event, "stop_reason", None)
    return getattr(sr, "type", sr)


def main():
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        sys.exit("Usage: python run_elaborator.py <issue_number>")
    issue = int(sys.argv[1])

    with open(CONFIG_PATH) as f:
        cfg = json.load(f)

    client = anthropic.Anthropic()
    gh_token = os.environ["HEROTASK_GITHUB_TOKEN"]

    session = client.beta.sessions.create(
        agent={"type": "agent", "id": cfg["agent_id"], "version": cfg["agent_version"]},
        environment_id=cfg["environment_id"],
        vault_ids=[cfg["vault_id"]],
        title=f"Elaborator - issue #{issue}",
        budget={"type": "limit", "max_list_cost": {"amount": BUDGET_CENTS, "currency": "USD"}},
        resources=[
            {
                "type": "github_repository",
                "url": REPO_URL,
                "mount_path": MOUNT_PATH,
                "authorization_token": gh_token,
            }
        ],
    )
    print(f"Session: {session.id}")
    print(f"Watch live: https://platform.claude.com/workspaces/default/sessions/{session.id}")

    kickoff = (
        f"Elaborate GitHub issue #{issue} in Pjcoxy/Hero-Tasks-App. "
        f"The repository is mounted read-only at {MOUNT_PATH}. "
        "Follow your standing instructions: audit the code first, then post the elaboration."
    )

    deadline = time.monotonic() + MAX_RUNTIME_SECONDS
    outcome = "unknown"
    # Stream-first: open the stream, then send the kickoff while it is live.
    with client.beta.sessions.events.stream(session_id=session.id) as stream:
        client.beta.sessions.events.send(
            session_id=session.id,
            events=[{"type": "user.message", "content": [{"type": "text", "text": kickoff}]}],
        )
        for event in stream:
            if time.monotonic() > deadline:
                outcome = "timeout"
                print("\n!! Hit local wall-clock limit; leaving the session as-is. Check the Console link.")
                break
            etype = event.type
            if etype == "agent.message":
                for block in event.content:
                    if getattr(block, "type", None) == "text":
                        print(block.text, flush=True)
            elif etype == "session.error":
                print(f"!! session.error: {event}", flush=True)
            elif etype == "session.status_idle":
                sr = stop_reason_type(event)
                if sr == "requires_action":
                    # Should not happen: the agent has no custom tools and its
                    # tools are always_allow. If it does, the session is parked
                    # waiting for a human - say so rather than hanging until the
                    # wall-clock limit.
                    outcome = "requires_action"
                    print(
                        "\n!! The agent is waiting for tool approval and this run cannot answer it.\n"
                        "   Approve it in the Console link above, or check the agent's tool "
                        "permission policy.",
                        flush=True,
                    )
                    break
                outcome = "budget_reached" if sr == "budget_reached" else "done"
                break
            elif etype == "session.status_terminated":
                outcome = "terminated"
                break

    final = client.beta.sessions.retrieve(session_id=session.id)
    usage = getattr(final, "usage", None)
    cost = getattr(usage, "list_cost", None)
    print(f"\nOutcome: {outcome}; session status: {final.status}; list cost: {cost}")
    if outcome == "budget_reached":
        sys.exit(
            "Session paused at its $5 budget cap before finishing. "
            "Raise the budget in the Console session view to let it finish, or review what it produced."
        )
    if outcome in ("timeout", "unknown", "requires_action"):
        sys.exit(1)


if __name__ == "__main__":
    main()
