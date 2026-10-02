---
name: escrow-meeting-prep
description: Prepare for a meeting using what Knowledge Escrow remembers about the attendees, topics, past decisions, and open commitments, plus any connected calendar, email, Slack, Jira, or Confluence context. Use when the user says "prep me for", "get me ready for", "what do I need to know before" a meeting or call.
metadata:
  short-description: Meeting brief from remembered context
---

# Meeting prep

Give the user a short, skimmable brief so they walk into the meeting already knowing the history.

## Steps

1. **Pin down the meeting.** You need the title or topic, the attendees, and the date. If a calendar app is connected, look it up. Otherwise ask once, in one short question.
2. **Recall from Knowledge Escrow.** Call the `knowledge_escrow` MCP server's `memory_read` tool (not any other memory tool that may also be available) several times with short, focused queries:
   - one per attendee: `"<name>"`, `"<name> preferences"`
   - one per topic or initiative: `"<topic> decision"`, `"<topic> blocked"`
   - `"commitments <attendee or topic>"`, to find promises in either direction
   Use `limit` 5–8. Keep the hits that actually relate; ignore the rest.
3. **Fill gaps from connected apps (optional).** If they're connected, skim:
   - the latest email thread or Slack thread with these people on this topic
   - the related Jira issues: status, blockers
   - the related Confluence page
   Don't go wide. Three to five sources is plenty.
4. **Write the brief.**

```
## <Meeting> — <date>
**Goal:** <one line; ask if unknown>
**People:** <name — role, and how they like to work, if remembered>
**History:** <2–4 bullets: past decisions, with dates>
**Open commitments:** <who owes what to whom, by when>
**Risks / sensitivities:** <blockers, disagreements, things to avoid>
**Suggested asks:** <2–3 questions or decisions to drive>
```

5. **Offer to capture afterwards.** End with: "After the meeting, paste your notes and I'll file the decisions and action items."

## Rules
- Cite where each point came from ("from memory, 09-12", "Jira ACME-123", "Slack #channel"). Never present a guess as remembered fact.
- If memory has nothing on a person or topic, say so plainly. That is useful to know too.
- Never put customer personal data (SSNs, account numbers, dates of birth, and similar) in the brief.
- Keep it under about 250 words unless the user asks for more.
