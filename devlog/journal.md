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

## Week of 2026-09-21

### Done / results

- 2026-09-21: **The documentation sync went out as one PR (#233, 108 files).** Everything the tree
  had been carrying: the humanizer pass, the decision register, the history removal and its guard,
  the agent-only documents moved into `.claude/`, and machine-absolute paths out of public files.

### In my head

- **A dirty tree is a slow collision with everyone else's work.** `main` moved 44 commits under
  this checkout while the docs work sat uncommitted, and one of the files waiting there was an
  unfinished test rewrite asserting a developer-mode path that only runs behind an env flag the
  test never sets. Nothing local said so: the unit suite is green, because the e2e suite is the
  only place that runs it, and CI was the first thing to notice. The longer work waits in the
  tree, the more of it is someone else's half-finished idea that nobody remembers owning.

---

## Week of 2026-09-14

### Done / results

- 2026-09-15: **The revoke button was lying.** Turn off an app's network access after a restart and
  the row disappeared, but a connection it already had open kept running. Fixed, with a test that
  fails against the old code.
- 2026-09-15: **Apps could die on startup because we refused too loudly.** Libraries routinely ask
  "does this browser have X?" before using it; we had started throwing at the question instead of
  answering it. Now the question is safe to ask and only actually using the missing thing fails.
- 2026-09-15: **Deny now means what it looks like it means.** The install prompt listed things the
  app had already been given, so saying no looked like it took them back. It marks those clearly.
- 2026-09-15: **Sixteen merged PRs had never been reviewed by anyone but their author.** Eight
  different review passes over them found nineteen things; the three serious ones are fixed.
- 2026-09-16: **The folder-access warning now says what a folder grant actually means.** Picking a
  folder for an app now reads as "read, change and delete everything in here, including files you
  add later" instead of a softer "read and write" -- and picking a single file now reaches a real
  page for the first time, reusing the exact same wiring `fs.open` already proved.
- 2026-09-16: **An app keeps its own private storage because you granted it something -- not
  because it was installed.** That distinction also fixed a real bug: an app served from our own
  cache that you had not yet granted anything could not open at all.
- 2026-09-16: **A week of uncommitted work is now a single commit.** The permission engine is
  roughly 90% done, and everything finally sits in one place to start building actual apps on.
- 2026-09-17: **The reviewer briefing was telling reviewers to skip code that now exists.** Written
  for one scan, pinned to one commit, indexed nowhere, and swept into the freeze commit by accident.
  Within four days three of its eight "already known" findings had been fixed and two of its three
  "nothing here yet" areas had been built. Rewritten to carry no finding list and no build status at
  all -- it points at the two documents that re-derive both -- and moved into `docs/` where the
  index owns it.
- 2026-09-17: **A133 and A134 marked resolved, three days late.** Both were closed by the same
  commit, the PR body said so, and nothing came back to the ledger to say it.
- 2026-09-17: **A humanizer pass over every public document, 75 files.** Em dashes, decorative
  bold and staged openers out; ~2,000 dash-as-connector uses became the punctuation the sentence
  actually needed. Every code block, link target, A-number, ADR id and figure verified unchanged
  before and after.
- 2026-09-17: **Decision provenance is out of the pages and into a register.** Every "owner
  decision, <date>" stamp and every "this used to say X" correction block left the reader-facing
  docs; `docs/decisions/decision-log.md` now holds the dates, the IDs and who decided, which
  also gives `d-NNNN` its first real target and closes A90. `CLAUDE.md` Rules 2 and 3 were
  rewritten, or the pattern grows straight back.
- 2026-09-19: **The live docs stopped narrating their own history.** "What changed since the last
  derivation", PR numbers, "the first version did", "this lane" -- about 180 instances across 26
  pages, gone. Removing them surfaced a dozen stale claims underneath (a folder picker described as
  missing that shipped, a security row waiting on a prompt that exists), now fixed. A new hookify
  warning plus Rule 2 keep it from coming back; the matrix's own recipe had been asking for it.

### In my head

- **Installed and trusted are not the same thing.** We had been treating "this app is installed"
  as the reason to give it its own private storage. The honest reason is that someone said yes to
  it -- installing is a separate matter entirely.
- **The review tools disagreed, and that is the whole point.** The security pass gave the range a
  clean bill of health while the worst bug in it sat there untouched -- a handle outliving its
  revocation just is not what a security-controls review looks at. Cheapest-tool-only would have
  shipped it.
- **We let the app decide how much choice the person gets.** Consent can be granted piece by piece
  only if the app's own manifest asks for that, and the app's incentive is always to ask for
  all-or-nothing. We already wrote down this exact trap about unlimited network access and did not
  apply it here.
- **Two files now sit within six lines of the size limit**, reached by separate PRs that were each
  fine on their own. The limit keeps breaking on merge rather than on a branch.
- **The written record drifts in one direction: things get fixed and stay marked broken.** Two
  findings sat at "still open" for three days after the commit that closed them, and a briefing kept
  warning reviewers off subsystems that had since been built. The code was right both times -- the
  cost lands on whoever reads next and believes it.

## Week of 2026-09-07

### Done / results

- 2026-09-14: **Say no to an app now, and it stays said.** Declining install consent used to
  vanish the moment you restarted -- the same question, every single launch. Now it is
  remembered, but only ever as a "don't ask again," never as anything an app could turn into
  access on its own.
- 2026-09-14: **An app you already approved now just works, first try, after every restart.**
  It used to look broken -- images, fonts, live connections all silently failing -- until you
  refreshed the tab. Grants now come from the same verified bundle that already proves the app
  is unchanged, so nothing has to wait for the page to load first.
- 2026-09-15: **Permissions got their own key, and the address bar got its Web3 Score back.**
  Two shields meant two unrelated things; now a key outside the address bar is what an app can
  do, and the shield inside it is reserved for the score.
- 2026-09-15: **No bookmarks, no bookmarks bar.** A fresh profile used to open with an empty
  strip of controls that did nothing. The row now appears with your first bookmark and goes
  away with your last, and the page gets those 28 pixels back.

### In my head

- **Two documents had gone quietly false rather than wrong.** `CLAUDE.md` still said the
  build plan disagreed with itself after the amendment had already landed, and
  `handle-contracts.md` still said the renderer half of the backpressure design was unbuilt
  three days after it shipped. Neither was a mistake anyone made; both are what happens when
  a correction lands in one file and its citations elsewhere are nobody's job. Worth thinking
  about whether the file:line honesty problem (A50) is the same shape.
- **A test that passes locally and fails on CI is usually telling you about a shared resource.**
  Adding a second e2e file made two suites contend for the same fixture ports and the same
  Electron binary, and vitest runs files in parallel by default. Locally the interleaving happened
  to be benign, which is the least useful kind of green.
- **Three tests failed while I was writing them, and two of the three were the test's fault.**
  The UDP window overshoots by one datagram by design, and the drop timer reports a change rather
  than a total. Both times the tempting fix was to bend the code to the guess. Writing the
  reasoning into the code instead is what turned a wrong assertion into a documented property.

### Non-repo
