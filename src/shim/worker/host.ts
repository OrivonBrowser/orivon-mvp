// ADR-0046's own host logic: for every page that connects, a new child
// starts a real Worker here -- never in the page -- and this relays between
// the page's own dedicated port for that child (./host-protocol.ts) and the
// Worker's ordinary ./protocol.ts traffic. No `electron` import: everything
// here is `MessagePort`, `MessageChannel` and a Web Worker, the same
// contract ../child-process/spawn.ts's own `launchChild()` already keeps for a
// same-process child.
//
// Spawn routes through the host exactly like fork and thread: a spawn's own
// program (../child-process/program.ts's `loadProgram`) is loaded HERE,
// never carried across the page -> host hop, since a compiled
// `WebAssembly.Module` does not survive it (ADR-0046's Context). That
// loading's own graph reaches a bare `import ... from 'path'`
// (../wasi-p2/filesystem.ts -> ../fs/paths.ts and ../wasi/fds.ts), which this
// file -- bundled directly into a real, sandboxed preload script, not
// through the app bundler's own shim aliasing -- could not resolve on its
// own; the preload build's own resolve plugin (electron.vite.config.ts's
// `shimNodeSpecifiers`) now resolves it through the same table the app
// bundler uses (module-map.ts), for any importer under src/shim/.

import type { Orivon } from '../../contracts/capability-api.js'
import { loadProgram } from '../child-process/program.js'
import { spawn } from '../child-process/spawn.js'
import { runSpawnSync, type SpawnSyncRequest } from '../child-process/spawn-sync.js'
import { setOrivon } from '../orivon-global.js'
import { createChildWorker } from './launch.js'
import { serveOrivon } from './orivon-server.js'
import { toWireError } from './protocol.js'
import type { FromWorker, SpawnStart, StreamName, ToWorker } from './protocol.js'
import type { HostForkStart, HostStart, HostThreadStart, StartChildMessage, ToHostChild } from './host-protocol.js'

export interface ChildHost {
  /** One page just connected: relays every child it starts over `port`, until the page's own
   * shared connection port -- not a child's own -- closes (the whole tab went away). */
  addPage (port: MessagePort): void
}

function failedMessage (error: unknown): FromWorker {
  return { type: 'failed', error: toWireError(error) }
}

function isSameOrigin (url: string): boolean {
  try {
    return new URL(url).origin === location.origin
  } catch {
    return false
  }
}

function workerNameFor (start: HostStart): string {
  if (start.type === 'fork') return `child_process fork ${new URL(start.url).pathname}`
  if (start.type === 'thread') return start.name
  return `child_process ${start.command}`
}

/**
 * One child, from its `start-child` message onward. `port` is the HOST's own end of the
 * per-child `MessagePort` the page kept the other end of.
 */
