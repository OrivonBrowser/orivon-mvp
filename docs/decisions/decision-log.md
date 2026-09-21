# Decision log

Every other page in this repository states how Orivon works. None of them says who decided it or
when. That record lives here, and in the ADRs beside this file.

**The split.** An ADR is for a choice that is load-bearing and expensive to reverse: it gets its
own file, with alternatives and reversibility. Everything else that was decided rather than
derived (a scope call, a wording call, a build-order call) gets one row here. If a page and this
log disagree about what the system does, the page is right and this row is stale.

## What this log is not

It is not a reconstruction of provenance the repository never kept. The `d-NNNN` and `D-NNNN`
tokens below were minted before any register existed ([`../open-questions.md`](../open-questions.md)
A90), so each subject here is recovered from the citations that use it, not from a record kept at
the time. Where a date could not be recovered from a citation, the cell is empty rather than
guessed. Rows with no ID were lifted out of the prose of the documents named beside them.

## Numbered decisions

| ID | Date | Decision | Cited by |
|---|---|---|---|
| `d-0017` | 2026-09-05 | Accepting a below-floor version persists it as the new pin; remembered per origin and never re-prompted | [`ADR-0013`](ADR-0013-rollback-is-warned-and-chosen-not-blocked.md) |
| `d-0020` | 2026-09-06 | `window.orivon`'s `net` surface is built on `contextBridge.executeInMainWorld` | [`ADR-0014`](ADR-0014-main-world-streams-via-experimental-api.md) |
| `d-0021` | | `WriteMessage.chunk` must never exceed `LIMITS.writeWindowBytes`; the caller splits | `src/contracts/ipc.ts` |
| `d-0022` | 2026-09-06 | The user-facing grant prompt is built at build step 4, not step 2 | `../planning/build-plan.md`, `../open-questions.md` A36 |
| `d-0023` | 2026-09-09 | `net.listen` is built in build step 2 rather than deferred, so the flagship can seed | `../planning/build-plan.md`, A97 |
| `d-0024` | 2026-09-09 | The permission prompt is in scope for this round, reviewed as it is built | `../planning/build-plan.md`, A103 |
| `d-0025` | 2026-09-13 | Consent is asked once, before the app's own code runs, for its whole declared set | [`ADR-0012`](ADR-0012-fetch-and-cache-precede-consent.md), A146 |
| `d-0027` | | The connect prompt names the first host and counts the rest, never listing every one | `src/main/grant-prompt-connect.ts` |
| `d-0028` | 2026-09-15 | Each accepted socket's port is delivered over the server's own port (`AcceptedMessage`) | A114, `../architecture/handle-contracts.md` |
| `d-0029` | 2026-09-15 | The folder picker returns a `DirectoryHandle` from `userSelected({ directory: true })` | A167, `../architecture/capability-api.md` |
| `d-0030` | 2026-09-15 | DNS resolution is a broker capability, `OrivonNet.lookup`; there is no `orivon.dns` namespace | A107, A171 |
| `d-0031` | 2026-09-16 | `net.lookup`'s authorising union drops `https.connect`, which never carried a resolver | A190, A193 |
| `d-0032` | 2026-09-16 | The `fs.userSelected` wording gate closed; the FILE shape reuses `fs.open`'s handle-scoped siblings | A187, A194 |
| `d-0033` | 2026-09-17 | AI sessions open one or two PRs per working day, not one per feature | `../development/parallel-work.md`, `CLAUDE.md` |
| `d-0034` | 2026-09-17 | A PR body scales to several changes; a bare "None" is not an answer; `ux:` gains `dev` | `../development/pr-blueprint.md` |

## Directives

A separate, earlier series, minted in the owner's own working notes rather than in this
repository. Recorded here because source comments and documents cite the tokens.

| ID | Date | Directive | Cited by |
|---|---|---|---|
| `D-0002` | | Never launch Electron in a way that can steal window focus or orphan a process tree | `.claude/` launch rules, `orivon-electron` skill |
| `D-0004` | | The grant prompt gets no details-expander: a narrow declaration must not look like an unlimited one | A100-adjacent, `src/main/README.md` |
| `D-0005` | | Approve the wider eight-package shim dependency set, not the review's narrower five | `../planning/shim-dependency-review.md`, `../planning/compatibility-matrix.md` |
| `D-0006` | | DNS resolution happens in the broker, because a sandboxed renderer has no resolver | `src/contracts/capability-api.ts`, A107 |
| `D-0007` | 2026-09-09 | A picked folder is remembered across restarts and revocable from the settings list | A167, `../architecture/handle-contracts.md` |
| `D-0010` | 2026-09-10 | Item 2: any navigation repartitions a tab, not only a typed one. Item 4: wiring `app.requestGrant` to the page is the highest-reach item | A108/A109, `src/main/README.md` |
| `D-0013` | | Correct `README.md`'s status banner in the same PR that makes it false | `../planning/step-4-app-loader-plan.md` |

