# ADR-0002: The capability API is the durable asset; WASM is deferred

- **Status:** accepted
- **Date:** 2026-08-18
- **Type:** architecture
- **Decided by:** AI recommendation, amended and accepted by owner

## Decision
Orivon's durable, long-lived asset is the **capability API surface** that applications
program against — *not* the engine that implements it. For the MVP that API is implemented
by a **broker in the Electron main process** over Node primitives. Wasmtime / WASI /
Component Model (`orivon-runtime` as originally specified) is **deferred**, not cancelled.

The API surface is deliberately shaped to **mirror the subset of Node APIs that real Web3
desktop applications already use**, so that porting an existing Electron app is mechanical.

```
renderer (sandbox: true, contextIsolation: true, nodeIntegration: false)
      │   normal HTML / React frontend — unchanged from ordinary web development
      │   preload-exposed API:  orivon.net.*  orivon.fs.*  orivon.id.*
      ▼
capability broker (main process) — enforces app manifest + user grants, Android-style
      ▼
implementation, swappable without touching apps:
      month 1  →  Node sockets / fs / supervised helper process
      later    →  Wasmtime host functions  (containment for untrusted code, mobile)
      later    →  Chromium fork + Mojo
```

## Amendments recorded 2026-08-25

Per this repository's convention, corrections are written into the ADR rather than left only in
downstream documents.

**1. `orivon.hid.*` removed from the diagram.** `capability-api.md` excludes `hid` and
`subprocess` from v0 entirely — for signed apps too, not merely unsigned ones.

**2. The identity rule below was wrong, and is reversed.** This ADR stated that `orivon.id`
yields **per-origin derived keys only, with no cross-origin linkage**. That cannot support
Nostr: an npub must be identical across every client site, or follows and posts fragment per
client. The corrected model — silent **per-origin app keys** plus **named identities** that are
cross-origin by explicit per-site consent — lives in `capability-api.md`. The reversal was
found in validation and is recorded here so a reader arriving via `readiness.md` is not handed
a known-false rule.

**3. The signed/unsigned trust tier is cut from v0** (owner decision). Its only stated
capability difference was `subprocess` and `hid`, which v0 removes for *every* tier — so the
tiers were already identical while still costing signature verification, key pinning, unsigned
marking and a developer-mode flow. `ADR-0005`'s evening amendment records the full reasoning.
**Consequence for this ADR: the "unsigned apps are marked in the tab and in every grant prompt"
rule does not apply in month 1**, because every app is unsigned.

**4. The "app backend" environment this ADR posits no longer exists — and `orivon-runtime`'s
containment justification needs re-argument.** Contradiction B5 was resolved here by naming two
environments, *frontend* (renderer) and *app backend* (broker-side, capability-gated), with
`orivon-runtime` given the job of containing the latter. `ADR-0005` then concluded that
URL-delivered app code cannot run in the main process, moving it to the renderer — after which
**all app code is renderer JS and the broker is a pure syscall proxy.**

Two consequences, stated rather than smoothed over:
- The migration ladder is, as now designed, **Node → Mojo**. Wasmtime would be a *different app
  model* (apps ship WASM modules), not a swap beneath a stable API.
- The containment argument is probably wrong. Hostile app code already runs inside a V8
  renderer sandbox; what makes it dangerous is **the grants it holds**, which is an
  authorisation problem WASM does not solve. The likelier real fix is finer-grained, revocable
  broker policy.

`orivon-runtime`'s **mobile portability** justification is untouched. Its containment
justification is now open, and `mvp-scope.md` states it publicly — so this matters beyond the
repository.

## Context
The public technical design (`orivon-runtime.mdx`, `orivon-core.mdx`,
`technical/orivon-core`) specifies a Rust host embedding Wasmtime with WASI and WIT-defined
interfaces, and sets "run a full Bitcoin node" as its goal. The actual month-1 constraints
are: one solo developer, no Rust knowledge, C++ basics from two years ago, one month, and a
metric requiring a genuinely useful daily-use product.

`technical/orivon-core` ends on the unanswered heading *"How will Orivon Core connect to the
browser?"* — this ADR answers that question.

Two owner interventions shaped this ADR and are recorded because they changed the outcome:
1. *"Are we implementing compatibility to different Web3 apps separately?"* — correct;
   per-app integration does not scale, and the answer is the API's **shape**, not the engine.
2. *"Developers should still be able to run third party on their own risk?"* — correct; an
   initial draft restricted the MVP to curated first-party apps, which contradicts Orivon's
   **permissionless** core value and would have made the execution layer unvalidatable by
   anyone outside the project. See "Two trust tiers" below.

## Alternatives considered
- **Build `orivon-runtime` in Rust with Wasmtime in month 1.** Rejected. Even with Claude
  Max removing token scarcity, the binding constraint is the owner's own review and debug
  time in a language he does not know, against an immature toolchain (`wasm32-wasip2`,
  Component Model, experimental `wasi-threads`; local `rustc` is 1.75.0 from Dec 2023).
  The decisive argument is purpose, not difficulty:

  > WASM's job is to safely run **untrusted** code. In month 1 there are no third-party apps
  > yet, so Wasmtime would solve a problem that does not exist yet, using the only scarce
  > resource available. Its value arrives the moment third-party apps do — which is exactly
  > why it is deferred rather than cancelled.

