// Which checkpoint the light client starts from, and renewing it at run time when the release's and the stored one have
// both aged out (ADR-0092) or the beacon server has no bootstrap for the one in use (ADR-0098). The choice is the pure rule in checkpoint.ts; the fetch is checkpoint-fetch.ts, one attempt
// at a time with a wait after a failure. No `electron` import: the store, the switch and the notice come in.

import shippedCheckpoint from './mainnet-checkpoint.json'
import { chooseCheckpoint, MAX_CHECKPOINT_AGE_SECONDS, slotTimestamp } from './checkpoint.js'
import type { Checkpoint, CheckpointChoice } from './checkpoint.js'
import { CheckpointFetcher, fetchAgreedCheckpoint } from './checkpoint-fetch.js'
import type { FetchOutcome, FetchProblem } from './checkpoint-fetch.js'
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
  /** Whether the host process is running now, as opposed to asleep: only a running host has a configuration to replace. */
  readonly hostRunning: () => boolean
  /** Puts the host to sleep and starts it again, so that its configuration is built with the checkpoint now chosen. */
  readonly restartHost: () => void
  /** The beacon server the light client bootstraps from, when the person named one (`local`: it is on this computer or a home network, so a request to it must not go through a proxy or a tunnel). Absent: Orivon's. */
  readonly consensus?: () => { readonly url: string, readonly local: boolean }
}

export class CheckpointRenewal {
  private readonly fetcher = new CheckpointFetcher({
    run: async () => await this.attempt(),
    now: () => Date.now()
  })

  /** The last choice made, which a gateway address asks about on every navigation without reading the stored file again. */
  chosen: CheckpointChoice | undefined

  /** The root the running host was given, so that a bootstrap failure is held against the checkpoint that caused it. */
  private startedWith: string | undefined

  /** Roots the beacon server has no bootstrap for: none is chosen again in this run. */
  private readonly unserved = new Set<string>()

  /** The server `unserved` was learned from: another server may serve what this one did not. */
  private bootstrapServer: string | undefined

  constructor (private readonly deps: RenewalDeps) {}

  /** The servers asked; a test build may name its own. */
  servers (): readonly string[] {
    return testBeaconApis() ?? DEFAULT_ENDPOINTS.checkpointBeaconApis
  }

  /** The server the light client bootstraps from, and the one whose bootstrap a renewed checkpoint must have; a test build's first server stands in for it. It is the person's own when they named one. */
  consensusRpc (): string {
    return testBeaconApis()?.[0] ?? this.deps.consensus?.().url ?? DEFAULT_ENDPOINTS.consensusRpc
  }

  /** The release's own checkpoint; a test build may take it to be older than it is. */
  private shipped (): Checkpoint {
    const days = shippedCheckpointAgeDays()
    return days === undefined ? SHIPPED_CHECKPOINT : { root: SHIPPED_CHECKPOINT.root, timestamp: Math.floor(Date.now() / 1000) - Math.round(days * 86_400) }
  }

  /** Chooses afresh from the release's and the stored checkpoint. */
  choose (): CheckpointChoice {
    const server = this.consensusRpc()
    if (this.bootstrapServer !== undefined && this.bootstrapServer !== server) {
      this.unserved.clear()
      this.fetcher.reset()
    }
    this.bootstrapServer = server
    this.chosen = chooseCheckpoint(this.shipped(), this.deps.store().checkpoint(), Math.floor(Date.now() / 1000), MAX_CHECKPOINT_AGE_SECONDS, this.unserved)
    return this.chosen
  }

  /** Chooses the checkpoint the host is started with, and remembers its root. */
  chooseForStart (): CheckpointChoice {
    const choice = this.choose()
    this.startedWith = choice.ok ? choice.checkpoint.root : undefined
    return choice
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
   * One attempt to fetch a checkpoint, stored as this install's own with the servers of Orivon's that agreed on it, so that
   * Settings can say where it came from. It counts as a success only if a checkpoint the light client can start from is then at hand: a
   * server that hands back a root already given up (a backend that disagrees with the one that answered before) is a failed
   * attempt, and waits as one.
   */
  private async attempt (): Promise<FetchOutcome> {
    const consensus = this.consensusRpc()
    // Only the person's own server can be local; a test build's stand-in beacon servers are asked as they always were.
    const local = testBeaconApis() === undefined && this.deps.consensus?.().local === true ? consensus : undefined
    const outcome = await fetchAgreedCheckpoint(async (url) => await beaconJson(url, local), this.servers(), consensus, Math.floor(Date.now() / 1000), { unserved: this.unserved })
    if (!outcome.ok) return outcome
    try {
      const { root, timestamp, servers } = outcome.checkpoint
      // The file is copied into every new profile and private session, so it names Orivon's servers only: the person's own address may hold a key.
      const orivons = this.servers()
      this.deps.store().saveFetchedCheckpoint({ root, timestamp }, servers.filter((server) => orivons.includes(server)), Math.floor(Date.now() / 1000), this.unserved)
    } catch (error) {
      console.error('[verifier] could not keep the fetched checkpoint:', error)
    }
    return this.choose().ok ? outcome : { ok: false, problem: 'no-bootstrap' }
  }

  /**
   * The light client reported that the beacon server has no bootstrap for the checkpoint it started from: that root is not
   * chosen again and a fresh checkpoint is fetched at once (within the wait after a failed attempt, that failure stands).
   * The host restarts with the checkpoint now chosen if it is running and was started with another root. Nothing happens
   * when that root was already given up or nothing was started with one. Never rejects.
   */
  recoverUnserved (): void {
    const root = this.startedWith
    if (root === undefined || this.unserved.has(root)) return
    this.unserved.add(root)
    void (this.start() ?? Promise.resolve())
      .then(() => {
        if (this.deps.switchedOff() || !this.deps.hostRunning()) return
        const choice = this.choose()
        if (choice.ok && choice.checkpoint.root !== this.startedWith) this.deps.restartHost()
      })
      .catch((error: unknown) => { console.error('[verifier] could not recover from a checkpoint the beacon server will not bootstrap:', error) })
  }

  /**
   * Starts renewing when every checkpoint at hand has aged out or is one the beacon server will not bootstrap, and returns
   * the attempt; undefined when there is nothing to renew. Never rejects.
   */
  start (): Promise<void> | undefined {
    if (!this.aged()) return undefined
    return this.fetcher.renew().then(() => { this.deps.changed() })
  }
}
