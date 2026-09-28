// `timers/promises` module target (module-map.ts), hand-written over the
// page's own timers. An aborted `signal` rejects with Node's AbortError and
// clears the pending timer.

import { nodeModule } from './module-proxy.js'

interface TimerOptions { signal?: AbortSignal | undefined }

function abortError (signal: AbortSignal): Error {
  return Object.assign(new Error('The operation was aborted', { cause: signal.reason }), { name: 'AbortError', code: 'ABORT_ERR' })
}

function scheduled<T> (schedule: (fire: () => void) => unknown, cancel: (handle: unknown) => void, value: T, options: TimerOptions | undefined): Promise<T> {
  const signal = options?.signal
  if (signal?.aborted === true) return Promise.reject(abortError(signal))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { cancel(handle); reject(abortError(signal as AbortSignal)) }
    const handle = schedule(() => { signal?.removeEventListener('abort', onAbort); resolve(value) })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function setTimeout<T = void> (delay?: number, value?: T, options?: TimerOptions): Promise<T> {
  return scheduled((fire) => globalThis.setTimeout(fire, delay), (handle) => { globalThis.clearTimeout(handle as number) }, value as T, options)
}

/** Over the global setImmediate the preload installs, read at call time: a module may load before it exists. */
export function setImmediate<T = void> (value?: T, options?: TimerOptions): Promise<T> {
  return scheduled((fire) => globalThis.setImmediate(fire), (handle) => { globalThis.clearImmediate(handle as NodeJS.Immediate) }, value as T, options)
}

export default nodeModule('timers/promises', { setTimeout, setImmediate })
