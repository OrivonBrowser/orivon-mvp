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
  an unknown operator kills the whole rule quietly; nearly shipped one. Filed as A55, with a
  recommendation to test each rule the way the check:* guards are tested.

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
- 2026-09-03: **Sixteen open questions closed in one pass.** Six owner decisions: apps declare
  their own file list rather than Orivon guessing it (confirming work already sitting unmerged);
  localhost stays installable but only when you type it yourself, so a malicious page cannot make
  Orivon reach into your own machine; the permission popup splits into a test-only "yes" now and
  the real box later; an app that fills its storage asks you for more rather than failing quietly;
  the bookmarks strip hides until you save something; DDOC is "Confirmation", not "Certification".
  One more question dissolved on inspection -- where the `+Privacy` bonus sits was never a choice,
  it follows from a rung already reinstated. Ten others were decided without the owner.
- 2026-09-04: **Both hard gates `ADR-0012` put in front of the discovery trigger are now closed
  -- both halves of A58, merged as #67.** Found the loader never actually read `manifest.assets`
  despite `ADR-0011` adding it -- fixed first (#66), which also surfaced three of
  `fetch-bundle.ts`'s own adversarial-input checks had quietly become redundant with
  `manifest.ts`'s tighter upstream validation once the asset list could only ever come from a
  parsed manifest. Then A58 itself: asked the owner directly, with real numbers on the table, and
  got a clean answer -- no aggregate disk cap, ever, mirroring how ordinary browsers already
  work; built the cleanup half (pruning a superseded bundle's stale files) regardless.
- 2026-09-04: **Separately, A57 (version-floor persistence) closed too, merged as #68.** Not one
  of `ADR-0012`'s two gates -- a different, independent milestone that happened to land the same
  day. Hid a real trap: `Broker.registerApp`/`versionFloorFor` are called without `await` at ~40
  sites in this repo's own tests, which only ever worked because nothing inside them yielded. A
  naive async fix would have turned every one into a live race; went synchronous instead, backed
  by plain sync fs calls.
- 2026-09-04: **A second, adversarial review pass caught a real regression in #68's own first
  fix before it ever reached `main`.** The first pass made the version floor persist only
  *after* a successful disk write -- reasonable-looking, but it meant one failed write left the
  in-memory floor at the *old* version for the rest of that session, no restart needed, which is
  worse than doing no persistence at all. Reproduced directly, then fixed properly: the floor now
  raises in memory unconditionally and first, and a write failure is reported instead of
  swallowed. Worth remembering the shape of this one -- an obviously-reasonable-sounding fix that
  was actually backwards, caught only because a second pass went looking for exactly that.

### In my head
- 2026-09-03: A guard nobody can tell is broken is worse than no guard -- seven hookify rules
  here and no way to know which ones run. Same worry as the smoke.mjs checks that reported green
  while doing nothing.

- 2026-09-03: **Cleared the standing owner-decision backlog -- and most of it should never have
  been mine to answer.** Sixteen questions were queued; six actually changed what a person using
  Orivon sees, and the other ten were engineering calls dressed as decisions. The owner's own test
  for this is now explicit: if you cannot trace the answer to something a real user experiences,
  do not ask -- decide it. Also, twice in one session I explained a question in terms only someone
  who had read the planning docs could follow. Sixth time that has happened.

- 2026-09-03: Every round of review this run found something the previous round had already cleared,
  and the methods were not interchangeable -- hand-reading a diff, three hostile personas, and a
  real CI runner each caught what the others missed. The recurring shape is a confident claim that
  nobody re-ran: a status header, a comment, a pasted test count, a "filed as a question" pointer to
  a question that was never filed. Worth asking whether the answer is more review or fewer
  unverifiable claims.

### Non-repo
