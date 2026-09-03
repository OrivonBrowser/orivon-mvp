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

- 2026-09-03: **Deep-review run over five PRs turned into seven merges and found three defects
  nobody was looking for.** The worst was not in any PR under review: `orivon.fs`'s quota was
  check-then-act, so an app with a file grant could exceed its declared limit ~256x with a plain
  `Promise.all` -- eight 300-byte writes against a 1000-byte quota all landed, 2400 bytes. Shipped
  code, on main, while `manifest.ts` called the quota "ENFORCED, not advisory". Fixed by reserving
  synchronously before the first `await`; the same test caught a second bug where a write landing
  after a mid-flight revoke was never charged at all.
- 2026-09-03: **The e2e capability test never ran.** #48 landed "the highest-value assertion in the
  whole plan" and it was in no include pattern, no CI job, and not typechecked -- `npm test` ran
  2220 tests and that was not one of them. Wiring it up then exposed a real hosted-runner flake, and
  the flake turned out to be in the UI phase, not the capability boundary: all three security
  assertions passed even in the failing run. Split the phases so a fragile click can never again
  hide a green security result.
- 2026-09-03: **Three rounds of real defects on one small file (`bookmarks.ts`), each found by a
  different method.** Hand-review caught an orphaned promise that made the new "wait for the write"
  helper hang forever; adversarial personas caught overlapping writes clobbering each other while
  the promise reported success -- a bookmark silently lost -- and that nothing flushed on quit, so
  starring a page and immediately closing the browser lost it outright. The clobber was pre-existing;
  what the fix added was a promise asserting it could not happen.
- 2026-09-03: **A doc correction overshot and had to be corrected back.** #46 flipped
  `handle-contracts.md` from DRAFT to IMPLEMENTED when four of five handle types are unbuilt --
  worse than the stale claim, because DRAFT was at least honest. Fixing it found two more false
  claims by the same method, including one inside the fixing PR itself.

### In my head

- 2026-09-03: Every round of review this run found something the previous round had already cleared,
  and the methods were not interchangeable -- hand-reading a diff, three hostile personas, and a
  real CI runner each caught what the others missed. The recurring shape is a confident claim that
  nobody re-ran: a status header, a comment, a pasted test count, a "filed as a question" pointer to
  a question that was never filed. Worth asking whether the answer is more review or fewer
  unverifiable claims.

### Non-repo