## Decisions lifted out of the pages

No ID was ever minted for these. They were stated inline in the documents named beside them, and
moved here so those documents can state the behaviour without the provenance.

| Date | Decision | Was stated in |
|---|---|---|
| 2026-08-25 | Signed/unsigned trust tiers and `publisherKey` cut from v0; integrity is hash-pinning alone | `../architecture/capability-api.md`, ADR-0002, ADR-0005 |
| 2026-08-25 | Grants are keyed on `(origin, capability, pattern set)`, never on the capability kind | `../architecture/capability-api.md`, `../architecture/security-model.md` T19 |
| 2026-08-25 | Handles are WHATWG streams; Node shapes are reconstructed by the shim (A10) | ADR-0008, `../architecture/capability-api.md` |
| 2026-08-25 | The success metric is stated on `activeSec`, not on time the app is open | ADR-0004, `../mvp-scope.md` |
| 2026-08-25 | The "115-130 installs" figure is withdrawn; the honest funnel is thousands of downloads | `../mvp-scope.md` |
| 2026-08-25 | App #3 for the genericity test is the e2e fixture app | `../mvp-scope.md` |
| 2026-08-25 | MP4/H.264 only in v0; MKV waits on a post-launch remuxer | `../planning/build-plan.md`, `../mvp-scope.md`, `README.md` |
| 2026-08-25 | Auto-install of updates is cut; v0 checks and notifies | `../planning/build-plan.md`, `ARCHITECTURE.md` |
| 2026-08-25 | Tier-2 examples corrected: the hardware-wallet cluster is blocked on `hid` | `../architecture/app-compatibility.md` |
| 2026-08-26 | Address-bar search via DuckDuckGo, added at build step 1 | `../mvp-scope.md` IN table |
| 2026-08-26 | Apps get the specific failure reason inside their grant; `denied` stays uniform | `../architecture/handle-contracts.md` §Errors |
| 2026-08-27 | `origin` and `identityId` frozen: canonical origin, broker-generated opaque id | ADR-0010, `../architecture/capability-api.md` |
| 2026-08-27 | Code guidelines: comments earn their place, 500-line files, one implementation per idea | `../development/code-guidelines.md` |
| 2026-08-27 | Bundle-hash vector V5 re-expressed in percent-encoded form; the table is closed | ADR-0009, `../architecture/bundle-hash.md` |
| 2026-08-28 | Bookmarks bar, real tab favicons and the new-tab dashboard added to scope | `../mvp-scope.md` IN table, ADR-0003 |
| 2026-09-03 | There is no "open as app" action; the `<link>` hint is the only discovery trigger | `ARCHITECTURE.md`, `../architecture/capability-api.md`, `../mvp-scope.md` |
| 2026-09-03 | DDOC expands to "Domain Data Ownership Confirmation", canonical everywhere | `../glossary.md`, open-questions C1 |
| 2026-09-03 | `+Privacy` placement withdrawn as a question; it follows from each ladder's top rung | `../glossary.md`, ADR-0006, open-questions B3 |
| 2026-09-04 | A below-floor version is warned and chosen, never silently blocked | ADR-0013, `../architecture/security-model.md` T19 |
| 2026-09-04 | Rule 2 is enforced in CI by `check:size`; Rule 3 stays unenforced | `../development/code-guidelines.md` |
| 2026-09-05 | An acknowledged rollback that also widens authority still prompts | ADR-0013, `../architecture/security-model.md` T19 |
| 2026-09-10 | The async rule narrows to network operations; `fs` gains `readFileSync` | ADR-0016, `../architecture/capability-api.md` |
| 2026-09-15 | `main` syncs with `origin` by `--ff-only`, unprompted on a clean tree; on a dirty tree the agent reports and does not act | `CLAUDE.md` |

## Adding a row

Mint the next `d-NNNN` and add a row here in the same change that acts on the decision. Then
state the behaviour in the document it governs, **without the provenance**: the page says what
the system does, this log says who decided it and when.

If the choice is load-bearing and expensive to reverse, it is an ADR instead
([`ADR-0000-template.md`](ADR-0000-template.md)), and this log does not duplicate it.
