# `src/`: the browser itself

Everything the Orivon shell is made of. Each subdirectory is one **stream**, a unit of work one
person or agent session owns end to end
([`parallel-work.md`](../docs/development/parallel-work.md) §The ownership map). How a call
travels through them, and which are tied to Electron: [`ARCHITECTURE.md`](../ARCHITECTURE.md).

| Directory | What it is | Build step |
|---|---|---|
| [`contracts/`](contracts/) | The `orivon.*` interface, types only. **The durable asset** | none |
| [`main/`](main/) | Electron main process: window, tabs, omnibox, IPC, subsystem registry | 1 |
| [`preload/`](preload/) | Five preload entry points at five privilege levels | 1, 2 |
| [`renderer/`](renderer/) | The browser chrome UI (tab strip, toolbar, address bar) | 1 |
| [`broker/`](broker/) | Manifest parsing, grants, per-origin enforcement. **This is the product** | 2 |
| [`shim/`](shim/) | `net`, `dgram`, `fs` over `orivon.*`, so Node code runs in a renderer | 3 |
| [`shim-electron/`](shim-electron/) | `electron` itself, reconstructed or refused on top of `orivon.*`, for a tier-2 app | 3 |
| [`loader/`](loader/) | Manifest discovery, fetch, cache, hash-pinning, DDOC | 4 |
| [`protocols/`](protocols/) | Finding and loading a site besides DNS and HTTP: ENS, IPFS, and the verifier host that serves them | 6 |
| [`trust/`](trust/) | The trust indicator, from observed behaviour | 7 |
| [`nostr/`](nostr/) | `window.nostr` (NIP-07) backed by `orivon.id` | none: parked |
| [`telemetry/`](telemetry/) | Collection, first-run disclosure, "what has been sent" | 8 |
| [`shared/`](shared/) | Helpers needed on both sides of a trust boundary | none |

## The one rule that matters

`contracts/` references nothing outside itself, and every other directory may depend on it
([`ADR-0002`](../docs/decisions/ADR-0002-capability-api-is-the-durable-asset.md);
`npm run check:contracts` enforces it).
