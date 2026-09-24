// What the Settings section and the site-info popover say about the light
// client, in words. Read-only: nothing here changes an endpoint or a
// checkpoint.

import { MAX_CHECKPOINT_AGE_SECONDS } from './checkpoint.js'
import type { CheckpointChoice } from './checkpoint.js'
import type { LightClientState } from '../../verifier-host/protocol.js'

export interface LightClientView {
  /** One word for the badge: off, starting, syncing, synced, failed. */
  readonly state: LightClientState['state'] | 'down'
  /** The sentence under it. */
  readonly summary: string
  readonly checkpoint: string
  /** What the servers below learn, and which of their answers are used unchecked. */
  readonly about: string
  readonly endpoints: ReadonlyArray<{ readonly label: string, readonly urls: readonly string[] }>
}

/** A head this old means the light client has stopped following the chain, whatever it last reported. */
export const STALE_HEAD_MS = 5 * 60_000

const ABOUT = 'It proves what a .eth name points to before the page loads. The servers below are asked while it runs, and learn which names and content you look up. Their answers are checked before use, except a DNSLink record, which is used as given and marked unverified. A name\'s own resolver contract may also have a lookup sent to a server it chooses.'

export interface VerifierFacts {
  readonly lightClient: LightClientState
  readonly checkpoint: CheckpointChoice | undefined
  readonly hostDown: string | undefined
  readonly switchedOff: boolean
  readonly endpoints: {
    readonly executionRpcs: readonly string[]
    readonly consensusRpc: string
    readonly gateways: readonly string[]
    readonly ipnsNameServices: readonly string[]
    readonly dnsOverHttps: readonly string[]
  }
}

export function ago (ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 90) return `${String(minutes)} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${String(hours)} hours ago` : `${String(Math.round(hours / 24))} days ago`
}

function age (seconds: number): string {
  const hours = seconds / 3600
  if (hours < 1) return 'under an hour'
  return hours < 48 ? `${String(Math.round(hours))} hours` : `${String(Math.round(hours / 24))} days`
}

/** Why no checkpoint can be used, and what fixes it, as one sentence for Settings and the error page. */
export function checkpointProblem (choice: Extract<CheckpointChoice, { ok: false }>): string {
  if (choice.problem === 'clock-behind') return "this computer's clock is behind the checkpoint shipped with this release, so its age cannot be judged. Setting the clock right lets the light client start"
  const source = choice.source === 'release' ? 'shipped with this release' : 'last verified on this computer'
  return `the newest checkpoint (${source}) is ${age(choice.ageSeconds)} old, past the ${age(MAX_CHECKPOINT_AGE_SECONDS)} a checkpoint may be. Installing a newer release brings a fresh one; if this computer's clock is wrong, setting it right may be enough`
}

function checkpointLine (choice: CheckpointChoice | undefined): string {
  if (choice === undefined) return 'No checkpoint chosen.'
  if (!choice.ok) return `No usable checkpoint: ${checkpointProblem(choice)}.`
  const source = choice.source === 'release' ? 'shipped with this release' : 'last verified on this computer'
  return `Checkpoint ${age(choice.ageSeconds)} old, ${source}.`
}

function summaryOf (facts: VerifierFacts, now: number): { state: LightClientView['state'], summary: string } {
  // A dead verifier outranks everything: with it down, no .eth page loads at all.
  if (facts.hostDown !== undefined) return { state: 'down', summary: `The verifier is not running: ${facts.hostDown}.` }
  if (facts.switchedOff) return { state: 'off', summary: 'Switched off for this run. No .eth name can be verified, so none loads.' }
  if (facts.checkpoint !== undefined && !facts.checkpoint.ok) return { state: 'failed', summary: 'Not started: it needs a recent checkpoint to start from.' }
  const s = facts.lightClient
  switch (s.state) {
    case 'off': return { state: 'off', summary: 'Not running.' }
    case 'starting': return { state: 'starting', summary: 'Starting.' }
    case 'syncing': return { state: 'syncing', summary: `Catching up with the chain, since ${ago(now - s.since)}.` }
    case 'synced': return now - s.at > STALE_HEAD_MS
      ? { state: 'syncing', summary: `Behind the chain: the newest block it has verified, ${s.block.toLocaleString('en-US')}, was produced ${ago(now - s.at)}.` }
      : { state: 'synced', summary: `Following the chain: block ${s.block.toLocaleString('en-US')}, produced ${ago(now - s.at)}.` }
    case 'failed': return { state: 'failed', summary: `Failed: ${s.reason}.${s.retryAt === undefined ? '' : ` Trying again ${s.retryAt <= now ? 'now' : `in ${String(Math.ceil((s.retryAt - now) / 1000))} s`}.`}` }
  }
}

export function lightClientView (facts: VerifierFacts, now: number): LightClientView {
  return {
    ...summaryOf(facts, now),
    checkpoint: checkpointLine(facts.checkpoint),
    about: ABOUT,
    endpoints: [
      { label: 'Ethereum RPCs', urls: facts.endpoints.executionRpcs },
      { label: 'Beacon API', urls: [facts.endpoints.consensusRpc] },
      { label: 'IPFS gateways', urls: facts.endpoints.gateways },
      { label: 'IPNS name services', urls: facts.endpoints.ipnsNameServices },
      { label: 'DNS-over-HTTPS, for DNSLink', urls: facts.endpoints.dnsOverHttps }
    ]
  }
}
