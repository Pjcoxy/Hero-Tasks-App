#!/usr/bin/env python3
"""One-time setup for the Architect managed agent.

Reuses the environment and vault created by the Elaborator's setup (both live
in ops/elaborator/agent_config.json) and creates the Architect agent itself.

Safe to re-run: the agent is updated in place, creating a new version.

Required environment variables:
  ANTHROPIC_API_KEY         - Anthropic API key (platform.claude.com)
  HEROTASK_GITHUB_TOKEN     - fine-grained GitHub PAT for Pjcoxy/Hero-Tasks-App
"""
import json
import os
import sys

import anthropic

REPO = "Pjcoxy/Hero-Tasks-App"
GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/"
HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "agent_config.json")
ELABORATOR_CONFIG = os.path.join(HERE, "..", "elaborator", "agent_config.json")

RESOURCE_NAME = "herotasks-agents"
AGENT_NAME = "HeroTasks Architect"

SYSTEM_PROMPT = f"""\
You are the Architect, a technical design agent for the Hero Tasks App
({REPO}) - a family chore/quest PWA: plain HTML/JS frontend on Azure Static Web
Apps, Node Azure Functions API (api/src/functions/hero.js), Cosmos DB. The
household is Peter (parent), Tymanda, Toby and Ollie. It is a personal family
app, not a product: favour the simplest thing that works over anything built
for scale, and keep to the patterns already in the codebase.

Each session you are given ONE GitHub issue. You decide the technical approach
so a developer agent can implement it without making architectural guesses.
Never write, modify, commit or push code, and never close issues.

Work in this order:

1. Read the issue and ALL its comments using the GitHub tools. Comments often
   carry decisions and forward requirements that are not in the body. Also read
   docs/mvp-scope-v1.md for product rules and docs/agents.md for how the team
   works.

2. READ THE ACTUAL CODE before designing anything. The repository is mounted
   read-only. Study api/src/functions/hero.js (the whole API is one file: the
   ROUTES table, getState, requireParent, the Cosmos access helpers),
   api/src/lib/cosmos.js, frontend/index.html and infra/ for what is already
   provisioned. Existing conventions beat novel ones.

3. Check for FORWARD REQUIREMENTS. Other open issues sometimes state
   constraints that this issue's design must leave room for - a data model that
   must accommodate a later feature, for example. Look for comments headed
   "Forward requirement" on this issue, and check issues this one is related to.
   Honour them; say so explicitly in your write-up.

4. Post ONE comment on the issue titled "## Technical approach", covering:
   - "What already exists" - the relevant current code, with file references,
     and which patterns to follow (name the actual functions).
   - "Proposed approach" - the design in plain terms, then the specifics: data
     shapes with field names, new API actions and their names, where frontend
     changes go. Be concrete enough that a developer does not have to invent
     anything structural.
   - "Alternatives considered" - only where a genuine choice exists, with one
     line on why you rejected each. Skip this section entirely if there was no
     real decision to make; do not manufacture alternatives.
   - "Risks and constraints" - anything that could bite: cost per use, data
     that cannot be migrated later, security or privacy implications, anything
     that will not work offline in the PWA.
   - "Decisions needed from Peter" - ONLY where the choice is genuinely his
     (product policy, spend, privacy). Never ask him to choose between
     technical options you should decide yourself. Omit the section if empty.

5. If an 'architected' label exists in the repository, add it to the issue;
   otherwise skip. Leave the issue open and its other labels alone.

Be decisive: recommend one approach rather than presenting a menu. Keep it
proportionate - a small feature needs a short write-up. Favour the boring
option; this codebase has no build step, no framework and no test runner
beyond a plain node script, and it should stay that way.
"""

TOOLS = [
    {
        "type": "agent_toolset_20260401",
        "default_config": {"enabled": False},
        "configs": [{"name": n, "enabled": True} for n in ("read", "glob", "grep")],
    },
    {
        "type": "mcp_toolset",
        "mcp_server_name": "github",
        "default_config": {"enabled": True, "permission_policy": {"type": "always_allow"}},
    },
]

MCP_SERVERS = [{"type": "url", "name": "github", "url": GITHUB_MCP_URL}]


def find_by(pager, attr, value):
    for item in pager:
        if getattr(item, attr, None) == value:
            return item
    return None


def main():
    client = anthropic.Anthropic()

    cfg = {}
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)

    # Environment and vault are shared with the Elaborator - adopt them rather
    # than creating duplicates.
    if "environment_id" not in cfg or "vault_id" not in cfg:
        shared = {}
        if os.path.exists(ELABORATOR_CONFIG):
            with open(ELABORATOR_CONFIG) as f:
                shared = json.load(f)
        env_id = shared.get("environment_id")
        vault_id = shared.get("vault_id")
        if not env_id:
            env = find_by(client.beta.environments.list(), "name", RESOURCE_NAME)
            env_id = env.id if env else None
        if not vault_id:
            vault = find_by(client.beta.vaults.list(), "display_name", RESOURCE_NAME)
            vault_id = vault.id if vault else None
        if not env_id or not vault_id:
            sys.exit(
                "Could not find the shared environment/vault. Run the Elaborator "
                "setup workflow first - it creates both."
            )
        cfg["environment_id"] = env_id
        cfg["vault_id"] = vault_id
        print(f"Using shared environment {env_id} and vault {vault_id}")

    if "agent_id" not in cfg:
        existing = find_by(client.beta.agents.list(), "name", AGENT_NAME)
        if existing:
            cfg["agent_id"] = existing.id
            print(f"Reusing existing agent {existing.id}")

    agent_kwargs = dict(
        name=AGENT_NAME,
        description=(
            "Technical design agent: reads the Hero Tasks codebase and one issue, then "
            "posts the approach a developer should implement. Design only - never "
            "writes code."
        ),
        # Sonnet 5 at medium effort - design calls for more deliberation than
        # elaboration does, but this is a small codebase with strong existing
        # conventions, so full effort is not warranted.
        model={"id": "claude-sonnet-5", "effort": "medium"},
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
