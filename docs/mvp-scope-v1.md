# Hero Tasks App — MVP Scope and Product Rules (v1)

Closes #1.

## Priority decision
**P0 / first backlog item** — This definition is required before any implementation, architecture, or testing work.

## MVP scope (v1)
- Single household MVP: **1 parent account + up to 2 kid profiles**.
- Parent can create/manage chores, assign chores to kids, review completions, and approve/reject when needed.
- Kid can view assigned chores/reminders, mark chores complete, and see simple progress/history.
- Reminder support includes parent-set reminders and kid voice reminders.

## Roles and product rules
### Parent role
- Creates and manages household + kid profiles.
- Creates/edits chores with due dates and reminder settings.
- Reviews kid-submitted completions and gives approval feedback.

### Kid role
- Can access only their own assigned chores/reminders.
- Can mark chores complete and submit optional voice notes.
- Cannot edit household settings or other kids' data.

## Core workflows
1. Parent creates chore → assigns to kid → sets due date/reminder.
2. Kid receives reminder → completes chore → marks done (optional voice note).
3. Parent reviews completion → approves/rejects → kid sees updated status.
4. Kid records voice reminder/note → transcript is validated and confirmed before save.

## Voice-first goals (v1)
- Capture kid voice input quickly with minimal typing.
- Convert voice to transcript.
- Run **LLM validation** before saving:
  - Clean up transcript wording.
  - Extract/confirm intent (task/reminder/action, who it is for, and timing if present).
  - Detect low-confidence/ambiguous transcript and require user confirmation or edit.
- Save only confirmed, structured content.

## Non-goals for v1
- Multi-household support.
- Advanced analytics/gamification beyond basic progress.
- Fully autonomous AI scheduling or planning.
- Third-party integrations (school systems, calendars, smart home platforms).
- Enterprise-grade org/admin controls.

## Task sequence recommendation
1. #1 Define MVP scope and product rules.
2. #2 Set up repository structure and working conventions.
3. #3 Establish deployment/platform foundation.
4. #4 Define core data model.
5. Continue remaining dependent backlog in order.

## Handoff notes for elaborator
Break this into acceptance criteria for downstream issues:
- Must-have scope list for v1 vs. later-phase items.
- Parent vs kid permissions matrix.
- Detailed workflow acceptance criteria for assignment, completion, and approval.
- Voice pipeline criteria including LLM validation and low-confidence fallback.
- Explicit non-goals section referenced by implementation issues.

## Milestone recommendation
Create milestone **"MVP Foundation"** for initial backlog items covering scope, setup, platform foundation, and first data/workflow slices.
