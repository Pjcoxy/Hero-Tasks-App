#!/usr/bin/env python3
"""Run the Architect managed agent on one issue.

Usage: python run_architect.py <issue_number>

See ops/agents/runner.py for the session mechanics, and
ops/architect/setup_architect.py for the agent's persona.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "agents"))
import runner  # noqa: E402

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_config.json")

if __name__ == "__main__":
    issue = runner.issue_from_argv("Usage: python run_architect.py <issue_number>")
    runner.run(
        CONFIG_PATH,
        issue,
        "Architect",
        "Read the code and the issue, then post the technical approach as a comment.",
    )