async function startChild (port: MessagePort, start: HostStart, extra: readonly Transferable[], orivon: Orivon): Promise<void> {
  port.start()

  // A spawn's own program load below is asynchronous (unlike fork/thread's),
  // so the page may write stdin, or even close its own connection, before
  // the real Worker exists to receive any of it. A `MessagePort` already
  // `.start()`ed dispatches to whatever `.onmessage` is set to AT THE
  // MOMENT a message arrives -- with nothing yet listening, that message is
  // LOST, not merely delayed (measured: an early `stdin-end` this way never
  // reached a spawned program, which then hung forever on stdin, exactly
  // the deadlock ADR-0046's own "closed page port" design exists to avoid).
  // Buffer here; replayed once the real handler below is installed.
  const pendingMessages: ToHostChild[] = []
  let pendingClosed = false
  port.onmessage = (event: MessageEvent<ToHostChild>) => { pendingMessages.push(event.data) }
  port.addEventListener('close', () => { pendingClosed = true })

  // Not `Omit<ToWorker, 'orivon'>`: `Omit` does not distribute over a
  // discriminated union, so that would collapse to only the fields every
  // member shares. This union, built from each member's own already-correct
  // omission, keeps `program`/`args`/`env`/`preopens` on the spawn branch and
  // `url`/`argv`/... on the other two.
  let base: Omit<SpawnStart, 'orivon'> | HostForkStart | HostThreadStart
  if (start.type === 'spawn') {
    // The program itself, loaded here rather than on the page: this file's
    // own header says why. `command`/`args` name the same values spawn.ts's
    // local (non-host) path already passes to the identical `loadProgram`.
    let program: Awaited<ReturnType<typeof loadProgram>>
    try {
      // `start.args` is `child.spawnargs` (argv0 included, matching the
      // worker's OWN `args` field below -- Node's WASI argv convention) --
      // never what `loadProgram` wants, which is the plain args a real
      // process's argv[0] never counts as one of (shim finding 14: this
      // mismatch, unique to the host path, used to hand a spawned program
      // one extra leading argument the local path never did).
      program = await loadProgram(start.command, start.args.slice(1))
    } catch (error) {
      port.postMessage(failedMessage(error))
      port.close()
      return
    }
    base = { type: 'spawn', program, args: start.args, env: start.env, preopens: start.preopens }
  } else {
    // A forked or threaded module must be on the host's own origin -- the
    // page already refuses this before ever reaching here (fork.ts's own
    // moduleUrl()), but the host re-checks rather than trusting a page that
    // could, in principle, send anything over its own port.
    if (!isSameOrigin(start.url)) {
      port.postMessage(failedMessage(new Error(`${start.type === 'fork' ? 'a forked' : 'a threaded'} module must be on the app's own origin`)))
      port.close()
      return
    }
    base = start
  }

  const orivonChannel = new MessageChannel()
  // A child's spawnSync/execSync/execFileSync is served here, where its orivon.* is (spawn.ts's own launch does the same on the page).
  const server = serveOrivon(orivonChannel.port1, orivon, async (payload) => await runSpawnSync(spawn, payload as SpawnSyncRequest))

  let worker: ReturnType<typeof createChildWorker>
  try {
    worker = createChildWorker(workerNameFor(start))
  } catch (error) {
    void server.dispose()
    port.postMessage(failedMessage(error))
    port.close()
    return
  }

  // Set once the page's own port closes: the child keeps running (ADR-0046),
  // but nothing more is ever posted back to a port nobody reads any more.
  let orphaned = false
  let disposed = false
  const disposeOnce = (): void => { if (disposed) return; disposed = true; void server.dispose() }

  // A child sends its next chunk of a stream only once it is acked
  // (../worker/parent.ts's OutputAcks) -- the page's own OutputStream is what
  // acks a chunk it read. Once the page is gone nothing ever will, so an
  // orphaned child that still writes (any daemon logs) would otherwise block
  // at its very next write, forever. Acking on the host's behalf instead
  // keeps the child running exactly as ADR-0046 promises, output and all,
  // with the output itself simply going nowhere.
  const ackOutput = (stream: StreamName): void => { worker.postMessage({ type: 'ack', stream }) }

  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const terminal = event.data.type === 'exit' || event.data.type === 'crash'
    if (terminal) disposeOnce()
    if (orphaned) {
      if (event.data.type === 'output') ackOutput(event.data.stream)
      // Nobody reads this port any more, but it must still be freed --
      // shim finding 16: an orphaned child that never gets here otherwise
      // leaks its port pair for as long as the page's own connection lives.
      if (terminal) port.close()
      return
    }
    try {
      port.postMessage(event.data)
    } catch { /* the page's own port is already gone */ }
    // Freed only AFTER the terminal message is queued for delivery above --
    // close() never recalls an already-sent message, only stops the next
    // one (shim finding 16: both ends stayed entangled forever otherwise).
    if (terminal) port.close()
  }
  worker.onerror = (event) => {
    event.preventDefault()
    disposeOnce()
    if (!orphaned) { try { port.postMessage(failedMessage(new Error(event.message))) } catch { /* gone */ } }
    port.close()
  }

  const dispatch = (message: ToHostChild): void => {
    if (message.type === 'terminate') {
      worker.terminate()
      disposeOnce()
      return
    }
    worker.postMessage(message)
  }
  const disconnect = (): void => {
    orphaned = true
    worker.postMessage({ type: 'stdin-end' })
    if (start.type === 'fork') worker.postMessage({ type: 'disconnect' })
    // Unblocks a write already waiting on an ack the page can no longer send.
    ackOutput('stdout')
    ackOutput('stderr')
  }

  port.onmessage = (event: MessageEvent<ToHostChild>) => { dispatch(event.data) }
  // Only fires once `.start()` or `.onmessage` was set on this port
  // (measured, w1-probe/results.md Q6) -- `port.start()`, and the buffering
  // `.onmessage` this file's own header explains, both already satisfy that,
  // from before this async function's very first `await`. `addEventListener`,
  // never the `.onclose` property: measured here (Node's own `MessagePort`
  // dispatches 'close' to a listener added either way in a real Chromium
  // renderer, but only to `addEventListener` under plain Node, which is what
  // this file's own unit tests run under -- `addEventListener` is what both
  // agree on.
  port.addEventListener('close', disconnect)

  worker.postMessage({ ...base, orivon: orivonChannel.port2 } as ToWorker, [orivonChannel.port2, ...extra])

  // Replays whatever the page sent (or the close it sent no message for)
  // while the Worker above did not exist yet -- this file's own header.
  for (const message of pendingMessages) dispatch(message)
  if (pendingClosed) disconnect()
}

export function createChildHost (orivon: Orivon): ChildHost {
  // No `expose-child-host-connect.ts` runs in this preload (`README.md`'s own
  // table -- only ordinary app tabs get it), so `hasChildHost()` (F1's
  // structural, synchronous check) already answers false here with no work
  // at all: a spawnSync's own nested spawn, served on this same host, runs
  // as a local Worker of it, never a doomed attempt to reach a host of a
  // host. child-process/spawn.ts's launchChild still reaches for
  // getOrivon() to serve that local child's own Worker -- orivon-global.ts's
  // own header has the full reasoning.
  setOrivon(orivon)
  function addPage (port: MessagePort): void {
    port.start()
    port.onmessage = (event: MessageEvent<StartChildMessage>) => {
      const message = event.data
      if (message.type !== 'start-child') return
      void startChild(message.port, message.start, message.extra, orivon)
    }
  }

  return { addPage }
}
