// Swarm feeds: a mutable name for content. A feed is a topic and an owner; its
// updates are single-owner chunks at indexes 0, 1, 2, ..., each signed by the
// owner and naming a content root. The newest index is found over `/chunks`
// alone, by probing for the chunk at each index; a `/feeds` answer is only a
// first guess, and is probed like any other.

import { bytesToHex } from 'viem'
import { ResolutionError } from '../resolution/records.js'
import type { PointerStep } from '../resolution/records.js'
import type { Refusal } from '../resolution/providers.js'
import { lookUpSoc } from './chunk-fetch.js'
import type { ChunkDeps } from './chunk-fetch.js'
import { cacAddress, feedUpdateAddress, isZeroPadding, readSpan, SPAN_BYTES, verifySoc } from './chunk.js'
import { referenceCid } from './reference.js'

/** The highest update index seen for each feed, kept across runs: a feed is never read as older than it has been. */
export interface FeedIndexStore {
  highest: (owner: string, topic: string) => bigint | undefined
  record: (owner: string, topic: string, index: bigint) => void
}

/** The update of a feed that was last followed, as it was signed: its index and its whole single-owner chunk. */
export interface KeptUpdate {
  readonly index: bigint
  readonly chunk: Uint8Array
}

/**
 * Where the update a feed was last followed to is kept between runs, for each partition: a signed chunk that is checked again
 * whenever it is used, so a store that lies or rots costs a request, never a wrong page. `partition` is the one a mount is given.
 */
export interface KeptFeedUpdates {
  /** What is kept for `feed` in `partition`, unchecked; undefined when nothing is, or the store cannot be read. Never rejects. */
  recallUpdate: (partition: string, feed: FeedId) => Promise<KeptUpdate | undefined>
  /** Keeps `chunk`, the verified single-owner chunk of update `index`, in place of any older one. Never throws. */
  rememberUpdate: (partition: string, feed: FeedId, index: bigint, chunk: Uint8Array) => void
  /** Deletes what is kept for `feed` while it is still update `index`, the one that failed its check; a newer one stored since stays. Never throws. */
  forgetUpdate: (partition: string, feed: FeedId, index: bigint) => void
}

export interface FeedId {
  /** Lowercase hex, 40 characters. */
  readonly owner: string
  /** Lowercase hex, 64 characters. */
  readonly topic: string
}

const OWNER = /^(?:0x)?([0-9a-fA-F]{40})$/
const TOPIC = /^(?:0x)?([0-9a-fA-F]{64})$/
const LEGACY_UPDATE_SPAN = 40
const ENCRYPTED_UPDATE_SPAN = 72
const TIMESTAMP_BYTES = 8
const INDEX_HEADER = /^[0-9a-fA-F]{1,16}$/

/** The feed a manifest's root metadata names, undefined for an ordinary site. Throws a ResolutionError for a feed this build cannot follow. */
export function feedOf (metadata: Readonly<Record<string, string>> | undefined): FeedId | undefined {
  const owner = metadata?.['swarm-feed-owner']
  const topic = metadata?.['swarm-feed-topic']
  if (owner === undefined && topic === undefined) return undefined
  const ownerHex = OWNER.exec(owner ?? '')?.[1]
  const topicHex = TOPIC.exec(topic ?? '')?.[1]
  if (ownerHex === undefined || topicHex === undefined) throw new ResolutionError('unverifiable', 'a feed manifest whose owner or topic is not hex')
  if (metadata?.['swarm-feed-type']?.toLowerCase() !== 'sequence') throw new ResolutionError('unsupported', 'a Swarm feed that is not a sequence feed, which this version of Orivon does not follow')
  return { owner: ownerHex.toLowerCase(), topic: topicHex.toLowerCase() }
}

/**
 * An endpoint's own idea of the newest index, when it has one: a guess to
 * verify, never an answer. It is asked directly, briefly and once, and what
 * it answers, or fails to, is not held against the endpoint: the search
 * simply starts from the floor without it.
 */
