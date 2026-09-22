# Architecture

[`README.md`](README.md#the-idea-underneath) says what Orivon is and what an Electron app means
here. This document covers what it does not: how a capability call actually travels, which parts
of the codebase are meant to survive, and which decisions are already settled.

## What is disposable, and what is not

Almost all of this is disposable on purpose: the Electron shell, the preload, the renderer
chrome, the Node shim. Each exists to make the current version work, and each would be rewritten
if the foundation underneath changed.

One thing would not, and that is the interface apps program against, in
[`src/contracts/`](src/contracts/). An app calls `orivon.net.connect({ host, port })`; today
that is a Node `net.Socket` in an Electron main process, and the interface is shaped so it could
be something else later without any app already written having to change.

That is a property of the design, not a plan. A WASM runtime and a browser-engine fork are both
out of scope ([`docs/mvp-scope.md`](docs/mvp-scope.md) §LATER).

The practical rule that follows: a shortcut in `src/main/` costs a refactor of code that was
going to be replaced anyway. A shortcut in `src/contracts/` costs every app ever written for
Orivon. Spend your care accordingly.

## How a capability call reaches the OS

```
  app page  (renderer process, sandboxed: no Node, no require)
      |
      |  window.orivon.*            the durable interface -> src/contracts/
      v
  preload  (isolated world)          contextBridge closures ONLY.
      |                              The raw MessagePortMain never crosses
      |  IPC  +  MessageChannelMain  into the page. Handing it over would be
      |                              handing over a raw socket.  [T17]
      v
  broker  (main process)             AUTHORISATION: manifest, grants,
      |                              per-origin enforcement, handle tables
      v
  OS  (sockets, filesystem, keychain)
```

There are three transports on purpose, because per-message IPC is far too slow for torrent-rate
data:

| Transport | Carries |
|---|---|
| `CONTROL_CHANNEL` (Electron IPC, `invoke`/`handle`) | every control method: open, close, read, sign, set options |
| `SYNC_CONTROL_CHANNEL` (Electron IPC, `sendSync`) | `fs.readFileSync` and nothing else ([`ADR-0016`](docs/decisions/ADR-0016-synchronous-file-reads-are-permitted.md)) |
| `MessageChannelMain` (one port pair per handle) | bytes only |

Detail in [`src/broker/transport/README.md`](src/broker/transport/README.md) and
[`src/preload/README.md`](src/preload/README.md).

**Capability is checked once, at acquisition.** `connect()` either returns a handle or it does
not; later operations just reference the handle. That avoids re-authorising every call, and it
avoids the TOCTOU race where a check and its use disagree.

## Where things live

The third column answers one question: if the Electron shell were thrown away tomorrow, would
this code have to be rewritten? It is a measure of where care is worth spending, not a plan to
throw anything away.

| Directory | What | Tied to Electron? |
|---|---|---|
| [`src/contracts/`](src/contracts/) | The `orivon.*` interface, types only | **No. This is the asset.** It imports nothing, by enforced rule |
| [`src/broker/policy/`](src/broker/policy/) | Pure decision functions: capability matching, path confinement, origin derivation | **No.** No Electron, no I/O, portable anywhere |
| [`src/broker/`](src/broker/) | Grants, prompts, session partitions, handle tables | Partly: the decisions are portable, the OS plumbing relies on Electron |
| [`src/main/`](src/main/) | Window, tabs, omnibox, subsystem registry | **Entirely. Knowingly disposable** |
| [`src/preload/`](src/preload/) | The privilege boundary | **Entirely.** "preload" is an Electron concept |
| [`src/loader/`](src/loader/) | Manifest discovery, fetch, cache, hash-pinning, the update decision | Partly: the update decision is pure policy; fetching and serving the cache are Electron-specific machinery |
| [`src/shim/`](src/shim/) | Node's `net`/`dgram`/`fs` over `orivon.*` | **Entirely.** A compatibility layer, by design temporary |
| [`src/renderer/`](src/renderer/) | Browser chrome UI | **Entirely** |
| [`apps/`](apps/) | The torrent flagship and the test fixture | **No.** They touch only `orivon.*`, exactly like a third-party app |
| [`spike/`](spike/) | Week-0 evidence. **Historical, not live code** | n/a |

Every directory carries a `README.md` saying what it depends on and what it must never import.
Those are the actual boundaries; this table is the summary.

## How a URL becomes an app

A normal page stays a normal page. An origin becomes an app when a manifest is found at
`/.well-known/orivon.json`, automatically, as part of loading the page, never as a separate step
the user takes. Its declared files are fetched, hashed and cached automatically and silently; no
consent is asked at that point.

Consent is asked **once, before the app's own code runs**, for the app's whole declared
capability set, in a single dialog. It is not deferred to first use: ported code that has never
heard of Orivon cannot pause mid-request for a popup, and a denial answered while a person is
still reading a dialog looks, to that code, identical to a capability that does not exist at
all. One gap remains, bounded to a first visit: the page's own scripts can start running before
that dialog is answered, so an early call can still see `'denied'` before consent resolves
([`A146`](docs/open-questions.md)). Every later visit is unaffected, because the grant is
already held by the time the app runs.

**The manifest is never probed automatically.** An unsolicited request to every origin you visit
is an active, attributable *"this visitor runs Orivon"* signal, sent from a privacy-branded
browser to an audience that reads its own traffic. Discovery is a
`<link rel="orivon-manifest">` hint in HTML already delivered; nothing is fetched from a page
that never included it.

**The grant prompt is origin-first.** Any origin can serve a manifest, and the `name` in it is
self-asserted, so the origin is the largest and primary element and the app's claimed name is
visibly subordinate. There is no separate "open as app" action anywhere in the browser: a
Web3site is not a category a user converts a website into, it is the URL.

## The design choices

All eight below are settled. The line given here is the sharpest reason, not the whole case; if
you disagree with one, the ADR is where the objections are already answered.

**What gets built, and what outlasts it**

- **BitTorrent streaming is the flagship.** Genuinely daily-use, impossible in Chrome, and it
  demonstrates in a 30-second clip
  ([`ADR-0001`](docs/decisions/ADR-0001-flagship-app-bittorrent-streaming.md)).
- **The capability API is the durable asset.** A WASM runtime is deferred, not cancelled:
  containment for untrusted code and mobile portability are both real goals, and both post-MVP
  ([`ADR-0002`](docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)).

**How an app reaches you**

- **Apps are addressed by URL and cached, never bundled or installed.** No store, no review, no
  gatekeeper. It also forces the hard problem to be solved rather than avoided
  ([`ADR-0005`](docs/decisions/ADR-0005-apps-are-url-addressed-not-bundled.md)).
- **A cached bundle keeps its real origin.** Serving it from a synthetic origin would break the
  web's own security model
  ([`ADR-0007`](docs/decisions/ADR-0007-cached-bundles-served-at-their-own-origin.md)).

**What you are told, and what is kept**

- **Local-first storage; no Orivon server holds user data.** Per-origin isolation, keys derived
  on the machine. There is no account to breach because there is no account
  ([`ADR-0003`](docs/decisions/ADR-0003-local-first-storage.md)).
- **Telemetry is opt-out, but disclosed in full on first run.** The metric requires measurement;
  the disclosure shows the literal JSON, nothing preselected, nothing sent before you choose
  ([`ADR-0004`](docs/decisions/ADR-0004-telemetry.md)).
- **Trust is shown as observed behaviour, never as a grade.** A letter grade invites trusting
  the grade. Click-through shows the actual evidence
  ([`ADR-0006`](docs/decisions/ADR-0006-trust-indicator-from-observed-behaviour.md)).

**How the API behaves**

- **Handles are WHATWG streams; Node's shapes live in the shim.** Streams give real
  backpressure. An `EventEmitter` has no way to say "not yet"
  ([`ADR-0008`](docs/decisions/ADR-0008-handles-are-whatwg-streams.md)).

## Four things people keep re-proposing

Each was considered and decided against, and each gets suggested again by someone who assumes it
was simply overlooked.

- **App signing, cut from v0.** With one publisher it is capability-identical to no signing,
  nothing specified the mechanism, and it would have put a red UNSIGNED badge next to
  *"connect to any computer on the internet"* in the launch clip. Integrity is hash-pinning.
- **MKV playback, cut.** There is no fallback path, only a remuxer, and that is post-launch
  work. v0 plays MP4/H.264, and
  [`README.md`](README.md#known-limitations-of-v0) carries the user-facing statement of it.
- **Auto-install of updates, cut.** Unsigned `electron-updater` verifies a hash fetched from the
  same host that serves the binary, which is a standing remote-code-execution channel and weaker
  than what is demanded of third-party apps. v0 checks and notifies.
- **`activeSec` rather than uptime**, in the success metric. Not a cut, but the same kind of
  call: a torrent client seeds in the background, so measuring "app open" would let someone who
  pasted one magnet and walked away hit the target on day one. This makes the target harder,
  which is the point.

## Two facts that are expensive to rediscover

Both were found by measurement during the week-0 spike, and both contradict what you would
reasonably assume.

**1. Transferable `ArrayBuffer`s renderer → main silently never arrive.**
[electron#34905](https://github.com/electron/electron/issues/34905) reproduces, and it is worse
than reported: the message does not throw, does not corrupt, and never arrives at all, at every
size tested. Two rules follow: *never transfer on this path*, and *every reply-carrying message
needs a timeout, because this transport fails by silence rather than by error.* The first spike
run hung on exactly this.

Structured clone is the only mechanism available, and it is plenty: 1134 MB/s renderer → main
measured, against the 1-5 MB/s that 1080p streaming needs.

**2. A naive webtorrent renderer bundle is WebRTC-only.** Its `browser` field maps `net`,
`bittorrent-dht`, `ut_pex` and `utp` to `false`. Left alone you get Brave parity, which is
precisely what the flagship exists to beat. The fix is per-module resolution overrides in
`electron.vite.config.ts`.

## What to read next

| | |
|---|---|
| [`src/contracts/`](src/contracts/) | The product surface, in seven files |
| [`docs/architecture/capability-api.md`](docs/architecture/capability-api.md) | The specification those files transcribe |
| [`docs/architecture/handle-contracts.md`](docs/architecture/handle-contracts.md) | What each handle does: backpressure, close semantics, errors, revocation |
| [`docs/architecture/security-model.md`](docs/architecture/security-model.md) | The threat model. The MVP's model is authorisation, not containment; see [`SECURITY.md`](SECURITY.md) |
| [`docs/development/parallel-work.md`](docs/development/parallel-work.md) | How several people work here at once |
