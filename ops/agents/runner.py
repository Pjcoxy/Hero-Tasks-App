#!/usr/bin/env python3
"""Shared session runner for the Hero Tasks managed agents.

Each agent (elaborator, architect) has its own persona and config file but
runs the same way: create a session against the stored agent, mount the repo
read-only, stream events, and exit non-zero on anything that is not a clean
finish.

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
BUDGET_CENTS = "200"  # $2.00 hard cap per session (a typical run is ~$0.35)
MAX_RUNTIME_SECONDS = 25 * 60


def stop_reason_type(event):
    sr = getattr(event, "stop_reason", None)
    return getattr(sr, "type", sr)


def run(config_path, issue, title_prefix, kickoff_extra=""):
    """Run one agent session against one issue. Exits non-zero on failure."""
    with open(config_path) as f:
        cfg = json.load(f)

    client = anthropic.Anthropic()
    gh_token = os.environ["HEROTASK_GITHUB_TOKEN"]

    session = client.beta.sessions.create(
        agent={"type": "agent", "id": cfg["agent_id"], "version": cfg["agent_version"]},
        environment_id=cfg["environment_id"],
        vault_ids=[cfg["vault_id"]],
        title=f"{title_prefix} - issue #{issue}",
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
        f"Work on GitHub issue #{issue} in Pjcoxy/Hero-Tasks-App. "
        f"The repository is mounted read-only at {MOUNT_PATH}. "
        f"Follow your standing instructions. {kickoff_extra}"
    ).strip()

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
                    # Should not happen: no custom tools, and tools are
                    # always_allow. Report rather than hang to the wall clock.
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
    print(f"\nOutcome: {outcome}; status: {final.status}; list cost: {getattr(usage, 'list_cost', None)}")
    if outcome == "budget_reached":
        sys.exit(
            "Session paused at its budget cap before finishing. "
            "Raise the budget in the Console session view, or review what it produced."
        )
    if outcome in ("timeout", "unknown", "requires_action"):
        sys.exit(1)


def issue_from_argv(usage):
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        sys.exit(usage)
    return int(sys.argv[1])
