# Orivon MVP — agent operating instructions

## Start here

**Phase: build step 1 (the shell) complete (2026-08-26). Next action is build step 2 (the
capability broker) — nothing else is unblocked ahead of it.**
Last updated 2026-08-26 (build step 1 recorded).

Read in this order, then act:

1. `docs/planning/audit-2026-08-25.md` — **read this first.** Five independent audits of the
   corpus. Records what was wrong, what was fixed, and what is still open. Several documents
   below carry corrections that reverse earlier claims.
2. `docs/planning/readiness.md` — the gate. Says what is ready and what is not.
3. `docs/mvp-scope.md` — what is in, what is out, what counts as failure.
4. `docs/planning/build-plan.md` — dependency-ordered work.
5. `docs/decisions/` — eight ADRs. Read them before proposing anything architectural;
   most obvious ideas have already been considered and rejected for recorded reasons.
   **ADR-0002 and ADR-0005 carry amendments that supersede parts of their own text; ADR-0008
   rescopes ADR-0002's Node-shape-mirroring rule to the shim, not the capability layer.**

**The spike resolved.** Verdict and evidence: `docs/planning/spike-verdict.md` (read this, not
the older `week-0-spike-plan.md`, for current status). Gates 0/1a/1b/2 **PASS** with hard
evidence; gate 4 (throughput) fails its literal relative-to-native-control threshold but beats
the actual product requirement 10x — read past the verdict field; gate 3 (video playback) is
**BLOCKED**, not failed — the app works (confirmed via a direct, non-Playwright launch), but
Playwright's `_electron` driver can't attach to that window, for an unidentified reason. This
is a real, currently-unresolved risk for build step 2's e2e test, which uses the same driver —
check early. **`utilityProcess` fallback was not needed.**

**Narrowed at build step 1 (2026-08-26):** a minimal `BaseWindow` with multiple
`WebContentsView`s (the shell's actual composition) attaches to `_electron` cleanly — so the
cause is specific to gate 3's video/service-worker setup, not `BaseWindow` in general. Practical
consequence: once a window holds more than one view, match windows by URL via `app.windows()`,
never `app.firstWindow()` (view-add order is an implementation detail, not a contract) —
`open-questions.md` C6, `scripts/smoke.mjs` for the pattern in use.

**This machine has `ELECTRON_RUN_AS_NODE=1` set in the ambient shell environment.** It makes
the Electron binary run as plain Node — no windows, no `MessagePortMain`. It does not fail
loudly. Never launch Electron directly; see `.claude/skills/orivon-electron/` for the pattern
that strips it and verifies the launch is real.

**Electron's `.d.ts` sometimes types an option/event on `BrowserWindow` only, even when it
works identically on `BaseWindow`** (`ready-to-show`; the `titleBarStyle`/`titleBarOverlay`/
`trafficLightPosition` family). context7's docs are silent on `BaseWindow` for these rather
than wrong — confirmed both work via a throwaway probe app, 2026-08-26. When context7 doesn't
confirm something specifically for `BaseWindow`, verify empirically before assuming either way.

Open owner decisions are in `docs/open-questions.md` §A. A11 is closed (`ADR-0007`: cached
bundles keep their real origin, intercepted inside the app's partition). **A10 is closed**
(`docs/architecture/handle-contracts.md`, `ADR-0008`): WHATWG streams underneath, Node shapes
presented by the shim on top, full specification written — the closed error enum, close/half-
close semantics, a credit-window backpressure design, and the revocation cascade. Build step 2
is unblocked.

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
| **What does a handle (`TcpSocket`, `TcpServer`, `UdpSocket`, `FileHandle`, `IdentityHandle`) actually do?** | `docs/architecture/handle-contracts.md` — read/write shape, backpressure, close/half-close, error taxonomy, revocation cascade. Same care level as `capability-api.md`, kept as a sibling document |
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

## Tooling — what fires when (installed 2026-08-25, `.claude/settings.json`)

Plugins are project-scoped and travel with the repo. Some are automatic, the rest must be
invoked at the step named here. **Check this table at the start of every build step.**

| Tool | Fires | Use it for |
|---|---|---|
| `typescript-lsp` | Automatic on `.ts` edits | Type errors across main / preload / renderer. Trust its diagnostics over your own reading of a type |
| `security-guidance` | Automatic: warns on edits, reviews the diff when you stop, reviews every `git commit` | Path traversal (T1/T10), SSRF / private-address (T12), secrets. Address or explicitly acknowledge every finding |
| `hookify` rules in `.claude/hookify.*.local.md` | Automatic on edits and shell | Block native modules (Rule 8), insecure `webPreferences`, non-TypeScript sources (ADR-0002); warn on hardcoded storage paths (ADR-0003) and out-of-scope features (Rule 4). Add a rule with `/hookify` whenever the owner corrects the same thing twice |
| `superpowers` | Process, automatic via its session hook | `brainstorming` before new work, `writing-plans` for anything multi-step, `test-driven-development` for every broker / policy function, `systematic-debugging` on any failure, `verification-before-completion` before claiming done |
| `context7` (MCP) | **Manual — call it before writing code against Electron or webtorrent APIs.** | `protocol.handle`, `utilityProcess`, `MessagePortMain`, `WebContentsView`, `session` partitions, `safeStorage`; **webtorrent 3.x** internals and its `browser` field. Training data is stale here — a live check on 2026-08-25 found four wrong assumptions in the docs, including the version itself (`week-0-spike-plan.md` §Verified facts) |
| `playwright` (MCP) | **Manual — build steps 4 and 7.** | Drive the localhost fixture app (step 4) and the three pinned Nostr web clients (journey 3, step 7). The Electron e2e uses the `_electron` library, not this |
| `claude-security` | **Manual — run `/claude-security` at the end of build step 2 (broker) and again before packaging (step 10).** | Whole-repo multi-agent vulnerability scan with verified findings. Expensive: twice, not continuously |
| `claude-md-management` | **Manual — `/revise-claude-md` at the end of any session that changed an assumption in this file.** | Keeps this file true once code exists |
| `orivon-electron` (project skill) | **Manual — read before writing or debugging any Electron+webtorrent code.** | The renderer-bundling alias recipe, the `ELECTRON_RUN_AS_NODE` trap, `MessagePortMain` silent-failure behaviour, and the unresolved Playwright attach issue. Captured 2026-08-25; exists nowhere else |
| `adversarial-reviewer` (user skill) | Manual — after each build step lands | The multi-perspective review that produced `audit-2026-08-25.md`; run it on the broker and the app loader at minimum |
| Built-ins `/code-review`, `/security-review`, `/simplify` | Manual | Per-diff review before each commit on the critical path |

## Devlog capture
`devlog/journal.md` feeds the Sunday team devlog (compiled by `/devlog`). At the end of
any session where something notable happened — a milestone reached, a decision taken or
reversed, a direction change, a worry or idea the owner kept returning to — append a
dated one-liner to the current week's section (**Done / results** for outcomes,
**In my head** for thinking). Skip routine sessions; one line per notable thing, no prose.

## Conventions
- Docs are Markdown, `kebab-case.md`, ASCII-only prose.
- ADRs: `docs/decisions/ADR-NNNN-short-slug.md`, monotonically numbered, never renumbered.
  Superseded ADRs are rewritten in place with the reversal recorded (see ADR-0004).
- The MVP is **TypeScript only**. No Rust, no C++ (`ADR-0002`).
- Prior material is quoted in English; the private planning docs are partly Italian.
