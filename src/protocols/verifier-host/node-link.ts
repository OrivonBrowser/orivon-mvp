// The verifier host's side of a local node, for any kind of node by its name:
// before a mount that reads from the node it tells main the node is wanted,
// and holds the mount until main reports the node ready, or says in plain
// words why it will not be. Reads from the node keep it awake and, when the
// node is gone, ask for it again.

import { ResolutionError } from '../resolution/records.js'
import type { Fetch } from '../gateways/gateways.js'
import type { NodeIdentity } from '../local-node/kind.js'
import type { FromHost, NodeNotice } from './protocol.js'
import { createNodeTraffic } from './node-traffic.js'

/** Within the 30 s a mount may take, how long it waits for the node to find its peers. */
export const NODE_WAIT_MS = 20_000
/** Chunk reads tell main the node is in use at most this often. */
export const TOUCH_EVERY_MS = 5_000

/** What a kind says to the person when its node cannot serve a mount. */
export interface NodeWords {
  /** The content that loads only from the node: `Swarm content`. */
  readonly content: string
  /** Said when the node is still starting once a mount's wait ends. */
  readonly starting: string
}

export interface NodeLink {
  /** Asks for the node and resolves once it is ready; rejects `unavailable` with the reason otherwise. */
  ensure: (signal: AbortSignal) => Promise<void>
  /** What main says the node is doing. */
  notice: (notice: NodeNotice) => void
  /** A chunk is being read from the node: refreshes its idle wait, with a message every few seconds at most. */
  touch: () => void
  /** What this link has read from the node: reads in flight and bytes, as it last counted them. */
  snapshot: () => { readonly active: number, readonly bytes: number }
  /** `fetch` for the node's endpoint: each read keeps the node awake, and a read that finds it gone asks for it again once, as a mount does. */
  reading: (fetch: Fetch) => Fetch
}

/** A node that will not serve this mount. `why` is the reason alone, for a reader that has another source to use instead. */
export class NodeUnavailable extends ResolutionError {
  constructor (message: string, readonly why: string) {
    super('unavailable', message)
  }
}

function unavailable (identity: NodeIdentity, words: NodeWords, answer: NodeNotice | undefined): NodeUnavailable {
  const reason = answer?.reason === undefined || answer.reason === '' ? undefined : answer.reason
  const why = reason === undefined ? '' : `: ${reason}`
  if (answer?.state === 'off') return new NodeUnavailable(`${words.content} loads only from the ${identity.noun} Orivon runs on this computer, and it is off${why}`, reason ?? `the ${identity.noun} is off`)
  if (answer?.state === 'failed') return new NodeUnavailable(`${words.content} loads only from the ${identity.noun} Orivon runs on this computer, and it is not running${why}`, reason ?? `the ${identity.noun} is not running`)
  return new NodeUnavailable(words.starting, `the ${identity.noun} is still starting`)
}

export interface LinkOptions {
  readonly waitMs?: number
  readonly touchEveryMs?: number
  readonly now?: () => number
}

export function createNodeLink (post: (message: FromHost) => void, identity: NodeIdentity, words: NodeWords, options: LinkOptions = {}): NodeLink {
  const waitMs = options.waitMs ?? NODE_WAIT_MS
  const touchEveryMs = options.touchEveryMs ?? TOUCH_EVERY_MS
  const now = options.now ?? Date.now
  /** What main last said, and how many notices there have been: an answer to an ask is a notice after it. */
  let current: NodeNotice | undefined
  let notices = 0
  let askedAt = Number.NEGATIVE_INFINITY
  let refreshing: Promise<void> | undefined
  const waiting = new Set<() => void>()
  const traffic = createNodeTraffic((active, bytes) => { post({ type: 'node-traffic', node: identity.name, active, bytes }) }, options.now === undefined ? {} : { now: options.now })
  /** A read counts from its start to the end of its body, so a popup can say what the node is doing for the person. */
  const counted = (fetch: Fetch): Fetch => async (url, init) => {
    traffic.begin()
    try {
      return traffic.wrap(await fetch(url, init), init.signal)
    } catch (error) {
      traffic.end()
      throw error
    }
  }

  const ask = (): void => {
    askedAt = now()
    post({ type: 'node-wanted', node: identity.name })
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
    throw unavailable(identity, words, notices > seen ? current : undefined)
  }

  const link: NodeLink = {
    notice: (notice) => {
      current = notice
      notices += 1
      for (const wake of [...waiting]) wake()
    },
    ensure: async (signal) => { await wait(signal, false) },
    snapshot: traffic.snapshot,
    touch: () => {
      if (now() - askedAt >= touchEveryMs) ask()
    },
    reading: (plain) => async (url, init) => {
      const fetch = counted(plain)
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

/** The links to every node the host reads from, each made on first use, and the one place a notice from main is routed by the node's name. */
export class NodeLinks {
  private readonly links = new Map<string, NodeLink>()

  constructor (private readonly post: (message: FromHost) => void, private readonly options: LinkOptions = {}) {}

  to (identity: NodeIdentity, words: NodeWords): NodeLink {
    let link = this.links.get(identity.name)
    if (link === undefined) {
      link = createNodeLink(this.post, identity, words, this.options)
      this.links.set(identity.name, link)
    }
    return link
  }

  /** Main's word about a node; one nothing here asked about is dropped. */
  notice (notice: NodeNotice): void {
    this.links.get(notice.node)?.notice(notice)
  }
}
