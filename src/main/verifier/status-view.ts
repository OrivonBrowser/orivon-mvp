// What the Settings section and the site-info popover say about the light
// client, in words. Read-only: nothing here changes an endpoint or a
// checkpoint.

import type { CheckpointChoice } from './checkpoint.js'
import type { LightClientState } from '../../verifier-host/protocol.js'

export interface LightClientView {
  /** One word for the badge: off, starting, syncing, synced, failed. */
  readonly state: LightClientState['state'] | 'down'
  /** The sentence under it. */
  readonly summary: string
  readonly checkpoint: string
  readonly endpoints: ReadonlyArray<{ readonly label: string, readonly urls: readonly string[] }>
}

export interface VerifierFacts {
  readonly lightClient: LightClientState
  readonly checkpoint: CheckpointChoice | undefined
  readonly hostDown: string | undefined
  readonly switchedOff: boolean
  readonly endpoints: { readonly executionRpcs: readonly string[], readonly consensusRpc: string, readonly gateways: readonly string[] }
}

function ago (ms: number): string {
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

function checkpointLine (choice: CheckpointChoice | undefined): string {
  if (choice === undefined) return 'No checkpoint chosen.'
  if (!choice.ok) return `No usable checkpoint: ${choice.reason}.`
  const source = choice.source === 'release' ? 'shipped with this release' : 'last verified on this computer'
  return `Checkpoint ${age(choice.ageSeconds)} old, ${source}.`
}

function summaryOf (facts: VerifierFacts, now: number): { state: LightClientView['state'], summary: string } {
  // A dead verifier outranks everything: with it down, no .eth page loads at all.
  if (facts.hostDown !== undefined) return { state: 'down', summary: `The verifier is not running: ${facts.hostDown}.` }
  if (facts.switchedOff) return { state: 'off', summary: 'Switched off for this run. No .eth name can be verified, so none loads.' }
  if (facts.checkpoint !== undefined && !facts.checkpoint.ok) return { state: 'failed', summary: 'Not started: the light client needs a recent checkpoint. Installing a newer release brings one.' }
  const s = facts.lightClient
  switch (s.state) {
    case 'off': return { state: 'off', summary: 'Not running.' }
    case 'starting': return { state: 'starting', summary: 'Starting.' }
    case 'syncing': return { state: 'syncing', summary: `Catching up with the chain, since ${ago(now - s.since)}.` }
    case 'synced': return { state: 'synced', summary: `Following the chain: block ${s.block.toLocaleString('en-US')}, checked ${ago(now - s.at)}.` }
    case 'failed': return { state: 'failed', summary: `Failed: ${s.reason}.${s.retryAt === undefined ? '' : ` Trying again ${s.retryAt <= now ? 'now' : `in ${String(Math.ceil((s.retryAt - now) / 1000))} s`}.`}` }
  }
}

export function lightClientView (facts: VerifierFacts, now: number): LightClientView {
  return {
    ...summaryOf(facts, now),
    checkpoint: checkpointLine(facts.checkpoint),
    endpoints: [
      { label: 'Ethereum RPCs', urls: facts.endpoints.executionRpcs },
      { label: 'Beacon API', urls: [facts.endpoints.consensusRpc] },
      { label: 'IPFS gateways', urls: facts.endpoints.gateways }
    ]
  }
}