async function indexGuess (feed: FeedId, deps: ChunkDeps, signal: AbortSignal): Promise<bigint | undefined> {
  const ask = async (endpoint: string): Promise<bigint | undefined> => {
    try {
      const response = await deps.fetch(`${endpoint}/feeds/${feed.owner}/${feed.topic}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(deps.limits.feedGuessTimeoutMs)])
      })
      await response.body?.cancel()
      const header = response.ok ? response.headers.get('swarm-feed-index') : null
      return header !== null && INDEX_HEADER.test(header) ? BigInt(`0x${header}`) : undefined
    } catch {
      return undefined
    }
  }
  const answers = await Promise.all(deps.pool.candidates().map(ask))
  return answers.find((answer) => answer !== undefined)
}

interface Update {
  readonly index: bigint
  readonly wrapped: Uint8Array
  readonly chunk: Uint8Array
}

/**
 * The newest update any endpoint can produce a signed chunk for, never below
 * the highest index seen before. That floor, the index after it and an
 * endpoint's guess are asked at once, so a feed with no new update costs one
 * round; past the floor it jumps to a verified guess, then probes forward by
 * doubling steps until an index has no chunk, and halves the gap, which a
 * guess with no chunk also bounds. A floor whose update is gone does not end
 * the search while a later one is found. Only a 404
 * from every endpoint is the end of the feed: an endpoint that does not answer
 * ends the search as `unavailable`, never as an older update. A chunk that
 * fails its signature is a refusal, as anywhere.
 */
async function newestUpdate (feed: FeedId, floor: bigint | undefined, deps: ChunkDeps, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<Update> {
  let probes = 0
  const probe = async (index: bigint): Promise<Update | undefined> => {
    probes++
    if (probes > deps.limits.maxFeedProbes) throw new ResolutionError('unverifiable', `more than ${String(deps.limits.maxFeedProbes)} probes to find the newest update of a feed`)
    const soc = await lookUpSoc(feedUpdateAddress(feed.owner, feed.topic, index), deps, signal, onRefusal)
    return soc === undefined ? undefined : { index, wrapped: soc.wrapped, chunk: soc.chunk }
  }

  const base = floor ?? 0n
  const unneeded = new AbortController()
  let guess: bigint | undefined
  const guessing = indexGuess(feed, deps, AbortSignal.any([signal, unneeded.signal])).then((answer) => { guess = answer })
  const after = probe(base + 1n)
  after.catch(() => {})
  try {
    const atFloor = await probe(base)
    const past = await after
    if (atFloor !== undefined && past === undefined) return atFloor
    // An update below the newest can be gone from the network, so a missing floor is not yet the end of the search.
    let known = past
    let step = 2n
    let miss = -1n
    await guessing
    if (guess !== undefined && guess > base + 1n) {
      const guessed = await probe(guess)
      if (guessed === undefined) {
        miss = guess
      } else {
        known = guessed
        step = 1n
      }
    }
    if (known === undefined) throw new ResolutionError('unavailable', floor === undefined ? 'no endpoint has an update of this feed' : `no endpoint has update ${String(floor)} of this feed, which was seen before`)

    while (miss < 0n) {
      const next = await probe(known.index + step)
      if (next === undefined) {
        miss = known.index + step
      } else {
        known = next
        step *= 2n
      }
    }
    while (miss - known.index > 1n) {
      const middle: bigint = known.index + (miss - known.index) / 2n
      const found = await probe(middle)
      if (found === undefined) miss = middle
      else known = found
    }
    return known
  } finally {
    unneeded.abort()
  }
}

/** The root reference an update carries: the reference in a legacy update, otherwise the update's own chunk is the root. */
function targetOf (wrapped: Uint8Array): string {
  const { size } = readSpan(wrapped)
  const payload = wrapped.subarray(SPAN_BYTES)
  if (size === ENCRYPTED_UPDATE_SPAN) throw new ResolutionError('unsupported', 'a Swarm feed update holding an encrypted reference, which this version of Orivon does not read')
  if (size !== LEGACY_UPDATE_SPAN) return bytesToHex(cacAddress(wrapped)).slice(2)
  // BMT pads a payload with zeros, so zero bytes past the span are the same chunk.
  if (payload.length < LEGACY_UPDATE_SPAN || !isZeroPadding(payload.subarray(LEGACY_UPDATE_SPAN))) throw new ResolutionError('unverifiable', 'a feed update whose payload is not a timestamp and a reference')
  return bytesToHex(payload.subarray(TIMESTAMP_BYTES, LEGACY_UPDATE_SPAN)).slice(2)
}

export interface ResolvedFeed {
  /** The reference the feed's newest update points at, lowercase hex. */
  readonly root: string
  readonly step: PointerStep
  readonly index: bigint
  /** The update's whole single-owner chunk, which is what `KeptFeedUpdates` keeps. */
  readonly chunk: Uint8Array
}

/** Throws a ResolutionError. */
export async function resolveFeed (feed: FeedId, deps: ChunkDeps, store: FeedIndexStore, signal: AbortSignal, onRefusal: (refusal: Refusal) => void): Promise<ResolvedFeed> {
  const update = await newestUpdate(feed, store.highest(feed.owner, feed.topic), deps, signal, onRefusal)
  store.record(feed.owner, feed.topic, update.index)
  const root = targetOf(update.wrapped)
  return { root, step: { step: 'swarm-feed', owner: feed.owner, topic: feed.topic, index: update.index, target: referenceCid(root) }, index: update.index, chunk: update.chunk }
}

/**
 * The update `kept` holds for `feed`, followed without a request: checked against the address it was signed for, as a chunk
 * from the network is, and never below the highest index seen before, so a feed is no older than it has been. A kept update
 * that fails its check is forgotten; one that is merely older than the store has seen is left for the network read to replace.
 * Undefined means ask the network.
 */
export async function followKept (feed: FeedId, partition: string, kept: KeptFeedUpdates, store: FeedIndexStore): Promise<ResolvedFeed | undefined> {
  const found = await kept.recallUpdate(partition, feed)
  if (found === undefined) return undefined
  const olderThanSeen = (): boolean => {
    const seen = store.highest(feed.owner, feed.topic)
    return seen !== undefined && found.index < seen
  }
  if (olderThanSeen()) return undefined
  const soc = await verifySoc(feedUpdateAddress(feed.owner, feed.topic, found.index), found.chunk)
  let root: string | undefined
  try {
    if (soc !== undefined) root = targetOf(soc.wrapped)
  } catch (error) {
    if (!(error instanceof ResolutionError)) throw error
  }
  if (soc === undefined || root === undefined) {
    kept.forgetUpdate(partition, feed, found.index)
    return undefined
  }
  // The check awaited: another partition's look may have recorded a higher index meanwhile.
  if (olderThanSeen()) return undefined
  store.record(feed.owner, feed.topic, found.index)
  return { root, step: { step: 'swarm-feed', owner: feed.owner, topic: feed.topic, index: found.index, target: referenceCid(root) }, index: found.index, chunk: found.chunk }
}
