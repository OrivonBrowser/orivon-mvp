// ADR-0046's own host logic: for every page that connects, a new child
// starts a real Worker here -- never in the page -- and this relays between
// the page's own dedicated port for that child (./host-protocol.ts) and the
// Worker's ordinary ./protocol.ts traffic. No `electron` import: everything
// here is `MessagePort`, `MessageChannel` and a Web Worker, the same
// contract ../child-process/spawn.ts's own `launch()` already keeps for a
// same-process child.

import { loadProgram } from '../child-process/program.js'
import type { Orivon } from '../../contracts/capability-api.js'
import { createChildWorker } from './launch.js'
import { serveOrivon } from './orivon-server.js'
import { toWireError } from './protocol.js'
import type { FromWorker, ToWorker } from './protocol.js'
import type { HostStart, StartChildMessage, ToHostChild } from './host-protocol.js'

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
  if (start.type === 'spawn') return `child_process ${start.command}`
  if (start.type === 'fork') return `child_process fork ${new URL(start.url).pathname}`
  return start.name
}

/**
 * One child, from its `start-child` message onward. `port` is the HOST's own end of the
 * per-child `MessagePort` the page kept the other end of.
 */
async function startChild (port: MessagePort, start: HostStart, extra: readonly Transferable[], orivon: Orivon): Promise<void> {
  port.start()

  // A forked or threaded module must be on the host's own origin -- the page
  // already refuses this before ever reaching here (fork.ts's own
  // moduleUrl()), but the host re-checks rather than trusting a page that
  // could, in principle, send anything over its own port.
  if ((start.type === 'fork' || start.type === 'thread') && !isSameOrigin(start.url)) {
    port.postMessage(failedMessage(new Error(`${start.type === 'fork' ? 'a forked' : 'a threaded'} module must be on the app's own origin`)))
    return
  }

  let programBase: Omit<ToWorker & { type: 'spawn' }, 'orivon'> | undefined
  if (start.type === 'spawn') {
    let program
    try {
      program = await loadProgram(start.command, start.args)
    } catch (error) {
      port.postMessage(failedMessage(error))
      return
    }
    programBase = { type: 'spawn', program, args: start.args, env: start.env, preopens: start.preopens }
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

  const finalStart = (programBase ?? (start as Omit<ToWorker, 'orivon'>)) as Omit<ToWorker, 'orivon'>
  worker.postMessage({ ...finalStart, orivon: orivonChannel.port2 } as ToWorker, [orivonChannel.port2, ...extra])
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
