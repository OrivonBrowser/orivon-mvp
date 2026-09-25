# `src/preload/ports/`: the isolated-world socket state machines

**What lives here.** `socket-bridge.ts`, the only file that touches
`ipcRenderer.on(PORT_CHANNEL)`, and deliberately kind-agnostic: it maps a handle id to a port and
does not care what kind of socket it belongs to. `socket.ts`, `datagram.ts` and `server.ts` are
the isolated-world per-connection state machines for TCP, UDP and server accepts, all
Electron-free (they hold a `PortLike`, not `MessagePortMain` itself).

**What it depends on.** [`../orivon-error.ts`](../orivon-error.ts) and, within this folder,
`socket.ts` (the other three build on its `PortLike` shape and its send/receive plumbing).

**What it must never import.** [`../../broker/`](../../broker/) -- see the parent README's "What
it must never import". Nothing under [`../surface/`](../surface/): the surface is what wraps
these closures for the main world, never the other way round.

**Owner stream.** `broker`, build step 2.

## The rule this folder exists to hold to

**The raw `MessagePortMain` never crosses into the main world.** `socket-bridge.ts`, `socket.ts`
and `datagram.ts` hold it in the isolated world and expose only plain closures over it:
`write(chunk)`, `onData(cb)`, and so on (`socket.ts`'s own `SocketPort`). Transferring the port
to the page is the obvious move when optimising for throughput, and it hands a raw socket to
anything the page can reach
([`../../../docs/architecture/security-model.md`](../../../docs/architecture/security-model.md)
T17). `../surface/main-world-socket.ts`'s `installOrivon` builds the page's real
`ReadableStream`/`WritableStream` in the main world over exactly these closures, and the closures
cross via `contextBridge.executeInMainWorld`'s proxying, the port itself never does.

This is a **security rule, not a throughput optimisation left for later**. `contextIsolation:
true` is what makes it free. Spike gate 0 measured 1134.8 MB/s *through the closures* for the
`exposeInMainWorld` mechanism. **That figure does not cover `net.connect`'s path**, which goes
through `executeInMainWorld` and adds a `contextBridge` clone on top of the structured clone
already in the path (three copies of every byte, two of them on the renderer main thread). That
path is unmeasured, so the figure is evidence for `app.*`/`fs.*`'s throughput only.

The smoke check asserts `require` and `process` are `undefined` in every renderer. If that ever
regresses, stop.
