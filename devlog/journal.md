# Devlog journal — running capture

This file is the raw material for the Sunday devlog. It is append-only during the
week and compiled by `/devlog` into `devlog/updates/YYYY-MM-DD.md`, after which the
compiled week is cleared and a fresh week heading is started.

Three buckets per week:

- **Done / results** — technical outcomes worth telling the team. One line each.
- **In my head** — what the owner has been thinking about: doubts, direction changes,
  things circling that are not visible in commits. These become the voice-note cues.
- **Non-repo** — calls, Notion work, admin, anything outside this repository. Claude
  cannot see these, so the owner jots them here (or they get a placeholder on Sunday).

Mark anything that must not leave the team draft as `(Keep private)`.

---

## Week of 2026-09-07

### Done / results

- 2026-09-06: **Closed step 2's known defects in four PRs (#89-#92).** The one that mattered:
  a socket connected to a peer that stops reading could survive both `close()` and a
  revoked permission, with no code path left able to reach it -- so "revoke means stop" was
  not actually true. Fixed with both shapes the owner picked, and the reproduction now runs
  as a test against a real paused TCP peer rather than sitting in a finding.
- 2026-09-06: **Two grant-policy decisions became code.** A blanket "any host, any port"
  grant no longer reaches the mail, DNS, IRC and remote-access ports unless an app names the
  exact port -- a range does not count as naming. And an app now declares how many
  connections it needs in its manifest, which the broker clamps and enforces; declaring
  nothing gets 64 rather than a silent 512, so anything heavy has to ask in a number the
  user will see.
- 2026-09-06: **A test that could pass against a stale build no longer can.** It rebuilt the
  bundle only when the file was missing, never when it was out of date, so a leftover build
  directory made it fail on a clean `main` -- and, worse, a slightly-stale one would have let
  it pass against code that predated the test.

### In my head

- **Two documents had gone quietly false rather than wrong.** `CLAUDE.md` still said the
  build plan disagreed with itself after the amendment had already landed, and
  `handle-contracts.md` still said the renderer half of the backpressure design was unbuilt
  three days after it shipped. Neither was a mistake anyone made; both are what happens when
  a correction lands in one file and its citations elsewhere are nobody's job. Worth thinking
  about whether the file:line honesty problem (A50) is the same shape.
- **The owner answered a memory-limit question with a permissions answer.** Asked whether to
  cap 640 MB per app, the reply was that the app should declare what it needs and the user
  should see that number. That reframes a resource limit as a consent surface, which is the
  same move `fs.quotaBytes` already made for disk -- and it is a better answer than either
  option offered.

### Non-repo
