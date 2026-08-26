# `src/preload/` — the privilege boundary

**What lives here.** Two preload scripts at two different privilege levels. This is the
narrowest and most security-critical surface in the repository.

**What it depends on.** `electron` (via `require` — these are CommonJS),
[`src/contracts/`](../contracts/) for types.

**What it must never import.** [`src/main/`](../main/) or [`src/broker/`](../broker/). A
preload runs in the renderer process; importing main-process code would either fail or, worse,
appear to work.

**Owner stream.** `app.ts` belongs to `broker` (build step 2); `shell.ts` belongs to `shell`
(build step 1, done).

| File | Loaded by | Exposes |
|---|---|---|
| `app.ts` | **every ordinary tab** | `orivon.version` today; the full `orivon.*` surface from build step 2 |
| `shell.ts` | **only** the chrome view | Tab commands |

## The rule that governs this directory

**The raw `MessagePortMain` never crosses into the main world.** The preload holds it in the
isolated world and exposes only `contextBridge` closures over it — `socket.write(buf)`,
`socket.onData(cb)`. Transferring the port to the page is the obvious move when optimising for
throughput, and it hands a raw socket to anything the page can reach
([`security-model.md`](../../docs/architecture/security-model.md) T17).

This is a **security rule, not a throughput optimisation left for later**. `contextIsolation:
true` is what makes it free. Spike gate 0 measured 1134.8 MB/s *through the closures*, so there
is no performance argument for weakening it.

The smoke check asserts `require` and `process` are `undefined` in every renderer. If that ever
regresses, stop.
