// ADR-0046's own host logic: for every page that connects, a new child
// starts a real Worker here -- never in the page -- and this relays between
// the page's own dedicated port for that child (./host-protocol.ts) and the
// Worker's ordinary ./protocol.ts traffic. No `electron` import: everything
// here is `MessagePort`, `MessageChannel` and a Web Worker, the same
// contract ../child-process/spawn.ts's own `launchChild()` already keeps for a
// same-process child.
//
// Spawn routes through the host exactly like fork (a `worker_threads` thread
// never does -- ADR-0046's amendment, thread.ts): a spawn's own
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
import { preferLocalWorkers } from '../child-process/host-client.js'
import { loadProgram } from '../child-process/program.js'
import { spawn } from '../child-process/spawn.js'
import { runSpawnSync, type SpawnSyncRequest } from '../child-process/spawn-sync.js'
import { setOrivon } from '../orivon-global.js'
import { createChildWorker } from './launch.js'
import { serveOrivon } from './orivon-server.js'
import { toWireError } from './protocol.js'
import type { FromWorker, SpawnStart, StreamName, ToWorker } from './protocol.js'
import type { HostForkStart, HostStart, StartChildMessage, ToHostChild } from './host-protocol.js'

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
  return `child_process ${start.command}`
}

/**
 * One child, from its `start-child` message onward. `port` is the HOST's own end of the
 * per-child `MessagePort` the page kept the other end of.
 */
async function startChild (port: MessagePort, start: HostStart, extra: readonly Transferable[], orivon: Orivon): Promise<void> {
  port.start()

  // A spawn's own program load below is asynchronous (unlike fork's),
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
  // `url`/`argv`/... on the fork branch.
  let base: Omit<SpawnStart, 'orivon'> | HostForkStart
  if (start.type === 'spawn') {
    // The program itself, loaded here rather than on the page: this file's
    // own header says why. `command`/`args` name the same values spawn.ts's
    // local (non-host) path already passes to the identical `loadProgram`.
    let program: Awaited<ReturnType<typeof loadProgram>>
    try {
      program = await loadProgram(start.command, start.args)
    } catch (error) {
      port.postMessage(failedMessage(error))
      return
    }
    base = { type: 'spawn', program, args: start.args, env: start.env, preopens: start.preopens }
  } else {
    // A forked module must be on the host's own origin -- the page already
    // refuses this before ever reaching here (fork.ts's own moduleUrl()), but
    // the host re-checks rather than trusting a page that could, in
    // principle, send anything over its own port.
    if (!isSameOrigin(start.url)) {
      port.postMessage(failedMessage(new Error("a forked module must be on the app's own origin")))
      return
    }
    base = start
  }

  const orivonChannel = new MessageChannel()
  // A child's spawnSync/execSync/execFileSync is served here, where its orivon.* is (spawn.ts's own launch does the same on the page).
  const server = serveOrivon(
    orivonChannel.port1, orivon,
    async (payload, registerChild) => await runSpawnSync(spawn, payload as SpawnSyncRequest, registerChild)
  )

  let worker: ReturnType<typeof createChildWorker>
  try {
    worker = createChildWorker(workerNameFor(start))
  } catch (error) {
    void server.dispose()
    port.postMessage(failedMessage(error))
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
    if (event.data.type === 'exit' || event.data.type === 'crash') disposeOnce()
    if (orphaned) {
      if (event.data.type === 'output') ackOutput(event.data.stream)
      return
    }
    try {
      port.postMessage(event.data)
    } catch { /* the page's own port is already gone */ }
  }
  worker.onerror = (event) => {
    event.preventDefault()
    disposeOnce()
    if (!orphaned) { try { port.postMessage(failedMessage(new Error(event.message))) } catch { /* gone */ } }
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
  preferLocalWorkers()
  // child-process/spawn.ts's launchChild still reaches for getOrivon() to serve a LOCAL child's
  // own Worker (a spawnSync's own nested spawn, not just this host's own first-level children) --
  // orivon-global.ts's own header has the full reasoning.
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
