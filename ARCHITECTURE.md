# Architecture

Five minutes. For depth, follow the links.

## What this repository is

**An Electron application, built in one month by one person, to test a single claim:** that a
browser can let ordinary web pages reach the network and the filesystem under per-app
permissions the user grants — and that people will actually use the result daily.

It is not a browser engine. It does not contain a fork of anything. It wraps Chromium via
Electron, the same way VS Code and Slack do, and it is **deliberately, knowingly disposable**.

## What is *not* disposable

One thing: **the interface apps program against**, which lives in
[`src/contracts/`](src/contracts/) as seven files of TypeScript types.

An app calls `orivon.net.connect({ host, port })`. Today, underneath, that is a Node
`net.Socket` in an Electron main process. The interface is designed so that it *could* be
something else later — a WebAssembly host function, or IPC inside a browser engine — **without
any app already written having to change**.

That is a property of the design, deliberately engineered for
([`ADR-0002`](docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)). It is
**not a schedule, not a plan for this codebase, and not something anyone is working on.**
A Wasmtime runtime and a browser-engine fork are both explicitly *out of scope* — see
[`docs/mvp-scope.md`](docs/mvp-scope.md) §LATER. They may never happen. The design costs
nothing extra today, and it means that if they ever do happen, the apps survive.

**So the practical rule when working here:** a shortcut in `src/main/` costs a refactor of code
that was going to be replaced anyway. A shortcut in `src/contracts/` costs every app ever
written for Orivon. Spend your care accordingly.

## The design choices, and who made them

These are **owner decisions**, made deliberately, each with its reasoning recorded so it is not
re-litigated. If you disagree with one, read the ADR first — most obvious objections are
already answered there.

| Decision | Why | Recorded in |
|---|---|---|
| **BitTorrent streaming is the flagship** | It is genuinely daily-use, impossible in Chrome, cheap to build, audience-matched, and it demonstrates well in a 30-second clip | [`ADR-0001`](docs/decisions/ADR-0001-flagship-app-bittorrent-streaming.md) |
| **The capability API is the durable asset; a WASM runtime is deferred, not cancelled** | Containment for untrusted code and mobile portability are both real goals and both post-MVP | [`ADR-0002`](docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md) |
| **Local-first storage; no Orivon server holds user data** | Per-origin isolation, keys derived on the machine. There is no account to breach because there is no account | [`ADR-0003`](docs/decisions/ADR-0003-local-first-storage.md) |
| **Telemetry is opt-out, but disclosed in full on first run** | The metric requires measurement. The disclosure shows the literal JSON, two equally-weighted buttons, nothing preselected, nothing sent before you choose | [`ADR-0004`](docs/decisions/ADR-0004-telemetry.md) |
| **Apps are addressed by URL and cached — never bundled or installed** | No store, no review, no gatekeeper. It also forces the hard problem to be solved rather than avoided | [`ADR-0005`](docs/decisions/ADR-0005-apps-are-url-addressed-not-bundled.md) |
| **Trust is shown as observed behaviour, never as a grade** | A letter grade invites trusting the grade. Click-through shows the actual evidence | [`ADR-0006`](docs/decisions/ADR-0006-trust-indicator-from-observed-behaviour.md) |
| **A cached bundle keeps its real origin** | Serving it from a synthetic origin would break the web's own security model | [`ADR-0007`](docs/decisions/ADR-0007-cached-bundles-served-at-their-own-origin.md) |
| **Handles are WHATWG streams; Node's shapes live in the shim** | Streams give real backpressure. An `EventEmitter` has no way to say "not yet" | [`ADR-0008`](docs/decisions/ADR-0008-handles-are-whatwg-streams.md) |

And four cuts, made on purpose, each of which someone will otherwise propose again:

- **App signing is cut from v0.** With one publisher it is capability-identical to no signing,
  nothing specified the mechanism, and it would have put a red UNSIGNED badge next to
  *"connect to any computer on the internet"* in the launch clip. Integrity is hash-pinning.
- **MKV is out.** Neither MSE nor Chromium's `<video>` can demux Matroska, so there is no
  fallback path — only a remuxer, which is post-launch work. **v0 plays MP4/H.264.**
- **Auto-install of updates is cut.** Unsigned `electron-updater` verifies a hash fetched from
  the same host that serves the binary — a standing remote-code-execution channel, and weaker
  than what is demanded of third-party apps. v0 **checks and notifies**.
- **The success metric counts `activeSec`, not uptime.** A torrent client seeds in the
  background, so measuring "app open" would let someone who pasted one magnet and walked away
  hit the target on day one. This makes the target harder, which is the point.

## The flow

```
  app page  (renderer process, sandboxed: no Node, no require)
      |
      |  orivon.*                    the durable interface -> src/contracts/
      v
  preload  (isolated world)          contextBridge closures ONLY.
      |                              The raw MessagePortMain never crosses
      |  IPC  +  MessageChannelMain  into the page. Handing it over would be
      v                              handing over a raw socket.  [T17]
  broker  (main process)             AUTHORISATION: manifest, grants,
      |                              per-origin enforcement, handle tables
      v
  OS  (sockets, filesystem, keychain)
```

