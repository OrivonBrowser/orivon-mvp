// `worker_threads` module target (module-map.ts): what is true on an app's
// page, which is Node's main thread, so code that only asks where it runs
// works. Starting a thread refuses by name: none runs yet.

import { refuseShim } from '../errors.js'
import { nodeModule } from './module-proxy.js'

export const isMainThread = true
export const threadId = 0
export const parentPort = null
export const workerData = null
export const resourceLimits = {}
export const SHARE_ENV = Symbol.for('nodejs.worker_threads.SHARE_ENV')

const environmentData = new Map<unknown, unknown>()

export function getEnvironmentData (key: unknown): unknown {
  return environmentData.get(key)
}

export function setEnvironmentData (key: unknown, value: unknown): void {
  if (value === undefined) environmentData.delete(key)
  else environmentData.set(key, value)
}

const untransferable = new WeakSet<object>()

export function markAsUntransferable (object: unknown): void {
  if (typeof object === 'object' && object !== null) untransferable.add(object)
}

export function isMarkedAsUntransferable (object: unknown): boolean {
  return typeof object === 'object' && object !== null && untransferable.has(object)
}

export class Worker {
  constructor () {
    throw refuseShim('worker_threads.Worker', 'not-built',
      'worker_threads.Worker has no implementation yet: a thread would run in a Web Worker, as ' +
      'child_process.fork runs an app module today (docs/planning/compatibility-matrix.md Table 4)')
  }
}

export default nodeModule('worker_threads', {
  isMainThread, threadId, parentPort, workerData, resourceLimits, SHARE_ENV,
  getEnvironmentData, setEnvironmentData, markAsUntransferable, isMarkedAsUntransferable, Worker
})
