# `src/preload/ports/`: the isolated-world socket state machines

**What lives here.** `socket-bridge.ts`, the only file that listens on `PORT_CHANNEL`, mapping a
handle id to its port whatever the socket's kind; and `socket.ts`, `datagram.ts` and
`server.ts`, the per-connection state machines for TCP, UDP and server accepts. Those three are
free of Electron: they hold a `PortLike`, not a `MessagePortMain`.

**What it depends on.** [`../orivon-error.ts`](../orivon-error.ts), and within this folder
`socket.ts`, whose `PortLike` and plumbing the other three build on.

**What it must never import.** [`../../broker/`](../../broker/), as the parent README says.
Nothing under [`../surface/`](../surface/): the surface wraps these closures, never the reverse.

## The rule this folder exists to hold to

**The raw `MessagePortMain` never crosses into the main world.** These files hold it in the
isolated world and expose only plain closures (`write(chunk)`, `onData(cb)`: `socket.ts`'s
`SocketPort`), and `../surface/main-world-socket.ts` builds the page's streams over them.
Transferring the port is the obvious throughput move, and it hands a bearer capability to
anything the page can reach
([`security-model.md`](../../../docs/architecture/security-model.md) T17). A security rule, not
an optimisation left for later; `contextIsolation: true` is what makes it free.

The throughput evidence does not cover `net.connect`. Spike gate 0 measured 1134.8 MB/s through
`exposeInMainWorld`'s closures; `net.connect` goes through `executeInMainWorld`, which adds a
`contextBridge` clone to the structured clone (three copies of every byte, two on the renderer
main thread). That path is unmeasured.

The smoke check asserts `require` and `process` are `undefined` in every window it drives. If
that ever regresses, stop.
