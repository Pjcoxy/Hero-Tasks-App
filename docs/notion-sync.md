# Notion Sync Contract

This document defines the shape of project updates that a future automation layer can push into Notion.

## Source of truth
- GitHub Issues: backlog and scope
- GitHub Pull Requests: implementation status
- GitHub Actions / releases: delivery events
- Project Manager agent: consolidated status narrative

## Recommended Notion structure
### Page: Project Steering Summary
Fields:
- Project name
- Current milestone
- Delivery status
- Overall health
- Risks
- Blockers
- Next 7 days
- Decisions needed
- Last updated

### Page or database: Weekly Delivery Log
Fields:
- Week ending
- Completed work
- In progress
- Planned next
- Risks
- Dependencies
- Notes for steerco

### Page or database: Release Log
Fields:
- Version
- Release date
- Summary
- Notable changes
- Known issues
- Verification status

## Update owner
- The `project-manager` agent should generate the content.
- A connector or automation layer should write it to Notion.

## Suggested payload format
```json
{
  "project_name": "Hero-Tasks-App",
  "milestone": "MVP foundation",
  "delivery_status": "On track",
  "health": "Green",
  "risks": ["Notion sync not yet wired"],
  "blockers": [],
  "next_7_days": ["Define data model", "Build auth flow"],
  "decisions_needed": ["Choose auth provider"],
  "last_updated": "2026-08-16"
}
```
