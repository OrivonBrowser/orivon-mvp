# `src/shim/worker/`: children in Web Workers

**What lives here.** What a child needs to run in a Web Worker: the Worker's runtime
(`runtime.ts`, with `runtime-spawn.ts` for a WASI program and `runtime-fork.ts` for an app
module), the page-side server and Worker-side client that carry the Worker's `orivon.*` calls to
the page (`orivon-server.ts`, `orivon-client.ts`), the shared-memory channel for its synchronous
calls (`sync-channel.ts`), and `launch.ts`, which starts a Worker.
[`../child-process/`](../child-process/) is the one user today. A Worker reaches exactly what its
page could, since it is the app's own code
([`ADR-0040`](../../../docs/decisions/ADR-0040-native-shaped-node-features-run-as-webassembly.md)).
Durable: it uses Web Workers, `MessagePort` and JSPI, no Electron API.

**What it depends on.** [`../../contracts/`](../../contracts/) (types), [`../wasi/`](../wasi/),
`../globals.ts`, `../virtual-root.ts`, and the `buffer` and `stream` polyfills.

**What it must never import.** `electron`, or [`../../broker/`](../../broker/): see the parent
README.

**Owner stream.** `shim`.

## Design notes

**`runtime.generated.json` is `runtime.ts` bundled, and it is checked in.** A child Worker starts
from that text through a `blob:` URL, which works whatever bundler a port uses and passes the served
CSP's `worker-src 'self' blob:`. `tests/runtime-bundle.test.ts` fails when it is stale: after
changing anything the runtime imports, run it with `ORIVON_WRITE_WORKER_RUNTIME=1`.

**`early-globals.ts` must stay the runtime's first import.** Polyfills in the bundle read
`process` while they load; in a tab the preload installs it first, and in a Worker this module does.

**A stream whose chunks are handles is pumped, every other stream is transferred.**
`TcpServer.connections` yields sockets, which carry streams of their own that structured clone
cannot copy, so the server reads it one socket at a time (`HANDLE_STREAMS`). A new contract stream
of handles must be added there, or its transfer fails.

**A handle's plain fields are copied once**, when it crosses: a live counter such as
`UdpSocket.droppedInbound` reads its value at that moment.

**A Worker's synchronous calls block on the page through shared memory** (`sync-channel.ts`).
The Worker posts the call as usual and waits in `Atomics.wait`; the page makes it on its own
`orivon` and writes the reply into a `SharedArrayBuffer`, in 1 MiB chunks. Only a cross-origin
isolated app has `SharedArrayBuffer`: elsewhere a Worker's `readFileSync` refuses by name, and an
addon's file calls refuse with `NOSYS`. The synchronous twin sits under
`Symbol.for('orivon.synchronous')` on the Worker's `orivon`, a registered symbol so each bundle's
shim finds the same one. It is not part of the contract, and `window.orivon` has none. A reply
carries no stream, so a call returning one refuses, and the page closes what that call opened. **Never make a synchronous call from the
thread that serves it**: it waits forever, which is why `tests/sync-channel.test.ts` runs the
Worker end in a `worker_threads` thread.

**Disposing the server closes every handle the Worker still holds**, so a killed child leaves no
slot open in the broker's per-app handle table.

**A forked module's first IPC messages wait until it has run, or until it listens for
`'message'`** (`runtime-fork.ts`): its code loads asynchronously, and in Node a child's top level
runs before any message is processed, while a top-level `await` on the first message must still
receive it.

**A forked child ends on its own as a Node child does** (`liveness.ts`): once its IPC channel is
closed and no timer, immediate, fetch, `orivon.*` call or open handle is pending, it emits
`'beforeExit'`, then `'exit'`, and ends with code 0. Scheduling that must not keep it alive uses
the unwrapped `setTimeout` that `trackScope` returns.

**The stdout sink posts a copy of each chunk**, never the host's own array: transferring it would
detach it, and the host reads its length afterwards for `fd_write`'s byte count, which a libc
checks before writing again.
