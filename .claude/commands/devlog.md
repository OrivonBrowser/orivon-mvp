---
description: Compile the weekly Sunday devlog — paste-ready team message + voice-note cues
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git log:*), Bash(git diff:*), Bash(git show:*), Bash(git shortlog:*), Bash(date:*), Bash(ls:*)
---

# /devlog — weekly devlog compiler

Produce the Sunday devlog for the Orivon MVP. Output file: `devlog/updates/YYYY-MM-DD.md`
(today's date). If a file for today already exists, regenerate it in place.

## 1. Determine the period

The period is from the date of the most recent file in `devlog/updates/` (exclusive) to
today. If the directory is empty, use the last 7 days.

## 2. Gather material

- `git log --since=<period start> --date=short --pretty='%ad %h %s'` — commits this period.
- `devlog/journal.md` — the current week's three buckets (Done / In my head / Non-repo).
- Anything changed this period in `docs/decisions/` or `docs/open-questions.md`
  (visible from the git log) — decisions made and questions raised are always devlog-worthy.

## 3. Write `devlog/updates/YYYY-MM-DD.md`

Two sections, in this order.

### Section 1: `## Team message`

A paste-ready block starting with `**Weekly update:**` followed by short bullets. Match
this house style exactly — telegraphic, result-first, no fluff:

```
**Weekly update:**
- Completed the MVP preparation phase: scope, architecture decisions, build plan
- Resolved the three open capability-API defaults (A9)
- Various alignment & ideas calls with JB
```

Rules:
- One bullet per meaningful result or ongoing task, not per commit. Merge related commits.
- Lead with a verb ("Completed", "Started", "Decided", "95% completed").
- Ongoing work is fine: say "Started" or give a % if the journal states one.
- Carry through any `(Keep private)` markers from the journal.
- Include every item from the journal's **Non-repo** bucket. If that bucket is empty,
  append this line *after* the message block (not inside it):
  `> Reminder: add non-repo items (calls, Notion, admin) before sending.`
- 3–8 bullets. If the week was thin, a 2-bullet update is honest and fine — do not pad.

### Section 2: `## Voice note cues`

Bullets the owner will glance at while recording a spontaneous voice note about the
week's thinking. Source: the journal's **In my head** bucket, plus tensions visible in
the repo (new open questions, reversed decisions, scope pressure). Format per bullet:

- **Short hook (3–6 words)** — one sentence of context so the hook is instantly
  recognisable a week later. No scripting, no prose to read aloud; the note is spoken
  freely.

Order them as a narrative arc (what happened first → where the head is now), not by
importance. 3–7 cues.

## 4. Reset the journal

In `devlog/journal.md`: delete the compiled week's section entirely (its content now
lives in the update file) and start a fresh `## Week of <tomorrow's Monday>` heading
with the three empty buckets.

## 5. Report

End by printing the full **Team message** block in chat, ready to copy, followed by a
one-line pointer to the update file for the voice-note cues.
