// The verifier host's side of the Swarm node: before each Swarm mount it tells
// main the node is wanted, and holds the mount until main reports the node
// ready, or says in plain words why it will not be.

import { ResolutionError } from '../resolution/records.js'
import type { SwarmNodeNotice } from '../swarm-node/protocol.js'
import type { FromHost } from './protocol.js'

/** Within the 30 s a mount may take, how long it waits for the node to find its peers. */
export const NODE_WAIT_MS = 20_000

export interface SwarmNodeLink {
  /** Asks for the node and resolves once it is ready; rejects `unavailable` with the reason otherwise. */
  ensure: (signal: AbortSignal) => Promise<void>
  /** What main says the node is doing. */
  notice: (notice: SwarmNodeNotice) => void
}

const STILL_STARTING = "Orivon's Swarm node is still finding peers. Try again in a moment."

function unavailable (state: SwarmNodeNotice['state'], reason: string | undefined): ResolutionError {
  const why = reason === undefined || reason === '' ? '' : `: ${reason}`
  if (state === 'off') return new ResolutionError('unavailable', `Swarm content loads only from the Swarm node Orivon runs on this computer, and it is off${why}`)
  if (state === 'failed') return new ResolutionError('unavailable', `Swarm content loads only from the Swarm node Orivon runs on this computer, and it is not running${why}`)
  return new ResolutionError('unavailable', STILL_STARTING)
}

export function createSwarmNodeLink (post: (message: FromHost) => void, waitMs = NODE_WAIT_MS): SwarmNodeLink {
  let current: SwarmNodeNotice | undefined
  const waiting = new Set<() => void>()
  return {
    notice: (notice) => {
      current = notice
      for (const wake of [...waiting]) wake()
    },
    ensure: async (signal) => {
      // Only a ready node is taken as it was told: any other state is main's answer to this ask, not to an earlier one.
      if (current?.state !== 'ready') current = undefined
      post({ type: 'swarm-node-wanted' })
      await new Promise<void>((resolve) => {
        const finished = (): boolean => current?.state === 'ready' || current?.state === 'off' || current?.state === 'failed'
        if (current?.state === 'ready') { resolve(); return }
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
      if (current?.state !== 'ready') throw unavailable(current?.state ?? 'starting', current?.reason)
    }
  }
}
