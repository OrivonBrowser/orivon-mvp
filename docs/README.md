# Documentation

Forty-odd documents. Pick one of the three tracks below rather than reading them all.

## Track 1: To understand the product

| | |
|---|---|
| 1. [`mvp-scope.md`](mvp-scope.md) | What the MVP proves, the metric that judges it, the four journeys, and what is deliberately out |
| 2. [`architecture/capability-api.md`](architecture/capability-api.md) | The highest-care artefact here. What apps program against |
| 3. [`architecture/handle-contracts.md`](architecture/handle-contracts.md) | What a `TcpSocket`, `FileHandle` or `IdentityHandle` actually does: backpressure, close semantics, errors, revocation |

Its sibling in code is [`src/contracts/`](../src/contracts/), which is those two documents
transcribed into TypeScript. If you would rather read types than prose, start there: seven
files, and it is the whole product surface.

Then [`architecture/security-model.md`](architecture/security-model.md) for what is being
defended against, and [`glossary.md`](glossary.md) when a term does not parse.

## Track 2: To understand a decision

[`decisions/`](decisions/) holds the architecture decision records. Read them before proposing
anything architectural; most obvious ideas have already been considered and rejected for
recorded reasons.

**Every other page states how Orivon works, not who decided it.** The smaller calls that did not
earn an ADR are one row each in [`decisions/decision-log.md`](decisions/decision-log.md), which
is where dates and decision IDs live.

<!-- Deliberately no count here. It went stale every time an ADR landed, and it made a
     one-line append into an edit that two streams could conflict on. -->


| | |
|---|---|
| [`ADR-0001`](decisions/ADR-0001-flagship-app-bittorrent-streaming.md) | BitTorrent streaming as the flagship. **Withdrawn**: kept as the case for a torrent app, which is an idea |
| [`ADR-0002`](decisions/ADR-0002-capability-api-is-the-durable-asset.md) | The capability API is the durable asset; the WASM runtime deferred, not cancelled |
| [`ADR-0003`](decisions/ADR-0003-local-first-storage.md) | Local-first storage, per-origin isolation, no Orivon server for user data |
| [`ADR-0004`](decisions/ADR-0004-telemetry.md) | Telemetry: opt-out, disclosed, self-hosted, inspectable |
| [`ADR-0005`](decisions/ADR-0005-apps-are-url-addressed-not-bundled.md) | Apps are URL-addressed and cached, never bundled |
| [`ADR-0006`](decisions/ADR-0006-trust-indicator-from-observed-behaviour.md) | Trust indicator from observed behaviour, not a grade |
| [`ADR-0007`](decisions/ADR-0007-cached-bundles-served-at-their-own-origin.md) | Cached bundles keep their real origin |
| [`ADR-0008`](decisions/ADR-0008-handles-are-whatwg-streams.md) | Handles are WHATWG streams; Node shapes live in the shim |
| [`ADR-0009`](decisions/ADR-0009-the-bundle-hash-is-an-app-s-content-identity.md) | The bundle hash construction: what makes an app's content identity, and how a change is noticed |
| [`ADR-0010`](decisions/ADR-0010-key-derivation-frozen-at-v1.md) | Key derivation is frozen at v1, versioned by its salt |
| [`ADR-0011`](decisions/ADR-0011-manifests-declare-their-own-asset-list.md) | Manifests declare their own asset list |
| [`ADR-0012`](decisions/ADR-0012-fetch-and-cache-precede-consent.md) | Fetch-and-cache is automatic and silent; consent is asked once, before the app runs |
| [`ADR-0013`](decisions/ADR-0013-rollback-is-warned-and-chosen-not-blocked.md) | A below-floor version is warned and chosen, never silently blocked |
| [`ADR-0014`](decisions/ADR-0014-main-world-streams-via-experimental-api.md) | The `window.orivon` net surface depends on `executeInMainWorld`, an experimental Electron API |
| [`ADR-0015`](decisions/ADR-0015-the-broker-is-organised-by-job.md) | The broker is organised by job; each directory declares what it may not import |
| [`ADR-0016`](decisions/ADR-0016-synchronous-file-reads-are-permitted.md) | Synchronous file reads are permitted; "everything is async" narrows to the network |
| [`ADR-0017`](decisions/ADR-0017-orivon-owns-the-app-http-path.md) | Orivon owns the app's HTTP path: it terminates TLS, routes `fetch`, and apps set their own headers |

> **Several carry amendments that supersede parts of their own text.** ADR-0002, ADR-0005
> and ADR-0009 have inline amendments; ADR-0008 rescopes ADR-0002's mirror-Node's-shapes rule to
> the shim rather than the capability layer. Read the amendment blocks; they are not
> decoration. ADR-0009's is the sharpest example: its §Reasoning argues for a sort-order rule
> that its amendment then shows cannot be reached, while the rule that *was* load-bearing had a
> bug nobody caught until the code existed.

## Track 3: To start working

