// `worker_threads` module target (module-map.ts): a thread is a child
// Worker from the same blob runtime child_process.fork uses (Worker,
// ../child-process/thread.ts), started over its own MessageChannel.
// isMainThread/threadId/parentPort/workerData/resourceLimits read the
// registered symbol runtime-thread.ts sets before importing the app module
// that evaluates this file, so every bundle's copy of this polyfill agrees
// with the thread it is actually running in.

import { refuseShim } from '../errors.js'
import { Worker } from '../child-process/thread.js'
import { NodeMessagePort, createMessageChannel } from '../worker/node-port.js'
import { WORKER_THREADS_SYMBOL, type WorkerThreadsGlobals } from '../worker/runtime-thread.js'
import { nodeModule } from './module-proxy.js'

export { Worker }

const registered = (globalThis as unknown as Record<symbol, WorkerThreadsGlobals | undefined>)[WORKER_THREADS_SYMBOL]

export const isMainThread = registered === undefined
export const threadId = registered?.threadId ?? 0
export const parentPort = registered?.parentPort ?? null
export const workerData = registered?.workerData ?? null
export const resourceLimits = registered?.resourceLimits ?? {}
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

export class MessageChannel {
  readonly port1: NodeMessagePort
  readonly port2: NodeMessagePort

  constructor () {
    const channel = createMessageChannel()
    this.port1 = channel.port1
    this.port2 = channel.port2
  }
}

export const MessagePort = NodeMessagePort
export const BroadcastChannel = globalThis.BroadcastChannel

function receiveMessageOnPort (): never {
  throw refuseShim('worker_threads.receiveMessageOnPort', 'not-applicable',
    'a web MessagePort cannot be read synchronously: read its \'message\' event instead')
}

function moveMessagePortToContext (): never {
  throw refuseShim('worker_threads.moveMessagePortToContext', 'unimplemented',
    'moving a port to another vm context needs a vm context of its own, which this shim does not build (vm.createContext)')
}

export default nodeModule('worker_threads', {
  isMainThread, threadId, parentPort, workerData, resourceLimits, SHARE_ENV,
  getEnvironmentData, setEnvironmentData, markAsUntransferable, isMarkedAsUntransferable,
  Worker, MessageChannel, MessagePort, BroadcastChannel, receiveMessageOnPort, moveMessagePortToContext
})
