// The verifier host's side of the Swarm node: before each Swarm mount it tells
// main the node is wanted, and holds the mount until main reports the node
// ready, or says in plain words why it will not be. Chunk reads from the node
// keep it awake and, when the node is gone, ask for it again.

import { ResolutionError } from '../resolution/records.js'
import type { Fetch } from '../gateways/gateways.js'
import type { SwarmNodeNotice } from '../swarm-node/protocol.js'
import type { FromHost } from './protocol.js'

/** Within the 30 s a mount may take, how long it waits for the node to find its peers. */
export const NODE_WAIT_MS = 20_000
/** Chunk reads tell main the node is in use at most this often. */
export const TOUCH_EVERY_MS = 5_000

export interface SwarmNodeLink {
  /** Asks for the node and resolves once it is ready; rejects `unavailable` with the reason otherwise. */
  ensure: (signal: AbortSignal) => Promise<void>
  /** What main says the node is doing. */
  notice: (notice: SwarmNodeNotice) => void
  /** A chunk is being read from the node: refreshes its idle wait, with a message every few seconds at most. */
  touch: () => void
  /** `fetch` for the node's endpoint: each read keeps the node awake, and a read that finds it gone asks for it again once, as a mount does. */
  reading: (fetch: Fetch) => Fetch
}

const STILL_STARTING = "Orivon's Swarm node is still finding peers. Try again in a moment."

function unavailable (answer: SwarmNodeNotice | undefined): ResolutionError {
  const why = answer?.reason === undefined || answer.reason === '' ? '' : `: ${answer.reason}`
  if (answer?.state === 'off') return new ResolutionError('unavailable', `Swarm content loads only from the Swarm node Orivon runs on this computer, and it is off${why}`)
  if (answer?.state === 'failed') return new ResolutionError('unavailable', `Swarm content loads only from the Swarm node Orivon runs on this computer, and it is not running${why}`)
  return new ResolutionError('unavailable', STILL_STARTING)
}

export interface LinkOptions {
  readonly waitMs?: number
  readonly touchEveryMs?: number
  readonly now?: () => number
}

export function createSwarmNodeLink (post: (message: FromHost) => void, options: LinkOptions = {}): SwarmNodeLink {
  const waitMs = options.waitMs ?? NODE_WAIT_MS
  const touchEveryMs = options.touchEveryMs ?? TOUCH_EVERY_MS
  const now = options.now ?? Date.now
  /** What main last said, and how many notices there have been: an answer to an ask is a notice after it. */
  let current: SwarmNodeNotice | undefined
  let notices = 0
  let askedAt = Number.NEGATIVE_INFINITY
  let refreshing: Promise<void> | undefined
  const waiting = new Set<() => void>()

  const ask = (): void => {
    askedAt = now()
    post({ type: 'swarm-node-wanted' })
  }

  /** Asks, then waits for main's answer to this ask (or, unless `fresh`, takes a node already known ready). */
  async function wait (signal: AbortSignal, fresh: boolean): Promise<void> {
    signal.throwIfAborted()
    const seen = notices
    ask()
    if (!fresh && current?.state === 'ready') return
    const finished = (): boolean => notices > seen && current !== undefined && current.state !== 'starting'
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', done)
        waiting.delete(check)
        resolve()
      }
      const check = (): void => { if (finished()) done() }
      const timer = setTimeout(done, waitMs)
      signal.addEventListener('abort', done, { once: true })
      waiting.add(check)
    })
    signal.throwIfAborted()
    // The notice each waiter reads is the one in `current`, which a later ask does not clear for it.
    if (notices > seen && current?.state === 'ready') return
    throw unavailable(notices > seen ? current : undefined)
  }

  const link: SwarmNodeLink = {
    notice: (notice) => {
      current = notice
      notices += 1
      for (const wake of [...waiting]) wake()
    },
    ensure: async (signal) => { await wait(signal, false) },
    touch: () => {
      if (now() - askedAt >= touchEveryMs) ask()
    },
    reading: (fetch) => async (url, init) => {
      link.touch()
      try {
        return await fetch(url, init)
      } catch (error) {
        if (init.signal.aborted) throw error
        // Gone, or only slow: main answers either way, and a node that is back is read again once.
        refreshing ??= wait(new AbortController().signal, true).finally(() => { refreshing = undefined })
        await refreshing
        return await fetch(url, init)
      }
    }
  }
  return link
}