Two channels, on purpose: **control operations** (open, close, set options) go over normal
Electron IPC; **bulk bytes** go over a dedicated `MessageChannelMain` port per handle, because
per-message IPC is far too slow for torrent-rate data.

**Capability is checked once, at acquisition.** `connect()` either returns a handle or it does
not; later operations just reference the handle. That avoids re-authorising every call, and it
avoids the TOCTOU race where a check and its use disagree.

## Where things live

The third column answers one question: **if the Electron shell were thrown away tomorrow, would
this code have to be rewritten?** It is a measure of where care is worth spending, not a plan to
throw anything away.

| Directory | What | Tied to Electron? |
|---|---|---|
| [`src/contracts/`](src/contracts/) | The `orivon.*` interface, types only | **No — this is the asset.** It imports nothing, by enforced rule |
| [`src/broker/policy/`](src/broker/policy/) | Pure decision functions: capability matching, path confinement, origin derivation | **No** — no Electron, no I/O, portable anywhere |
| [`src/broker/`](src/broker/) | Grants, prompts, session partitions, handle tables | Partly — the decisions are portable, the plumbing is not |
| [`src/main/`](src/main/) | Window, tabs, omnibox, subsystem registry | **Entirely. Knowingly disposable** |
| [`src/preload/`](src/preload/) | The privilege boundary | **Entirely** — "preload" is an Electron concept |
| [`src/shim/`](src/shim/) | Node's `net`/`dgram`/`fs` over `orivon.*` | **Entirely** — a compatibility layer, by design temporary |
| [`src/renderer/`](src/renderer/) | Browser chrome UI | **Entirely** |
| [`apps/`](apps/) | The torrent flagship and the test fixture | **No** — they touch only `orivon.*`, exactly like a third-party app |
| [`spike/`](spike/) | Week-0 evidence. **Historical, not live code** | n/a |

Every directory carries a `README.md` saying what it depends on and **what it must never
import**. Those are the actual boundaries; this table is the summary.

## How a URL becomes an app

A normal page stays a normal page. An origin becomes an app when a manifest is found at
`/.well-known/orivon.json` — automatically, as part of loading the page, never as a separate
step the user takes. Permission is asked for only once the page's own code actually calls for
a capability, not at this point.

**The manifest is never probed automatically.** An unsolicited request to every origin you
visit is an active, attributable *"this visitor runs Orivon"* signal — sent from a
privacy-branded browser, to an audience that reads its own traffic. Discovery is a
`<link rel="orivon-manifest">` hint in HTML already delivered — nothing is fetched from a page
that never included it.

> **Corrected 2026-09-03, owner decision.** This used to also name an explicit "Open as app"
> action as a second discovery path. There is no such action: a Web3site is not a category a
> user converts a website into, it is the URL. See `docs/architecture/capability-api.md`'s own
> correction on this same point.

**The grant prompt is origin-first.** Any origin can serve a manifest, and the `name` in it is
self-asserted, so the origin is the largest and primary element and the app's claimed name is
visibly subordinate.

## Two facts that are expensive to rediscover

Both were found by measurement during the week-0 spike, and both contradict what you would
reasonably assume.

**1. Transferable `ArrayBuffer`s renderer → main silently never arrive.**
[electron#34905](https://github.com/electron/electron/issues/34905) reproduces, and it is worse
than reported: the message does not throw, does not corrupt, and **never arrives at all**, at
every size tested. Two rules follow — *never transfer on this path*, and *every reply-carrying
message needs a timeout, because this transport fails by silence rather than by error.* The
first spike run hung on exactly this.

Structured clone is the only mechanism available, and it is plenty: **1134 MB/s** renderer →
main measured, against the 1–5 MB/s that 1080p streaming needs.

**2. A naive webtorrent renderer bundle is WebRTC-only.** Its `browser` field maps `net`,
`bittorrent-dht`, `ut_pex` and `utp` to `false`. Left alone you get Brave parity — which is
precisely what the flagship exists to beat. The fix is per-module resolution overrides in
`electron.vite.config.ts`.

## What to read next

| | |
|---|---|
| [`src/contracts/`](src/contracts/) | The product surface, in seven files |
| [`docs/architecture/capability-api.md`](docs/architecture/capability-api.md) | The specification those files transcribe |
| [`docs/architecture/handle-contracts.md`](docs/architecture/handle-contracts.md) | What each handle does: backpressure, close semantics, errors, revocation |
| [`docs/architecture/security-model.md`](docs/architecture/security-model.md) | The threat model. **The MVP's model is authorisation, not containment** — see [`SECURITY.md`](SECURITY.md) |
| [`docs/development/parallel-work.md`](docs/development/parallel-work.md) | How several people work here at once |
