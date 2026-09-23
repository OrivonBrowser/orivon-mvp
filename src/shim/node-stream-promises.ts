// `stream/promises` module target (module-map.ts): the page's `stream`
// pipeline and finished, returning promises instead of taking a callback.

import { finished as finishedCallback, pipeline as pipelineCallback } from 'stream'
import { nodeModule } from './node-module-proxy.js'

type Callback = (error?: Error | null) => void

export function pipeline (...streams: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const done: Callback = (error) => { if (error !== null && error !== undefined) reject(error); else resolve() }
    Reflect.apply(pipelineCallback, undefined, [...streams, done])
  })
}

interface StreamState { _readableState?: { endEmitted?: boolean }, _writableState?: { finished?: boolean } }

/** readable-stream 3's finished waits for an event, so it never calls back for a stream already done; Node's resolves at once. */
function alreadyFinished (stream: unknown): boolean {
  const { _readableState: readable, _writableState: writable } = (stream ?? {}) as StreamState
  if (readable === undefined && writable === undefined) return false
  return (readable === undefined || readable.endEmitted === true) && (writable === undefined || writable.finished === true)
}

export function finished (stream: unknown, options?: object): Promise<void> {
  if (alreadyFinished(stream)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const done: Callback = (error) => { if (error !== null && error !== undefined) reject(error); else resolve() }
    Reflect.apply(finishedCallback, undefined, options === undefined ? [stream, done] : [stream, options, done])
  })
}

export default nodeModule('stream/promises', { pipeline, finished })
