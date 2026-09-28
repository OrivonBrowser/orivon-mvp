/** `promise`, or a rejection once `ms` pass first. The timer is cleared
 * either way, so a promise that settles in time leaves nothing pending. */
export async function withTimeout<T> (promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new Error(`${what} took longer than ${String(ms / 1000)} s`)) }, ms)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Waits `ms`, or returns early once `signal` aborts. Never rejects: the
 * caller checks `signal` itself after the wait. */
export async function sleepOrAbort (ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** `promise`, or a rejection with `signal.reason` once `signal` aborts
 * first: for a caller that stops waiting on work others may still share. */
export async function unlessAborted<T> (promise: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (signal === null || signal === undefined) return await promise
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}
