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

### In my head

### Non-repo
