# Architecture

Five minutes. For depth, follow the links.

## The one idea everything hangs off

**The durable asset is the interface, not the engine.**

An app calls `orivon.net.connect({ host, port })`. What happens underneath changes over time:

| When | Implementation |
|---|---|
| now | a Node `net.Socket` in the Electron main process |
| later | a Wasmtime host function |
| later still | Mojo IPC inside a Chromium fork |

**None of those transitions is visible to an app already written.** That property — not
Electron, not Wasmtime, not any particular engine — is what keeps the path to a real browser
open, and it is why the interface gets far more care than the code implementing it
([`ADR-0002`](docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)).

Practical consequence when you work here: **the Electron shell is disposable and the contracts
are not.** A shortcut in `src/main/` costs a refactor. A shortcut in `src/contracts/` costs
every app ever written for Orivon.

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

| Directory | What | Survives a Chromium fork? |
|---|---|---|
| [`src/contracts/`](src/contracts/) | The `orivon.*` interface, types only | **Yes — this is the asset** |
| [`src/broker/policy/`](src/broker/policy/) | Pure decision functions: capability matching, path confinement, origin derivation | **Yes** — no Electron, no I/O, portable |
| [`src/broker/`](src/broker/) | Grants, prompts, session partitions, handle tables | Partly — the decisions survive, the plumbing does not |
| [`src/main/`](src/main/) | Window, tabs, omnibox, subsystem registry | **No — knowingly disposable** |
| [`src/preload/`](src/preload/) | The privilege boundary | **No** — a Chromium fork has no preload concept |
| [`src/shim/`](src/shim/) | Node's `net`/`dgram`/`fs` over `orivon.*` | **No** — a transitional compatibility layer |
| [`src/renderer/`](src/renderer/) | Browser chrome UI | **No** |
| [`apps/`](apps/) | The torrent flagship and the test fixture | **Yes** — they only use `orivon.*` |
| [`spike/`](spike/) | Week-0 evidence. **Historical, not live** | n/a |

Every directory carries a `README.md` saying what it depends on and **what it must never
import**. Those are the actual boundaries; this table is the summary.

## How a URL becomes an app

A normal page stays a normal page. An origin becomes an app when a manifest is found at
`/.well-known/orivon.json` and the user accepts.

**The manifest is never probed automatically.** An unsolicited request to every origin you
visit is an active, attributable *"this visitor runs Orivon"* signal — sent from a
privacy-branded browser, to an audience that reads its own traffic. Discovery is either a
`<link rel="orivon-manifest">` hint in HTML already delivered, or an explicit "Open as app"
action.

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
