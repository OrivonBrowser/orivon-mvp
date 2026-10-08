// The per-origin limiter refuses a call before it runs, so asking again cannot repeat an effect. A program that
// starts with a burst of file and socket calls (loading its data files beside another one doing the same) would
// otherwise fail the first call past the bucket; the pauses total about five seconds, then the refusal is the
// call's own error. Shared by the asynchronous fs calls and the net calls that open a socket or a listener.
//
// The broker also holds an origin to LIMITS.inFlightOperations calls at once, plus as many waiting, and refuses
// the rest. Node never refuses a file call for being one too many: libuv queues it. So the asynchronous fs calls
// also queue here, in order, under half that bound (fsQueue), and a program writing at full speed (a torrent
// client) waits where Node would wait instead of meeting a refusal its code never expects.

import { LIMITS } from '../contracts/limits.js'

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

/** Runs each call once fewer than `max` are running, in the order they were asked; the rest wait without limit. */
export function createCallQueue (max: number): <T>(run: () => Promise<T>) => Promise<T> {
  let running = 0
  const waiting: Array<() => void> = []
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (running < max) running += 1
    // A finishing call hands its place straight to the next one, so a newcomer cannot take it between the two.
    else await new Promise<void>((resolve) => { waiting.push(resolve) })
    try {
      return await run()
    } finally {
      const next = waiting.shift()
      if (next === undefined) running -= 1
      else next()
    }
  }
}

/** The asynchronous fs calls of this realm, kept to half the broker's per-origin bound so net calls and other realms keep room. */
export const fsQueue = createCallQueue(Math.floor(LIMITS.inFlightOperations / 2))
