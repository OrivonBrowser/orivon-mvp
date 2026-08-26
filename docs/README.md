# Documentation

Forty-odd documents. **Pick one of the three tracks below rather than reading them all.**

---

## Track 1 — To understand the product

| | |
|---|---|
| 1. [`mvp-scope.md`](mvp-scope.md) | What the MVP proves, the metric that judges it, the four journeys, and what is deliberately out |
| 2. [`architecture/capability-api.md`](architecture/capability-api.md) | **The highest-care artefact here.** What apps program against |
| 3. [`architecture/handle-contracts.md`](architecture/handle-contracts.md) | What a `TcpSocket`, `FileHandle` or `IdentityHandle` actually does — backpressure, close semantics, errors, revocation |

Its sibling in code is [`src/contracts/`](../src/contracts/), which is those two documents
transcribed into TypeScript. If you would rather read types than prose, start there — seven
files, and it is the whole product surface.

Then [`architecture/security-model.md`](architecture/security-model.md) for what is being
defended against, and [`glossary.md`](glossary.md) when a term does not parse.

---

## Track 2 — To understand a decision

[`decisions/`](decisions/) — nine ADRs. **Read them before proposing anything architectural;
most obvious ideas have already been considered and rejected for recorded reasons.**

| | |
|---|---|
| [`ADR-0001`](decisions/ADR-0001-flagship-app-bittorrent-streaming.md) | BitTorrent streaming is the flagship |
| [`ADR-0002`](decisions/ADR-0002-capability-api-is-the-durable-asset.md) | The capability API is the durable asset; WASM deferred, not cancelled |
| [`ADR-0003`](decisions/ADR-0003-local-first-storage.md) | Local-first storage, per-origin isolation, no Orivon server for user data |
| [`ADR-0004`](decisions/ADR-0004-telemetry.md) | Telemetry: opt-out, disclosed, self-hosted, inspectable |
| [`ADR-0005`](decisions/ADR-0005-apps-are-url-addressed-not-bundled.md) | Apps are URL-addressed and cached, never bundled |
| [`ADR-0006`](decisions/ADR-0006-trust-indicator-from-observed-behaviour.md) | Trust indicator from observed behaviour, not a grade |
| [`ADR-0007`](decisions/ADR-0007-cached-bundles-served-at-their-own-origin.md) | Cached bundles keep their real origin |
| [`ADR-0008`](decisions/ADR-0008-handles-are-whatwg-streams.md) | Handles are WHATWG streams; Node shapes live in the shim |
| [`ADR-0009`](decisions/ADR-0009-the-bundle-hash-is-an-app-s-content-identity.md) | The bundle hash construction: what makes an app's content identity, and how a change is noticed |

> **Three of them carry amendments that supersede parts of their own text.** ADR-0002 and
> ADR-0005 have inline amendments; ADR-0008 rescopes ADR-0002's mirror-Node's-shapes rule to
> the shim rather than the capability layer. Read the amendment blocks — they are not
> decoration.

---

## Track 3 — To start working

| | |
|---|---|
| 1. [`development/setup.md`](development/setup.md) | Prerequisites, install, run. **Includes the `ELECTRON_RUN_AS_NODE` trap — read it before debugging anything** |
| 2. [`development/parallel-work.md`](development/parallel-work.md) | Who owns which paths, and how several people work here at once |
| 3. [`development/testing.md`](development/testing.md) | What is tested, and why so little is |
| 4. [`planning/build-plan.md`](planning/build-plan.md) | The dependency-ordered work, step by step |

Also: [`development/release-checklist.md`](development/release-checklist.md) and
[`development/readability-log.md`](development/readability-log.md).

Start at [`ARCHITECTURE.md`](../ARCHITECTURE.md) if you have not already.

---

## One warning before you read anything else

**This corpus corrects itself in place, and several documents reverse claims they used to
make.** [`planning/audit-2026-08-25.md`](planning/audit-2026-08-25.md) records five independent
audits and what each overturned; individual documents carry inline correction blocks marked
*"Corrected"*, *"Reversed"* or *"Withdrawn"*.

Those blocks are load-bearing. A statement and its correction sit side by side deliberately —
[`CLAUDE.md`](../CLAUDE.md) Rule 3 requires contradictions be surfaced rather than smoothed
over, so the record of having been wrong is kept on purpose. **If a document says two things,
the correction block is the current one.**

Concrete examples, so this is not abstract:

- The **spike verdict** supersedes [`planning/week-0-spike-plan.md`](planning/week-0-spike-plan.md).
  Read [`planning/spike-verdict.md`](planning/spike-verdict.md) for current status.
- **Protocol encryption was recorded as a limitation, then reversed** — it works, and it should
  be on.
- The **"115–130 installs" figure was withdrawn** as wrong by orders of magnitude.
- **Transferable `ArrayBuffer`s were named as the fallback for a throughput failure.** They do
  not work on this path at all; that rescue does not exist.

---

## Sources of truth

| Question | Read |
|---|---|
| What is Orivon, long-term? | [orivon-docs](https://github.com/OrivonBrowser/orivon-docs) — canonical, deployed at docs.orivonstack.com. **Not duplicated here** |
| What is in the MVP? | [`mvp-scope.md`](mvp-scope.md) |
| What do apps program against? | [`architecture/capability-api.md`](architecture/capability-api.md) |
| What does a handle do? | [`architecture/handle-contracts.md`](architecture/handle-contracts.md) |
| What identifies an app's content, and how is a change to it noticed? | [`architecture/bundle-hash.md`](architecture/bundle-hash.md), [`ADR-0009`](decisions/ADR-0009-the-bundle-hash-is-an-app-s-content-identity.md) |
| Why is something the way it is? | [`decisions/`](decisions/) |
| How much does integrating app X cost? | [`architecture/app-compatibility.md`](architecture/app-compatibility.md) |
| What are we defending against? | [`architecture/security-model.md`](architecture/security-model.md) |
| What is undecided or contradictory? | [`open-questions.md`](open-questions.md) |
| What does a term mean? | [`glossary.md`](glossary.md) |
| What prior material exists, and where? | [`inventory.md`](inventory.md) |

---

## What each directory is

| | |
|---|---|
| [`architecture/`](architecture/) | How it works, and what it defends against. The two contract documents are the highest-care artefacts in the repository |
| [`decisions/`](decisions/) | ADRs. Monotonically numbered, never renumbered. Superseded ones are rewritten in place with the reversal recorded |
| [`development/`](development/) | How to work here: setup, testing, parallel work, release checklist |
| [`planning/`](planning/) | Scope, build plan, readiness, audits, the spike record, and design documents. **Historical as much as current** — read the dates |
