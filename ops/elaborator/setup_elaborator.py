#!/usr/bin/env python3
"""One-time setup for the Elaborator managed agent.

Creates (or updates) the Anthropic-hosted resources the Elaborator needs:
  - an Environment (the cloud sandbox template)
  - a Vault holding the GitHub token for the GitHub MCP server
  - the Elaborator Agent itself (persona, model, tools)

Safe to re-run: existing resources are reused from agent_config.json and the
agent definition is updated in place (creating a new immutable version).

Required environment variables:
  ANTHROPIC_API_KEY         - Anthropic API key (platform.claude.com)
  HEROTASK_GITHUB_TOKEN     - fine-grained GitHub PAT for Pjcoxy/Hero-Tasks-App
                              (Contents: read, Issues: read+write, Metadata: read)
"""
import json
import os
import sys

import anthropic

REPO = "Pjcoxy/Hero-Tasks-App"
GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/"
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_config.json")

SYSTEM_PROMPT = f"""\
You are the Elaborator, a business-analyst planning agent for the Hero Tasks App
({REPO}) - a family chore/quest PWA: plain HTML/JS frontend on Azure Static Web
Apps, Node Azure Functions API, Cosmos DB. The household is Peter (parent),
Tymanda, Toby and Ollie.

Each session you are given ONE GitHub issue number to elaborate. Your job is
planning and elaboration only. Never write, modify, commit or push code, and
never close issues.

Work in this order:

1. Read the issue and its comments using the GitHub tools. Also read
   docs/mvp-scope-v1.md in the mounted repository for product rules.

2. AUDIT THE CODE FIRST. The repository is mounted read-only in your sandbox.
   The backlog is known to be stale relative to the code: several open issues
   describe features that are already partly or fully built. Read the real
   code (frontend/index.html, api/src/functions/hero.js, api/src/lib/) and
   establish exactly which parts of the issue already exist. Never spec work
   that is already built.

3. Produce the elaboration:
   - "Already built" - what exists today, with file references. May be empty.
   - Split the REMAINING work into 2-4 sub-issues, each independently
     completable and reviewable, each with: a clear specific title; a short
     background/context section; explicit, checkable acceptance criteria
     (concrete enough that a developer agent knows exactly what "done" looks
     like); and dependencies noted (e.g. "depends on #4"). Start each body
     with "Part of #<original issue number>".
   - List any open product questions for Peter where a decision is genuinely
     ambiguous - do not guess product policy.

4. Create each sub-issue via the GitHub tools. Reuse the repository's existing
   labels (role:developer, role:architect) where they fit; if a label does not
   exist, skip labelling rather than failing.

5. Comment once on the original issue with: the already-built audit summary,
   links to every sub-issue you created, and the open questions. If an
   'elaborated' label exists in the repository, add it to the original issue;
   otherwise skip. Leave the original issue open.

Be decisive and finish in a single pass. Keep sub-issue count and wording lean:
quality of acceptance criteria over volume of prose.
"""

TOOLS = [
    {
        "type": "agent_toolset_20260401",
        "default_config": {"enabled": False},
        "configs": [{"name": n, "enabled": True} for n in ("read", "glob", "grep")],
    },
    {"type": "mcp_toolset", "mcp_server_name": "github"},
]

MCP_SERVERS = [{"type": "url", "name": "github", "url": GITHUB_MCP_URL}]


def main():
    client = anthropic.Anthropic()

    cfg = {}
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)

    if "environment_id" not in cfg:
        env = client.beta.environments.create(
            name="herotasks-agents",
            config={"type": "cloud", "networking": {"type": "unrestricted"}},
        )
        cfg["environment_id"] = env.id
        print(f"Created environment {env.id}")

    if "vault_id" not in cfg:
        gh_token = os.environ.get("HEROTASK_GITHUB_TOKEN")
        if not gh_token:
            sys.exit("HEROTASK_GITHUB_TOKEN is not set - cannot create the vault credential.")
        vault = client.beta.vaults.create(name="herotasks-agents")
        cfg["vault_id"] = vault.id
        client.beta.vaults.credentials.create(
            vault_id=vault.id,
            display_name="GitHub MCP (Hero-Tasks-App)",
            auth={
                "type": "static_bearer",
                "mcp_server_url": GITHUB_MCP_URL,
                "token": gh_token,
            },
        )
        print(f"Created vault {vault.id} with GitHub MCP credential")

    agent_kwargs = dict(
        name="HeroTasks Elaborator",
        description=(
            "Business-analyst agent: audits the Hero Tasks codebase, then breaks one "
            "backlog issue into small sub-issues with checkable acceptance criteria. "
            "Planning only - never writes code."
        ),
        model="claude-opus-5",
        system=SYSTEM_PROMPT,
        tools=TOOLS,
        mcp_servers=MCP_SERVERS,
    )
    if "agent_id" not in cfg:
        agent = client.beta.agents.create(**agent_kwargs)
        print(f"Created agent {agent.id} v{agent.version}")
    else:
        agent = client.beta.agents.update(agent_id=cfg["agent_id"], **agent_kwargs)
        print(f"Updated agent {agent.id} to v{agent.version}")
    cfg["agent_id"] = agent.id
    cfg["agent_version"] = agent.version

    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    print(f"Wrote {CONFIG_PATH}:")
    print(json.dumps(cfg, indent=2))


if __name__ == "__main__":
    main()
