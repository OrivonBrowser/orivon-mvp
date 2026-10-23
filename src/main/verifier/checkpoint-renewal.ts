// Which checkpoint the light client starts from, and renewing it at run time when the release's and the stored one have
// both aged out (ADR-0092) or the beacon server has no bootstrap for the one in use (ADR-0098). The choice is the pure rule in checkpoint.ts; the fetch is checkpoint-fetch.ts, one attempt
// at a time with a wait after a failure. No `electron` import: the store, the switch and the notice come in.

import shippedCheckpoint from './mainnet-checkpoint.json'
import { chooseCheckpoint, MAX_CHECKPOINT_AGE_SECONDS, slotTimestamp } from './checkpoint.js'
import type { Checkpoint, CheckpointChoice } from './checkpoint.js'
import { CheckpointFetcher, fetchAgreedCheckpoint } from './checkpoint-fetch.js'
import type { FetchProblem } from './checkpoint-fetch.js'
import { beaconJson } from './checkpoint-fetch-net.js'
import { DEFAULT_ENDPOINTS } from './endpoints.js'
import { shippedCheckpointAgeDays, testBeaconApis } from './test-seam.js'
import type { VerifierStore } from './verifier-store.js'

const SHIPPED_CHECKPOINT = { root: shippedCheckpoint.root, timestamp: slotTimestamp(shippedCheckpoint.slot) }

export interface RenewalDeps {
  readonly store: () => VerifierStore
  /** Whether the light client is switched off, by the environment or the person: nothing is renewed then. */
  readonly switchedOff: () => boolean
  /** What the view says may have changed. */
  readonly changed: () => void
  /** Puts the host to sleep and starts it again, so that its configuration is built with the checkpoint now chosen. */
  readonly restartHost: () => void
}

export class CheckpointRenewal {
  private readonly fetcher = new CheckpointFetcher({
    run: async () => await fetchAgreedCheckpoint(beaconJson, this.servers(), this.consensusRpc(), Math.floor(Date.now() / 1000)),
    now: () => Date.now()
  })

  /** The last choice made, which a gateway address asks about on every navigation without reading the stored file again. */
  chosen: CheckpointChoice | undefined

  /** The root the running host was given, so that a bootstrap failure is held against the checkpoint that caused it. */
  startedWith: string | undefined

  /** Roots the beacon server has no bootstrap for: none is chosen again in this run. */
  private readonly unserved = new Set<string>()

  constructor (private readonly deps: RenewalDeps) {}

  /** The servers asked; a test build may name its own. */
  servers (): readonly string[] {
    return testBeaconApis() ?? DEFAULT_ENDPOINTS.checkpointBeaconApis
  }

  /** The server the light client bootstraps from, and the one whose bootstrap a renewed checkpoint must have; a test build's first server stands in for it. */
  consensusRpc (): string {
    return testBeaconApis()?.[0] ?? DEFAULT_ENDPOINTS.consensusRpc
  }

  /** The release's own checkpoint; a test build may take it to be older than it is. */
  private shipped (): Checkpoint {
    const days = shippedCheckpointAgeDays()
    return days === undefined ? SHIPPED_CHECKPOINT : { root: SHIPPED_CHECKPOINT.root, timestamp: Math.floor(Date.now() / 1000) - Math.round(days * 86_400) }
  }

  /** Chooses afresh from the release's and the stored checkpoint. */
  choose (): CheckpointChoice {
    this.chosen = chooseCheckpoint(this.shipped(), this.deps.store().checkpoint(), Math.floor(Date.now() / 1000), MAX_CHECKPOINT_AGE_SECONDS, this.unserved)
    return this.chosen
  }

  /** The age of the newest checkpoint the light client could start from; undefined while it is off or none can start it. */
  usableAgeSeconds (): number | undefined {
    if (this.deps.switchedOff()) return undefined
    const choice = this.choose()
    return choice.ok ? choice.ageSeconds : undefined
  }

  /** Whether a checkpoint the light client can start from is at hand: the choice already made while it is fresh, then the files again; an aged-out one counts as at hand while it can be renewed. */
  canStart (): boolean {
    if (this.deps.switchedOff()) return false
    const { chosen } = this
    if (chosen?.ok === true && Math.floor(Date.now() / 1000) - chosen.checkpoint.timestamp <= MAX_CHECKPOINT_AGE_SECONDS) return true
    return this.choose().ok || this.mayYet()
  }

  /** Why the last attempt to renew failed, until one succeeds. */
  problem (): FetchProblem | undefined {
    return this.fetcher.lastProblem()
  }

  /** Whether every checkpoint at hand has aged out or is one the beacon server has no bootstrap for: a fresh one is wanted. */
  private aged (): boolean {
    if (this.deps.switchedOff()) return false
    const choice = this.choose()
    return !choice.ok && choice.problem !== 'clock-behind'
  }

  /** Whether a start of the host would renew the checkpoint now: it has aged out, and the servers are not within the wait after a failure. */
  due (): boolean {
    return this.aged() && this.fetcher.mayAttempt()
  }

  /** Whether the host could be started and have a checkpoint: the servers are asked, or are being. */
  mayYet (): boolean {
    return this.aged() && (this.fetcher.mayAttempt() || this.fetcher.busy)
  }

  /**
   * The light client reported that the beacon server has no bootstrap for the checkpoint it started from: that root is not
   * chosen again, a fresh checkpoint is fetched at once (within the wait after a failed attempt, that failure stands), and
   * the host restarts with whichever checkpoint can now start it, an older one still at hand included. Nothing happens
   * when that root was already given up or nothing was started with one. Never rejects.
   */
  recoverUnserved (): void {
    const root = this.startedWith
    if (root === undefined || this.unserved.has(root)) return
    this.unserved.add(root)
    void (this.start() ?? Promise.resolve())
      .then(() => { if (!this.deps.switchedOff() && this.choose().ok) this.deps.restartHost() })
      .catch((error: unknown) => { console.error('[verifier] could not recover from a checkpoint the beacon server will not bootstrap:', error) })
  }

  /**
   * Starts renewing when the release's and the stored checkpoint have both aged past the limit, and returns the attempt;
   * undefined when there is nothing to renew. What is fetched is stored as this install's own, with the servers that agreed
   * on it, so that Settings can say where it came from. Never rejects.
   */
  start (): Promise<void> | undefined {
    if (!this.aged()) return undefined
    return this.fetcher.renew().then((outcome) => {
      if (outcome.ok) {
        try {
          const { root, timestamp, servers } = outcome.checkpoint
          this.deps.store().saveFetchedCheckpoint({ root, timestamp }, servers, Math.floor(Date.now() / 1000))
        } catch (error) {
          console.error('[verifier] could not keep the fetched checkpoint:', error)
        }
      }
      this.deps.changed()
    })
  }
}
