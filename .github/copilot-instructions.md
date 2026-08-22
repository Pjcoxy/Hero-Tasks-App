# Project: Hero Tasks App

A kids' chore, task, and organization PWA for a small household (1 parent
account, up to 2 kid profiles), gamified, voice-first, deployed on Azure.
See `docs/mvp-scope-v1.md` for the full v1 scope, roles, and non-goals.

## Target architecture (Azure)
- Azure Static Web Apps hosts the frontend (Free tier)
- Azure Functions (Consumption plan) provides the API
- Cosmos DB (free tier) is the data store — households, users, chores,
  rewards, points/XP/streaks, reminders, voice notes, calendar items,
  audit events
- Deployment via GitHub Actions (push-to-deploy from this repo), not by
  hosting the app on GitHub itself
- Usage is extremely low (2 kids), so every design choice should default
  to the free-tier option unless there's a specific reason not to

## Standards
- Use Bicep for all infrastructure, not ARM JSON or manual portal changes
- Prefer Azure Verified Modules (AVM) as the base for any resource module
  where one exists, rather than writing raw resource blocks from scratch
- Keep resource naming consistent: `herotasks-<resource-type>-<env>`
- All secrets (auth, LLM API keys, etc.) go in Azure Key Vault, referenced
  via managed identity — never hardcoded or committed
- Auth should fit a 2-kid household (PIN-based kid access, lightweight
  parent auth) — don't reach for enterprise auth (e.g. full Azure AD B2C)
  unless a specific issue calls for it

## Voice-first requirement (applies to any voice-related issue)
Raw speech-to-text is not sufficient. Any voice-capture feature must:
1. Transcribe speech to text
2. Run an LLM pass to extract/confirm structured intent (what, who, when)
3. Show the interpreted result back to the user for confirmation
4. Fall back to asking clarifying questions on low-confidence input,
   rather than silently saving a guess

## Kid-friendly UX
**Read `docs/design-system.md` before writing any frontend code.** It holds the
actual colour, type, spacing, radius, elevation and motion values, plus
component specs. They are the values to use, not suggestions — do not introduce
your own.

The rules that matter most, in short:

- **Everything is an object.** No text-only actions, no thin borders defining a
  control. Filled pills, cards and round icon buttons. If it does something, it
  looks like it does something.
- **Extend the app shell; never append a section to the page.** New work belongs
  in a view reached by navigation, not stacked at the bottom of `index.html`.
- **Use the tokens.** Every colour, size, radius, shadow and duration comes from
  the `:root` block. `scripts/check-design.js` fails the build on raw values.
- **Respond before the network does.** Every tap gets an immediate pressed state,
  and actions update the UI optimistically rather than waiting on the API.
- **Kid views are playful, Parent HQ is calm.** Same tokens, different register.
  No celebration animations on parent screens.
- **No external requests** for fonts, icons or images. Inline SVG or emoji.
- **Skip decorative motion** under `prefers-reduced-motion`.

Minimal taps to do anything. Both platforms (Android and iOS) via installable
PWA, not native apps.

## Agent workflow
See `docs/agents.md` for the five-agent model. In practice:
- Planning work (`project-manager`, `elaborator`, `architect` write-ups)
  is committed directly — no PR needed, since GitHub's Copilot coding
  agent only has one output mode (a PR with file changes), which is
  unnecessary ceremony for a doc or an issue split.
- Implementation work (`developer`, and verification via `tester`) goes
  through GitHub's Copilot coding agent as a real PR, reviewed by a human
  before merge, since that's actual code/infra changing.

## Non-goals for v1
See `docs/mvp-scope-v1.md` — multi-household support, advanced analytics,
autonomous AI scheduling, third-party integrations, enterprise admin
controls are explicitly out of scope for v1.
