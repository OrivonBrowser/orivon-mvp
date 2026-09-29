// The registered symbols a child Worker's runtime publishes on its global
// scope for code bundled separately to find: registered (Symbol.for), so
// each bundle's copy of the shim reads the same one. A leaf module, so the
// page's worker_threads polyfill can name them without importing the
// runtime that sets them.

import type { NodeMessagePort } from './node-port.js'

/** Where a nested worker_threads.Worker's ref()/unref() reach a forked child's own Liveness, so a ref'd thread keeps the fork alive (../child-process/thread.ts). */
export const FORK_LIVENESS_SYMBOL = Symbol.for('orivon.worker.fork-liveness')

/** Where the worker_threads polyfill reads isMainThread/threadId/parentPort/workerData, set before the app module imports it (runtime-thread.ts). */
export const WORKER_THREADS_SYMBOL = Symbol.for('orivon.worker_threads')

export interface WorkerThreadsGlobals {
  readonly threadId: number
  readonly workerData: unknown
  readonly parentPort: NodeMessagePort
  readonly resourceLimits: Record<string, never>
}