- **Run capability-bearing WASM inside the renderer's own V8.** Impossible, recorded because
  the public docs imply it. A module with raw sockets and filesystem access cannot run in the
  page sandbox — that sandbox is exactly what is being escaped. This is contradiction B5 in
  `open-questions.md`, resolved here: there are two distinct environments, the *frontend*
  (renderer, ordinary web capabilities) and the *app backend* (broker-side,
  capability-gated). Same file formats, different powers.
- **Curated first-party apps only.** Rejected, see Context (2). Retained only as the
  *default* tier, not as the boundary.
- **Fork an existing Electron browser.** Rejected: no well-maintained candidate exists, and
  debugging an unfamiliar abandoned codebase costs more owner time than writing
  `WebContentsView` tabs + omnibox. The prior failed attempt's GUI is reused as **visual
  reference only**.
- **Invent a clean-slate capability API unlike Node's.** Rejected: more elegant, strictly
  worse. Mirroring Node's shape is what makes tier-2 porting mechanical.

## Reasoning
The dead-end risk in an Electron MVP was never Electron. It was committing to a capability
*interface* that would have to break later. Therefore: **specify the interface with care
now; implement it cheaply now; harden the implementation later.** If apps call
`orivon.net.tcpConnect`, replacing Node sockets with Wasmtime host functions — or later with
Mojo in a Chromium fork — is invisible to every app already written.

This makes the Electron shell **explicitly disposable** and the API spec **explicitly
durable**, which is the concrete answer to "keep the path to Chromium open".

Because the API mirrors Node, a companion **`orivon-node-shim`** package can implement `net`,
`dgram`, `fs` and `hid` on top of `orivon.*`, so an existing Electron app's main-process code
runs nearly unmodified. Developer pitch: *"your Electron app becomes a URL by swapping one
import."* The reachable cluster is real — Ledger Live, Trezor Suite, Frame, IPFS Desktop,
MyCrypto and Exodus are all Electron. See `docs/architecture/app-compatibility.md`.

## Two trust tiers — signing modulates friction, capabilities are the boundary
Both tiers pass through the **same** broker and the **same** manifest enforcement. Publisher
identity never grants a capability by itself.

| | **Signed apps** (default) | **Developer mode** (off by default) |
|---|---|---|
| Install | app bundle with a signature | load unpacked directory, or an arbitrary URL |
| Enabling | always available | deliberate one-time opt-in, plainly worded |
| Marking | normal | marked **unsigned** in the tab, in every grant prompt, and in the trust indicator |
| Capabilities | full grantable set | grantable set minus the high-blast-radius ones below |

**Not grantable to unsigned apps in the MVP**, because a Node broker cannot contain them:
`subprocess` (helper-process spawn) and `hid` / USB.

**Rules that apply to every app, signed included:**
- `fs` is confined to the app's own sandbox directory, with no path escape. Access outside it
  exists only as `fs.userSelected`, routed through an OS file picker — the user choosing the
  path *is* the consent. (Same principle as the web File System Access API.)
- `net` is allowed, but the manifest must declare host/port patterns, and the grant prompt
  shows them.
- `id` yields per-origin derived keys only. Raw key export is never a capability.

A developer therefore needs: a JSON manifest, a frontend, and "load unpacked". That is a
deliberately small surface so someone can build an Orivon app in an afternoon.

## Consequences
- **Weaker containment than Wasmtime, stated openly.** A hole in the broker means full OS
  access, so developer mode carries a real warning rather than a reassuring one. This is the
  first concrete, user-visible justification for `orivon-runtime`: WASM is what turns "at
  your own risk" into "actually contained".
- The MVP ships a **minimal app manifest format, an unpacked-app loader, and developer docs**
  — small scope, high leverage for recruiting the A+ developers the MVP is partly aimed at.
- The MVP is written entirely in **TypeScript**, one language the owner can review.
- The capability API spec becomes the highest-care artefact in the repository. Breaking it
  later breaks every app; the Electron shell can be discarded freely.
- `orivon-runtime` is **not cancelled**. Its purpose is now sharp: containment for untrusted
  third-party code, and portability to mobile — which also preserves the promise in
  `more/mobile-note.md`.
- Compatibility **tier 3** (Qt / JVM / native — Monero GUI, Electrum, Bisq, Sparrow) remains
  out of reach of both the shim *and* WASM, handled by supervised helper processes or not at
  all. This is why Bisq is not in the MVP.

## Reversibility
- **Cost to reverse:** the *implementation* is cheap to swap — that is the point of this ADR.
  The *API shape* is expensive to change once third-party apps exist; today, with zero
  third-party apps, it is nearly free. This is the cheapest moment to get it right.
- **What would make us revisit:** promoting unsigned apps to the full capability set (forces
  WASM or OS-level sandboxing); or a mobile target (forces WASM).
