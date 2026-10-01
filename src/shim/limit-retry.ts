// The per-origin limiter refuses a call before it runs, so asking again cannot repeat an effect. A program that
// starts with a burst of file and socket calls (loading its data files beside another one doing the same) would
// otherwise fail the first call past the bucket; the pauses total about five seconds, then the refusal is the
// call's own error. Shared by the asynchronous fs calls and the net calls that open a socket or a listener.

export const LIMIT_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 200, 200, 400, 400, 400, 800, 800, 800] as const

export function isLimit (error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'limit'
}

const delay = async (ms: number): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, ms)) }

/** `run`, asked again while the limiter refuses it; any other error, or the last refusal, is thrown as it came. */
export async function retryLimited<T> (run: () => Promise<T>, pause: (ms: number) => Promise<void> = delay): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      const wait = LIMIT_RETRY_DELAYS_MS[attempt]
      if (wait === undefined || !isLimit(error)) throw error
      await pause(wait)
    }
  }
}
