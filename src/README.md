# `src/` — the browser itself

Everything the Orivon shell is made of. Each subdirectory is one **stream**: a unit of work
one person (or one agent session) owns end to end. See
[`docs/development/parallel-work.md`](../docs/development/parallel-work.md) for who owns what.

## The data flow

```
app page (renderer, sandboxed)
     |  orivon.*                  <- the durable interface: src/contracts/
     v
preload (isolated world)          <- contextBridge closures only. The raw
     |  IPC + MessageChannelMain     MessagePortMain never crosses into the
     v                               main world (security-model.md T17)
broker (main process)             <- authorisation: manifest, grants,
     |                               per-origin enforcement
     v
OS (sockets, filesystem, keychain)
```

## The subdirectories

| Directory | What it is | Build step | State |
|---|---|---|---|
| [`contracts/`](contracts/) | The `orivon.*` interface, types only. **The durable asset** | — | done |
| [`main/`](main/) | Electron main process: window, tabs, omnibox, IPC, subsystem registry | 1 | done |
| [`preload/`](preload/) | Preloads at three privilege levels | 1, 2 | in progress |
| [`renderer/`](renderer/) | The browser chrome UI (tab strip, toolbar, address bar) | 1 | done |
| [`broker/`](broker/) | Manifest parsing, grants, per-origin enforcement. **This is the product** | 2 | in progress |
| [`shim/`](shim/) | `net`, `dgram`, `fs` over `orivon.*`, so Node code runs in a renderer | 3 | in progress |
| [`loader/`](loader/) | Manifest discovery, fetch, cache, hash-pinning | 4 | in progress |
| [`trust/`](trust/) | The trust indicator, from observed behaviour | 6 | in progress |
| [`nostr/`](nostr/) | `window.nostr` (NIP-07) backed by `orivon.id` | 7 | in progress |
| [`telemetry/`](telemetry/) | Collection, first-run disclosure, "what has been sent" | 8 | in progress |
| [`shared/`](shared/) | Helpers needed on both sides of a trust boundary | — | empty by design |

## The one rule that matters

`contracts/` is what everything else agrees on, and it **references nothing outside itself**.
Every other directory may depend on it; it depends on none of them. That is what lets the
engine underneath change -- Node broker now, Wasmtime later, Chromium/Mojo after that --
without any app noticing ([`ADR-0002`](../docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md)).
