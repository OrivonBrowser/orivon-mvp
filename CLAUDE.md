# Orivon MVP — agent operating instructions

## Start here

**Phase: preparation complete and audited, awaiting owner go/no-go.**
Last updated 2026-08-25.

Read in this order, then act:

1. `docs/planning/audit-2026-08-25.md` — **read this first.** Five independent audits of the
   corpus. Records what was wrong, what was fixed, and what is still open. Several documents
   below carry corrections that reverse earlier claims.
2. `docs/planning/readiness.md` — the gate. Says what is ready and what is not.
3. `docs/mvp-scope.md` — what is in, what is out, what counts as failure.
4. `docs/planning/build-plan.md` — dependency-ordered work.
5. `docs/decisions/` — six ADRs. Read them before proposing anything architectural;
   most obvious ideas have already been considered and rejected for recorded reasons.
   **ADR-0002 and ADR-0005 carry amendments that supersede parts of their own text.**

**The next action, once the owner says go:** the **week-0 spike** in `build-plan.md`.
Its criteria were rewritten on 2026-08-25 — the old gate measured throughput, which four
audits independently found was never the risk. It now asks, in order: does a renderer bundle
fetch *ordinary* (non-WebRTC) torrents; is the tree free of native modules; does video play;
then throughput. Timeboxed to 2 days, fallback is a `utilityProcess`.
**Nothing else starts until it resolves.**

Open owner decisions are in `docs/open-questions.md` §A. None block the spike, but **A10
(handle contracts) and A11 (ADR-0007, how cached bundles are served) must land before build
step 2** — both are one-way doors.

## What this repository is
The MVP implementation of **Orivon**. It is *not* the vision documentation.

The MVP proves one thing: that a browser can run applications **impossible in Chrome** —
reaching the network and filesystem under user-granted, per-app capabilities — while those
applications are ordinary web frontends delivered from a URL.

Success metric: **100 active users in EU/USA, active = 25 h/month.** The metric, not the
long-term vision, decides scope.

## Sources of truth
| Question | Read |
|---|---|
| What is Orivon, long-term? | `/home/jhon/Desktop/Develop/orivon-docs/docs/` (canonical; deployed at docs.orivonstack.com). **Do not duplicate it here** — summarise and link |
| What prior material exists, and where? | `docs/inventory.md` — everything is indexed; do not re-crawl the filesystem |
| What is in the MVP? | `docs/mvp-scope.md` |
| **What do apps program against?** | `docs/architecture/capability-api.md` — **the highest-care artefact here.** The Electron shell is disposable; this interface is not |
| Why is something the way it is? | `docs/decisions/` (ADRs) |
| How much does integrating app X cost? | `docs/architecture/app-compatibility.md` |
| What are we defending against? | `docs/architecture/security-model.md` |
| What is undecided or contradictory? | `docs/open-questions.md` |
| What does a term mean? | `docs/glossary.md` |

`/home/jhon/git/orivon-browser-v2` is a **failed prior MVP**. Not a baseline, not a reference
architecture. Its GUI may be used as *visual reference only*.

## The load-bearing idea
The durable asset is the **capability API** (`orivon.*`), not the engine beneath it:
Node broker now → Wasmtime later → Chromium/Mojo later, invisible to apps already written.
That property — not Electron, not Wasmtime — is what keeps the Chromium path open.
`orivon-runtime` is **deferred, not cancelled**; its jobs are containment for untrusted code
and mobile portability, both post-MVP.

## Rules
1. **Do not silently promote assumptions into architecture.** If a choice is load-bearing and
   reversible only at cost, write an ADR (`docs/decisions/ADR-0000-template.md`).
2. **Label uncertainty explicitly.** Distinguish owner's decision / AI recommendation / still
   open. Never blur them.
3. **Contradictions get surfaced, not smoothed over.** Append to `docs/open-questions.md` and
   raise it with the owner.
4. **Scope discipline.** The vision corpus is large, coherent and seductive, and the developer
   is solo — scope creep out of it is the single biggest risk. **Anything absent from the IN
   table in `mvp-scope.md` is out by default.**
5. **No dead ends toward a future Chromium fork.** State, per component, whether it survives
   that migration or is knowingly disposable.
6. **Prefer mature components.** Per subsystem decide: build / library / fork / embed /
   interface. Do not reinvent without a written reason.
7. **Don't over-document trivia**, and don't create abstractions for elegance alone.
8. **Pure-JS dependencies only.** Native modules break run-from-source on Windows and macOS,
   which is a supported path (`build-plan.md`).

## Conventions
- Docs are Markdown, `kebab-case.md`, ASCII-only prose.
- ADRs: `docs/decisions/ADR-NNNN-short-slug.md`, monotonically numbered, never renumbered.
  Superseded ADRs are rewritten in place with the reversal recorded (see ADR-0004).
- The MVP is **TypeScript only**. No Rust, no C++ (`ADR-0002`).
- Prior material is quoted in English; the private planning docs are partly Italian.
