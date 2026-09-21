---
description: Compile the weekly Sunday devlog — paste-ready team message + voice-note cues
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(git log:*), Bash(date:*), Bash(ls:*)
---

# /devlog — weekly devlog compiler

Produce the Sunday devlog for the Orivon MVP. Output file: `devlog/updates/YYYY-MM-DD.md`,
named for **the Sunday of the week being compiled** — not the day the compile happens to run.
Compiling on a Monday still writes the Sunday before it. If that file already exists,
regenerate it in place.

Its first line is the header, and the header is only this:

```
# Devlog — week of <the Monday that week started>
```

No "(compiled ...)" and no "(completed ...)": when it ran is git's business, the same way
`CLAUDE.md` Rule 2 treats every other page here.

## 1. Determine the period

The period is from the date of the most recent file in `devlog/updates/` (exclusive) to
today. If the directory is empty, use the last 7 days. Note that the journal may carry
uncompiled items under an *earlier* week's heading, left behind when a previous compile ran
mid-week — everything dated inside the period belongs in this update, whichever heading it
sits under.

## 2. Gather material

- `git log --since=<period start> --date=short --pretty='%ad %h %s'` — commits this period.
- `devlog/journal.md` — the current week's three buckets (Done / In my head / Non-repo).
- Anything changed this period in `docs/decisions/` or `docs/open-questions.md`
  (visible from the git log) — decisions made and questions raised are always devlog-worthy.

  `scripts/devlog-cron.sh` (the unattended Sunday run) does not use this step or this file's
  `git log` grant at all — R-S5-01 found that any `Bash(git log:*)` grant to an unattended,
  auto-approving agent is an arbitrary-file-write primitive (`--output=<file>`), so that script
  now runs `git log` itself with fixed arguments and hands the agent the result as files to
  Read. This step is for an attended run only.

## 3. Write `devlog/updates/YYYY-MM-DD.md`

Two sections, in this order.

**Three rules that override everything below. All three are owner corrections after a
compile got them wrong: A and B on 2026-09-01, C on 2026-09-08 and again on 2026-09-21.**

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

**C. One line per bullet. Brevity is not in tension with rules A and B — it enforces
them.** The owner has corrected the length twice. Both times the long version came from
treating rule A as licence to *explain*: translate the jargon, then stop.

- **Hard ceiling: 25 words per bullet.** Count them. Over the ceiling is not a style
  preference to weigh against clarity, it is a rewrite. Two sentences are for the rare
  bullet that genuinely needs a second one, not the default shape.
- **Cut the mechanism, keep the result.** What Orivon can now do, and what it means for a
  person. Never how it works, never what was wrong before unless the contrast *is* the
  result, never what it was measured against.
- **No colon-then-list, no "Until this week...", no "This is the thing that..."** — each
  is a long bullet wearing a short bullet's clothes.
- A result too big for 25 words is two bullets, or it is one bullet plus a voice-note cue.
  It is never one long bullet.

### Section 1: `## Team message`

A paste-ready block starting with `**Weekly update:**` followed by short bullets. House
style is telegraphic and result-first. This is the target shape, not a floor to build on:

```
**Weekly update:**
- Completed the MVP preparation phase: scope, architecture decisions, build plan
- Resolved the three open capability-API defaults (A9)
- Various alignment & ideas calls with JB
```

Rules:
- One bullet per meaningful result or ongoing task, not per commit. Merge related commits.
- Lead with a verb ("Completed", "Started", "Decided", "95% completed"), or bold a short
  plain-language headline. A bolded headline is the whole bullet, not a title for a
  paragraph after it.
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

- **Short hook (3–6 words)** — **one** sentence of context, 25 words, so the hook is
  instantly recognisable a week later. Rule C applies here too. No scripting, no prose to
  read aloud; the owner is speaking freely from the hook, and a cue long enough to read
  aloud is a cue that gets read aloud.

Order them as a narrative arc (what happened first → where the head is now), not by
importance. 3–7 cues.

## 4. Reset the journal

In `devlog/journal.md`: delete the compiled week's section entirely (its content now
lives in the update file) and start a fresh `## Week of <tomorrow's Monday>` heading
with the three empty buckets.

## 5. Check the length, then report

Before printing anything: count the words in every bullet and every cue. Rewrite each one
over 25 words. This check is not optional and not a judgment call — it is the only thing
that has ever caught this, because a long bullet reads as thorough while writing it.

## 6. Report

End by printing the full **Team message** block in chat, ready to copy, followed by a
one-line pointer to the update file for the voice-note cues.

Then, if rule B left anything uncertain, list the bullets you kept on the judgment that the
owner was aware of them, so they can strike any that are wrong. Keep this to a short list,
after the message — it is a checklist, not an essay.
