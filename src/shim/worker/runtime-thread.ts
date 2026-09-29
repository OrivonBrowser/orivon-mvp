// Inside the Worker: gives an app module the Node process a worker_threads
// thread has, over setupChildProcess (runtime-fork.ts): argv/env/cwd,
// stdout/stderr posting, process.exit ending only the thread, and uncaught
// errors reaching 'error' then 'exit' 1. No IPC (a thread has no send or
// connected): `parentPort` is its own MessageChannel, wrapped in Node's
// event shape (node-port.ts) and published where every bundle's copy of the
// worker_threads polyfill reads it, under a registered symbol, before the
// module that reads isMainThread/parentPort/workerData at evaluation time is
// imported.

import { Buffer } from 'buffer'
import type { ParentChannel } from './parent.js'
import type { ThreadStart } from './protocol.js'
import { type ForkScope, setupChildProcess } from './runtime-fork.js'
import { wrapPort, wrapPorts } from './node-port.js'
import { WORKER_THREADS_SYMBOL, type WorkerThreadsGlobals } from './symbols.js'

export async function runThread (start: ThreadStart, parent: ParentChannel, scope: ForkScope, load: (url: string) => Promise<unknown>): Promise<void> {
  const { proc, liveness, crash } = setupChildProcess(scope, parent, start)
  // Node's stdin option: false (the default) never provides data, so a thread reading it sees EOF at once.
  if (!start.stdin) proc.stdin.push(null)
  parent.onMessage((message) => {
    if (message.type === 'stdin') proc.stdin.push(Buffer.from(message.data))
    else if (message.type === 'stdin-end') proc.stdin.push(null)
  })

  // A ref'd parentPort listener is what keeps a thread running on its own, as Node's does; unref()/close() release it.
  const parentPort = wrapPort(start.parentPort, (active) => { if (active) liveness.ref(); else liveness.unref() })
  // Only a 'message' payload was wrapped one level deep before this: workerData needs the same
  // treatment, or a port inside it reaches the thread as a raw web MessagePort with no `.on`.
  ;(scope as unknown as Record<symbol, WorkerThreadsGlobals>)[WORKER_THREADS_SYMBOL] = {
    threadId: start.threadId, workerData: wrapPorts(start.workerData), parentPort, resourceLimits: {}
  }

  parent.post({ type: 'started' })
  liveness.ref()
  try {
    await load(start.url)
  } catch (error) {
    crash(error)
  }
  liveness.unref()
}