| | |
|---|---|
| 1. [`development/setup.md`](development/setup.md) | Prerequisites, install, run. Includes the `ELECTRON_RUN_AS_NODE` trap, so read it before debugging anything |
| 2. [`development/parallel-work.md`](development/parallel-work.md) | Who owns which paths, and how several people work here at once |
| 3. [`development/code-guidelines.md`](development/code-guidelines.md) | How code is written here: comment discipline, the 500-line file limit, one implementation per idea |
| 4. [`development/testing.md`](development/testing.md) | What is tested, and why so little is |
| 5. [`development/pr-blueprint.md`](development/pr-blueprint.md) | How a pull request is titled, described and labelled. Read before opening one |
| 6. [`planning/build-plan.md`](planning/build-plan.md) | The dependency-ordered work, step by step |

Also: [`development/release-checklist.md`](development/release-checklist.md),
[`development/readability-log.md`](development/readability-log.md),
[`development/review-coverage.md`](development/review-coverage.md) and
[`development/security-review-briefing.md`](development/security-review-briefing.md). The last
two are a pair: what review has run, and what to tell the next reviewer before it does.

Start at [`ARCHITECTURE.md`](../ARCHITECTURE.md) if you have not already.

## One warning before you read anything else

**This corpus has reversed itself more than once, and each page carries only what is true now.**
A page you remember, or a summary you read elsewhere, may describe a position that has since
been overturned; the page itself will not tell you that it changed.

What changed and when is in [`decisions/decision-log.md`](decisions/decision-log.md) and in the
ADRs beside it. [`planning/audit-2026-08-25.md`](planning/audit-2026-08-25.md) records five
independent audits and what each overturned. `planning/` is historical as much as current, so
read the dates there.

Four reversals worth knowing about, because they are the ones people still repeat:

- The spike verdict supersedes [`planning/week-0-spike-plan.md`](planning/week-0-spike-plan.md).
  Read [`planning/spike-verdict.md`](planning/spike-verdict.md) for current status.
- Protocol encryption was recorded as a limitation, then reversed: it works, and it should
  be on.
- The "115-130 installs" figure was withdrawn as wrong by orders of magnitude.
- Transferable `ArrayBuffer`s were named as the fallback for a throughput failure. They do
  not work on this path at all; that rescue does not exist.

## Sources of truth

| Question | Read |
|---|---|
| What is Orivon, long-term? | [orivon-docs](https://github.com/OrivonBrowser/orivon-docs), canonical, deployed at docs.orivonstack.com. Not duplicated here |
| What is in the MVP? | [`mvp-scope.md`](mvp-scope.md) |
| What do apps program against? | [`architecture/capability-api.md`](architecture/capability-api.md) |
| What does a handle do? | [`architecture/handle-contracts.md`](architecture/handle-contracts.md) |
| What identifies an app's content, and how is a change to it noticed? | [`architecture/bundle-hash.md`](architecture/bundle-hash.md), [`ADR-0009`](decisions/ADR-0009-the-bundle-hash-is-an-app-s-content-identity.md) |
| Why is something the way it is? | [`decisions/`](decisions/) |
| Who decided that, and when? | [`decisions/decision-log.md`](decisions/decision-log.md) |
| How much does integrating app X cost? | [`architecture/app-compatibility.md`](architecture/app-compatibility.md) |
| What are we defending against? | [`architecture/security-model.md`](architecture/security-model.md) |
| I am about to review the privilege boundary. What should I know first? | [`development/security-review-briefing.md`](development/security-review-briefing.md) |
| What is undecided or contradictory? | [`open-questions.md`](open-questions.md) |
| How do I write a pull request here? | [`development/pr-blueprint.md`](development/pr-blueprint.md) |
| What does a term mean? | [`glossary.md`](glossary.md) |
| What prior material exists, and where? | [`inventory.md`](inventory.md) |

## Reference shorthand

Source comments and this corpus cite several short token families. Three resolve to a real
document; two do not, and a comment should say so by spelling the decision or the constraint out
in words rather than leaning on the token alone.

| Token | Resolves to | Example |
|---|---|---|
| `T<n>` | [`architecture/security-model.md`](architecture/security-model.md)'s threat table | `T12`: DNS rebinding |
| `A<n>` | [`open-questions.md`](open-questions.md) §A | `A18`: pass the granted pattern list, not the manifest |
| `ADR-NNNN` | [`decisions/`](decisions/) | `ADR-0008`: handles are WHATWG streams |
| `d-NNNN` | [`decisions/decision-log.md`](decisions/decision-log.md) | `d-0025`: consent is asked once, before the app's code runs |
| `F<n>`, `B-F<n>`, `P-F<n>`, `AR-F<n>` | **Nothing.** Per-review-round finding IDs, meaningful only for the duration of the review that assigned them, and not to be written into source (`development/code-guidelines.md` Rule 1) | n/a |

## What each directory is

| | |
|---|---|
| [`architecture/`](architecture/) | How it works, and what it defends against. The two contract documents are the highest-care artefacts in the repository |
| [`decisions/`](decisions/) | ADRs, plus `decision-log.md` for the smaller calls. Monotonically numbered, never renumbered. Superseded ADRs are rewritten in place with the reversal recorded |
| [`development/`](development/) | How to work here: setup, testing, parallel work, code guidelines, the PR blueprint, release checklist |
| [`planning/`](planning/) | Scope, build plan, readiness, audits, the spike record, and design documents. Historical as much as current, so read the dates |
