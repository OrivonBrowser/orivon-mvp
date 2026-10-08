// Report responders: what the virtual device does with a report the host wrote to it.
export type Send = (report: Uint8Array) => void
export type Responder = (report: Uint8Array, send: Send) => void | Promise<void>

export const echoResponder: Responder = (report, send) => { send(report) }

/**
 * Hands reports to `handler` one at a time, in arrival order, even when a handler is still
 * answering the one before. A handler that throws is reported to `onError` and the queue goes on.
 */
export function serialQueue (handler: Responder, send: Send, onError: (error: unknown) => void): (report: Uint8Array) => Promise<void> {
  let tail: Promise<void> = Promise.resolve()
  return (report) => {
    tail = tail.then(() => handler(report, send)).catch(onError)
    return tail
  }
}

/** `echo`, or the default export of the module at `spec` (which may itself be a promise). */
export async function loadResponder (spec: string): Promise<Responder> {
  if (spec === 'echo') return echoResponder
  const loaded = await import(spec) as { default?: unknown }
  const handler = await loaded.default
  if (typeof handler !== 'function') throw new TypeError(`${spec} must export a function as default`)
  return handler as Responder
}
