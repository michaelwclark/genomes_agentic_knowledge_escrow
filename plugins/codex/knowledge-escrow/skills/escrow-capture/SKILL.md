---
name: escrow-capture
description: File meeting notes, email or Slack threads, or a quick brain-dump into Knowledge Escrow as separate durable memories (decisions, commitments with owner and due date, notes about people, lessons, initiative status). Use when the user pastes notes and says "capture", "file this", "remember this", "log the decisions", or after a meeting.
metadata:
  short-description: Turn notes into durable decisions and action items
---

# Capture

Turn messy notes into small, self-contained memories that future searches will actually find.

## Steps

1. **Read the notes.** Extract only the durable items:
   - **Decisions**: what was decided, by whom, and why.
   - **Commitments**: who owes what, to whom, and by when.
   - **People**: how someone prefers to work, their role, or what they care about. These are notes *about that person*, not about the user.
   - **Initiative status**: blocked, at risk, shipped, or the next step.
   - **Lessons**: what to do differently next time.
   - **The user's own preferences**: only when the user states one about themselves.
   Skip small talk, anything already obvious from Jira or Confluence, and one-off logistics.
2. **Show the list before saving.** Number the items, grouped by type, one line each. Ask "Save these?" and accept edits. If the user said "just save it", skip this step.
3. **Write one memory per item** with the `knowledge_escrow` MCP server's `memory_write` tool (not any other memory tool that may also be available). Make each one stand on its own, since it will be read months later with no context:

| Type | Start content with | `kindHint` | `project` |
|---|---|---|---|
| Decision | `Decision (<date>): <what>. Why: <reason>. Decided by: <who>.` | `FACT` | initiative/topic name |
| Commitment | `Commitment (<date>): <owner> owes <recipient> <deliverable> by <due date>.` | `FACT` | initiative/topic name |
| Person | `Person: <name> — <role/preference/context>.` | `FACT` | — |
| Initiative status | `Status (<date>): <initiative> — <status>. Next: <step>.` | `FACT` | initiative name |
| Lesson | `Lesson: <what to repeat or avoid>.` | `CROSS_FEATURE_LEARNING` | — |
| User's own preference | `Preference: <the user's own preference>.` | `USER_PREF` | — |

   Always use real dates (`2026-10-01`), not "Friday" or "next week". End each memory's content with ` Source: <where it came from>`, for example `meeting: Weekly team sync`, `email`, or `slack #channel`.
4. **Confirm.** Report how many were saved. If any write response includes a `redacted …` warning, mention that sensitive values were removed automatically.

## Rules
- **Never save customer personal data.** That means SSNs, account numbers, dates of birth, and income figures. Describe the situation without the identifiers ("the SSN mismatch on the Acme account"). Automatic redaction is a safety net; don't rely on it.
- Never save passwords, API keys, or tokens.
- Prefer several small memories over one long summary.
- If an item updates an older memory (a new due date, a reversed decision), write the new one and say "supersedes the <date> decision" in the content.
