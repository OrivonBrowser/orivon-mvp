// How many peers the node has, from its HTTP API (Bee's shape) or, when the
// API answers in a shape that has no count, from its log.

import type { Fetcher } from '../local-node/kind.js'
import type { FromNode } from '../local-node/protocol.js'

export type { Fetcher }

/** The node counts as ready at this many connected peers. */
export const READY_PEERS = 8

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** `/peers` lists them; `/topology` counts the connected ones. */
export function peerCountOf (body: unknown): number | undefined {
  if (!isRecord(body)) return undefined
  if (Array.isArray(body['peers'])) return body['peers'].length
  const connected = body['connected']
  return typeof connected === 'number' && Number.isInteger(connected) && connected >= 0 ? connected : undefined
}

/** The node logs `peer_set_size=<n>` as its peer set changes. */
export function peerCountOfLog (line: string): number | undefined {
  const found = /peer_set_size=(\d+)/.exec(line)
  return found?.[1] === undefined ? undefined : Number(found[1])
}

const API_PATHS = ['/peers', '/topology'] as const
const ANSWER_MS = 3_000

export interface Poll {
  /** Whether the API answered at all. */
  readonly answered: boolean
  readonly peers: number | undefined
}

export async function pollPeers (base: string, fetcher: Fetcher): Promise<Poll> {
  let answered = false
  for (const path of API_PATHS) {
    try {
      const response = await fetcher(`${base}${path}`, AbortSignal.timeout(ANSWER_MS))
      answered = true
      if (!response.ok) continue
      const count = peerCountOf(await response.json())
      if (count !== undefined) return { answered, peers: count }
    } catch {
      // Not listening yet, or a body that is not JSON: the next path, then the next poll.
    }
  }
  return { answered, peers: undefined }
}

export interface WatchDeps {
  readonly base: string
  readonly fetcher: Fetcher
  readonly post: (message: FromNode) => void
  /** The newest peer count the node's log gave, for an API that has none. */
  readonly logPeers: () => number | undefined
  readonly everyMs: number
}

/** Reports `listening` once the API answers, `peers` as the count changes, and `ready` once at READY_PEERS. Returns the call that stops it. */
export function watchReadiness (deps: WatchDeps): () => void {
  let stopped = false
  let polling = false
  let listening = false
  let ready = false
  let last: number | undefined
  const poll = async (): Promise<void> => {
    const result = await pollPeers(deps.base, deps.fetcher)
    if (stopped) return
    if (result.answered && !listening) {
      listening = true
      deps.post({ type: 'listening' })
    }
    const count = result.peers ?? (result.answered ? deps.logPeers() : undefined)
    if (count === undefined) return
    if (count !== last) {
      last = count
      deps.post({ type: 'peers', count })
    }
    if (count >= READY_PEERS && !ready) {
      ready = true
      deps.post({ type: 'ready', peers: count })
    }
  }
  const timer = setInterval(() => {
    if (polling) return
    polling = true
    void poll().finally(() => { polling = false })
  }, deps.everyMs)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
