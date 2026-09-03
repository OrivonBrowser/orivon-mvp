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

## Week of 2026-08-31

### Done / results

- 2026-09-01: **The chrome restyle, bookmarks, favicons and the new-tab dashboard landed on
  main** -- written 2026-08-28 and then stalled four days behind the broker/loader review
  sprint, on two branches that were never pushed or opened as PRs. Merged directly to main
  rather than through the usual PR flow (explicit one-off exception, this session). The
  branch's provisional A25/A26/A27 became A32/A33/A34 on merge, and nine code comments
  across six files were repointed in the same commit, because a renumber that stops at the
  table leaves code citing a stranger's question.
- 2026-09-02: **Nineteen code comments across four streams narrate the branch that wrote them,
  not the code** -- "see the PR body", "OUT OF SCOPE for this task", "a sibling commit". All
  passed Rule 1's stated test, which only covers restating-the-line-below, so every prior audit
  cleared them. Rule 1 gained the missing sentence, the first hookify rule for a comment
  defect now warns on edit, eight are fixed and the other eleven are left to be fixed as their
  files are next touched (A40).
- 2026-09-02: **Third duplicate `errnoOf` consolidated into `broker/errors.ts`** -- the two
  copies disagreed on plain-object errors and coerced a `code: undefined` into the string
  "undefined". Pinned with six tests first. Took `index.ts` from 499 to 487 lines, off the
  edge of the 500 limit. A fourth duplicate in the same file pair (`isOrivonError`, stricter by
  a `.name` check) is filed as A39 rather than merged blind -- which of the two is correct is a
  behavioural call, not a move.
- 2026-09-02: **A38's rate limiter (#38) and T22's CSP `connect-src` derivation (#40) both
  open**, alongside session partitioning (#39) -- build step 2's remaining broker-side pieces
  are now all in review. The CSP work found a live injection risk before any code shipped
  (`isAsciiHost` permits space and `;`, either of which breaks out of a `connect-src` directive
  if a granted host is emitted verbatim) and, separately, T22's own doc text was still wrong
  post-A18 ("manifest-declared hosts" instead of granted patterns) -- corrected in the same PR.
  WebRTC blocking has no mechanism anywhere in the corpus and conflicts with the flagship's own
  webtorrent use of it -- filed as A41 rather than guessed at.
- 2026-09-02: **Review pass on #40 found a second real defect before merge**: every IPv6 pattern
  the CSP derivation emitted was invalid CSP and silently dropped by Chromium (confirmed against
  the actual Electron/Chrome build), while the file's own `omitted` list stayed empty for it --
  claiming coverage that did not exist. Two tests had locked the wrong behaviour in as passing.
  Also found the emitted header was non-monotonic (a later small pattern could sneak in after an
  earlier large one was rejected) and that a `*` grant -- which the flagship genuinely holds --
  gets no CSP coverage at all once wired in; the owner decided to keep that lock shut rather than
  widen it (A43). Rewrote the reason union so every omission is diagnosable, fixed the budget walk
  to be order-independent, and added a completeness property test. 2083/2083 passing.
- 2026-09-03: **Rule 1 now has teeth.** The owner pushed back that agents keep writing comment
  essays; measuring it showed 40 of 84 non-contracts source files at 50%+ comment lines, and the
  reason is that Rule 1's only test is "does it restate the code" -- which a file-header essay
  passes. Added a second, destination-based test (a trap belongs in the source, rationale belongs
  in the directory README), a 25-line budget on the leading comment block enforced in CI, and an
  escape hatch that costs one written sentence. Calibrated the limit against the files the
  guidelines already defend as correctly dense -- they open with 14-21 lines; the essays with
  26-94. Density was tried first and dropped: it cannot separate the two.
- 2026-09-03: **Two hookify rules had never fired, and nothing said so.** Both anchored
  `file_path` at `^src/`, and Write/Edit always pass an absolute path -- including the comment
  rule the owner added on 2026-09-02 for this exact problem. So for a day, the correction was
  silently absent rather than ignored. Also found hookify has no `not_regex_match` operator and
  an unknown operator kills the whole rule quietly; nearly shipped one. Filed as A49, with a
  recommendation to test each rule the way the check:* guards are tested.

### In my head
- 2026-09-03: A guard nobody can tell is broken is worse than no guard -- seven hookify rules
  here and no way to know which ones run. Same worry as the smoke.mjs checks that reported green
  while doing nothing.

### Non-repo
