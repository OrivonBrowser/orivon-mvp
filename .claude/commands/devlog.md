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

**Two rules that override everything below. Both are owner corrections from 2026-09-01,
after a first compile got both wrong.**

**A. The audience is the marketing team, not an engineer.** Nobody reading this knows what
a preload, a stream, an origin or a handle table is, and they will not ask. Write every
bullet so a smart person outside software understands *what was built and what it means*.

- **Explain from the user's point of view.** Not "added the per-origin handle table" but
  "started the part that lets someone say: this app can use my internet connection, but not
  my files". If a change is invisible to users, say so plainly — "nothing on screen yet" is
  a respected answer, the same way it is in `docs/development/pr-blueprint.md`.
- **The child test.** If you would not say the sentence to a bright twelve-year-old and
  expect to be understood, rewrite it.
- **Ban the vocabulary, not just the acronyms.** No `BaseWindow`, IPC, WHATWG, shim,
  broker, cascade, preload, mutation testing, line counts, file names, ADR numbers, or
  A-numbers *in the team message*. A-numbers may appear in voice-note cues only if the
  cue also says in words what the question is.
- Analogies to things people already use are good: phone apps asking permission for the
  camera, a browser tab, a download.

**B. The devlog is the owner's week, not the repo's.** It is written from the owner's
perspective, for a team the owner is reporting to.

- **If the owner was not aware something happened, it does not belong in the update.** Work
  an agent did autonomously is not a result the owner can stand behind in a team meeting.
- Keep what the owner decided, chose, caught, challenged, tested, or explicitly commissioned
  and reviewed. Collapse the rest into a one-line summary of the whole, or drop it.
- The bar is *awareness*, not authorship. Something an agent implemented from the owner's
  decision counts. Three fixes the owner has never heard of do not.
- When unsure whether the owner was aware of an item, keep it and flag it in the chat report
  under §5 so they can strike it — do not silently guess in either direction.

### Section 1: `## Team message`

A paste-ready block starting with `**Weekly update:**` followed by short bullets. House
style is telegraphic and result-first — but plain-language and user-framed always wins over
brevity. A bullet may run to two sentences if that is what makes it land:

```
**Weekly update:**
- Completed the MVP preparation phase: scope, architecture decisions, build plan
- Resolved the three open capability-API defaults (A9)
- Various alignment & ideas calls with JB
```

Rules:
- One bullet per meaningful result or ongoing task, not per commit. Merge related commits.
- Lead with a verb ("Completed", "Started", "Decided", "95% completed"), or bold a short
  plain-language headline and explain it in the same bullet.
- Ongoing work is fine: say "Started" or give a % if the journal states one.
- Carry through any `(Keep private)` markers from the journal.
- Include every item from the journal's **Non-repo** bucket. If that bucket is empty,
  append this line *after* the message block (not inside it):
  `> Reminder: add non-repo items (calls, Notion, admin) before sending.`
- 3–8 bullets. If the week was thin, a 2-bullet update is honest and fine — do not pad.

### Section 2: `## Voice note cues`

Bullets the owner will glance at while recording a spontaneous voice note about the
week's thinking. Source: the journal's **In my head** bucket, plus tensions visible in
the repo (new open questions, reversed decisions, scope pressure) — but only ones the
owner would recognise as their own thinking. Same plain-language bar as the team message:
the owner is about to say these out loud to people who do not read code. Format per bullet:

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

Then, if rule B left anything uncertain, list the bullets you kept on the judgment that the
owner was aware of them, so they can strike any that are wrong. Keep this to a short list,
after the message — it is a checklist, not an essay.
