// ADR-0046's own host logic: for every page that connects, a new child
// starts a real Worker here -- never in the page -- and this relays between
// the page's own dedicated port for that child (./host-protocol.ts) and the
// Worker's ordinary ./protocol.ts traffic. No `electron` import: everything
// here is `MessagePort`, `MessageChannel` and a Web Worker, the same
// contract ../child-process/spawn.ts's own `launchChild()` already keeps for a
// same-process child.
//
// SPAWN DOES NOT ROUTE THROUGH THE HOST YET. `../child-process/program.ts`'s
// loading pulls in ../wasi-p2/filesystem.ts, which needs ../fs/paths.ts and
// ../wasi/fds.ts -- both `import ... from 'path'`, aliased away only when an
// APP's own code is bundled (module-map.ts's app-bundler substitution). This
// file is bundled directly by electron-vite as part of a real preload
// script, which has no such aliasing and cannot `require('path')` at all in
// a sandboxed preload -- measured: the whole preload script then fails to
// load, taking fork and thread down with it, not just spawn. Until that
// dependency is removed or the alias is reproduced for this bundle,
// `spawn.ts` never asks a host for a connection at all (its own header
// says where), and this file refuses a `'spawn'` start by name rather than
// silently mis-starting one, should anything ever reach it regardless.

import type { Orivon } from '../../contracts/capability-api.js'
import { createChildWorker } from './launch.js'
import { serveOrivon } from './orivon-server.js'
import { toWireError } from './protocol.js'
import type { FromWorker, ToWorker } from './protocol.js'
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

function workerNameFor (start: HostForkStart | HostThreadStart): string {
  return start.type === 'fork' ? `child_process fork ${new URL(start.url).pathname}` : start.name
}

/**
 * One child, from its `start-child` message onward. `port` is the HOST's own end of the
 * per-child `MessagePort` the page kept the other end of.
 */
async function startChild (port: MessagePort, start: HostStart, extra: readonly Transferable[], orivon: Orivon): Promise<void> {
  port.start()

  // See this file's own header: spawn does not route through the host yet.
  if (start.type === 'spawn') {
    port.postMessage(failedMessage(new Error('spawn does not run in a child host yet -- child_process.spawn always runs in the page (see src/shim/worker/host.ts)')))
    return
  }

  // A forked or threaded module must be on the host's own origin -- the page
  // already refuses this before ever reaching here (fork.ts's own
  // moduleUrl()), but the host re-checks rather than trusting a page that
  // could, in principle, send anything over its own port.
  if (!isSameOrigin(start.url)) {
    port.postMessage(failedMessage(new Error(`${start.type === 'fork' ? 'a forked' : 'a threaded'} module must be on the app's own origin`)))
    return
  }

  const orivonChannel = new MessageChannel()
  const server = serveOrivon(orivonChannel.port1, orivon)

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

  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    if (event.data.type === 'exit' || event.data.type === 'crash') disposeOnce()
    if (orphaned) return
    try {
      port.postMessage(event.data)
    } catch { /* the page's own port is already gone */ }
  }
  worker.onerror = (event) => {
    event.preventDefault()
    disposeOnce()
    if (!orphaned) { try { port.postMessage(failedMessage(new Error(event.message))) } catch { /* gone */ } }
  }

  port.onmessage = (event: MessageEvent<ToHostChild>) => {
    const message = event.data
    if (message.type === 'terminate') {
      worker.terminate()
      disposeOnce()
      return
    }
    worker.postMessage(message)
  }
  // Only fires once `.start()` or `.onmessage` was set on this port
  // (measured, w1-probe/results.md Q6) -- `port.start()` above and the
  // assignment just before this both already satisfy that. `addEventListener`,
  // never the `.onclose` property: measured here (Node's own `MessagePort`
  // dispatches 'close' to a listener added either way in a real Chromium
  // renderer, but only to `addEventListener` under plain Node, which is what
  // this file's own unit tests run under -- `addEventListener` is what both
  // agree on.
  port.addEventListener('close', () => {
    orphaned = true
    worker.postMessage({ type: 'stdin-end' })
    if (start.type === 'fork') worker.postMessage({ type: 'disconnect' })
  })

  worker.postMessage({ ...start, orivon: orivonChannel.port2 } as ToWorker, [orivonChannel.port2, ...extra])
}

export function createChildHost (orivon: Orivon): ChildHost {
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
