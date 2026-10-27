// What the Settings section, the site-info popover and the main process's log
// say about the light client, in words. Read-only: nothing here changes an
// endpoint or a checkpoint.

import { MAX_CHECKPOINT_AGE_SECONDS } from './checkpoint.js'
import type { CheckpointChoice } from './checkpoint.js'
import type { FetchProblem } from './checkpoint-fetch.js'
import type { LightClientState } from '../../protocols/verifier-host/protocol.js'
import type { SwarmNodeState } from '../../protocols/swarm-node/protocol.js'
import type { IpfsNodeState } from '../../protocols/ipfs-node/protocol.js'

export interface LightClientView {
  /** One word for the badge: off, waiting, starting, syncing, synced, failed, down. `waiting`: on, with no host running until a .eth address needs it. */
  readonly state: LightClientState['state'] | 'down' | 'waiting'
  /** The sentence under it. */
  readonly summary: string
  readonly checkpoint: string
  /** What the servers below learn, and which of their answers are used unchecked. */
  readonly about: string
  readonly endpoints: ReadonlyArray<{ readonly label: string, readonly urls: readonly string[] }>
  /** The newest block the light client has verified, while it follows the chain. */
  readonly block?: number
  /** When that block was produced, in ms since the epoch: the head's age is now minus this. */
  readonly headAt?: number
  /** How old the checkpoint it starts from is, in seconds, when one can be used. */
  readonly checkpointAgeSeconds?: number
  /** Whether that checkpoint was fetched at run time from beacon servers that agreed, rather than shipped or stored by the light client. */
  readonly checkpointFetched?: true
  /** The Swarm node Orivon runs, when this run uses it. */
  readonly swarmNode?: SwarmNodeView
  /** Orivon's IPFS node, when the person reads IPFS from it. */
  readonly ipfsNode?: IpfsNodeView
}

/** A head this old means the light client has stopped following the chain, whatever it last reported. */
export const STALE_HEAD_MS = 5 * 60_000

const ABOUT = 'It proves what a .eth name points to before the page loads. The servers below are asked while it runs, and learn which names and content you look up. Their answers are checked before use, except a DNSLink record, which is used as given and marked unverified. A name\'s own resolver contract may also have a lookup sent to a server it chooses.'

export interface VerifierFacts {
  readonly lightClient: LightClientState
  readonly checkpoint: CheckpointChoice | undefined
  /** Why the last try to fetch a fresh checkpoint failed, until one succeeds. */
  readonly checkpointFetchProblem?: FetchProblem
  readonly hostDown: string | undefined
  /** No host process is running and nothing has failed: it has not been needed yet, or it slept after going unused. */
  readonly hostAsleep: boolean
  readonly switchedOff: boolean
  readonly swarmNode?: SwarmNodeState
  /** Present when the person reads IPFS from the node: what it is doing, and whether it may ask a lookup service. */
  readonly ipfsNode?: { readonly state: IpfsNodeState, readonly lookupService: boolean }
  readonly endpoints: {
    readonly executionRpcs: readonly string[]
    readonly consensusRpc: string
    /** The servers asked together for a fresh checkpoint when the release's and the stored one are both too old. */
    readonly checkpointBeaconApis?: readonly string[]
    readonly gateways: readonly string[]
    readonly swarmEndpoints: readonly string[]
    /** The IPFS node's endpoint, while the person reads IPFS from it. */
    readonly ipfsNodeEndpoints?: readonly string[]
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
  const [count, unit] = hours < 48 ? [Math.round(hours), 'hour'] : [Math.round(hours / 24), 'day']
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`
}

const SOURCE_WORDS = { release: 'shipped with this release', 'this-install': 'last verified on this computer', fetched: 'fetched from beacon servers' } as const

/** Why a try to fetch a fresh checkpoint came to nothing, as the end of a sentence. */
function fetchFailure (problem: FetchProblem): string {
  switch (problem) {
    case 'unreachable': return 'a beacon server did not answer'
    case 'malformed': return 'a beacon server gave an answer that could not be read'
    case 'not-finalized': return 'a beacon server gave a block that is not finalized'
    case 'disagree': return 'the beacon servers did not give the same answer'
    case 'future': return "the checkpoint the beacon servers gave is dated after this computer's clock, which may be set behind"
    case 'too-old': return "the checkpoint the beacon servers gave is older than a checkpoint may be, which suggests this computer's clock is ahead"
    case 'too-few-servers': return 'fewer than two beacon servers are set'
    case 'no-bootstrap': return 'the beacon server would not start the light client from any recent finalized block'
  }
}

function duration (ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 90) return `${String(seconds)} seconds`
  const minutes = Math.round(seconds / 60)
  return minutes < 90 ? `${String(minutes)} minutes` : `${String(Math.round(minutes / 60))} hours`
}

/** How far this computer's clock is from the servers', as the end of a sentence: the lead is positive when it is behind, negative when ahead. */
function clockOff (leadMs: number): string {
  return `${duration(Math.abs(leadMs))} ${leadMs > 0 ? 'behind' : 'ahead of'} the servers'`
}

function hostsOf (urls: readonly string[]): string {
  return urls.map((url) => { try { return new URL(url).hostname } catch { return url } }).join(' and ')
}

function utcMinute (seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** Why no checkpoint can be used, and what fixes it, as one sentence for Settings and the error page. */
export function checkpointProblem (choice: Extract<CheckpointChoice, { ok: false }>, fetchProblem?: FetchProblem): string {
  if (choice.problem === 'clock-behind') return "this computer's clock is behind the checkpoint shipped with this release, so its age cannot be judged. Setting the clock right lets the light client start"
  const tried = fetchProblem === undefined
    ? 'Opening a .eth name asks two beacon servers for a fresh one'
    : `A fresh one could not be fetched from the beacon servers: ${fetchFailure(fetchProblem)}`
  if (choice.problem === 'not-served') return `the beacon server would not start the light client from the newest checkpoint (${SOURCE_WORDS[choice.source]}). ${tried}. Installing a newer release brings one too`
  if (choice.skippedUnserved === true) return `a newer checkpoint has no bootstrap on the beacon server, and the newest one it would start from (${SOURCE_WORDS[choice.source]}) is ${age(choice.ageSeconds)} old, past the ${age(MAX_CHECKPOINT_AGE_SECONDS)} a checkpoint may be. ${tried}. Installing a newer release brings one too`
  return `the newest checkpoint (${SOURCE_WORDS[choice.source]}) is ${age(choice.ageSeconds)} old, past the ${age(MAX_CHECKPOINT_AGE_SECONDS)} a checkpoint may be. ${tried}. Installing a newer release brings one too; if this computer's clock is wrong, setting it right may be enough`
}

function checkpointLine (choice: CheckpointChoice | undefined, fetchProblem: FetchProblem | undefined): string {
  if (choice === undefined) return 'No checkpoint chosen.'
  if (!choice.ok) return `No usable checkpoint: ${checkpointProblem(choice, fetchProblem)}.`
  if (choice.source === 'fetched' && choice.fetchedFrom !== undefined) {
    return `Checkpoint ${age(choice.ageSeconds)} old, dated ${utcMinute(choice.checkpoint.timestamp)}. It was fetched while a .eth name was opened, because none stored here was recent enough; ${hostsOf(choice.fetchedFrom)} gave the same answer.`
  }
  return `Checkpoint ${age(choice.ageSeconds)} old, ${SOURCE_WORDS[choice.source]}.`
}

function summaryOf (facts: VerifierFacts, now: number): { state: LightClientView['state'], summary: string } {
  // A dead verifier outranks everything: with it down, no .eth page loads at all.
  if (facts.hostDown !== undefined) return { state: 'down', summary: `The verifier is not running: ${facts.hostDown}.` }
  if (facts.switchedOff) return { state: 'off', summary: 'Switched off. No .eth name can be verified, so none loads.' }
  if (facts.checkpoint !== undefined && !facts.checkpoint.ok) {
    const note = facts.checkpoint.problem !== 'clock-behind' && facts.checkpointFetchProblem !== undefined ? ` A fresh one could not be fetched: ${fetchFailure(facts.checkpointFetchProblem)}.` : ''
    const refused = facts.checkpoint.problem === 'not-served' || (facts.checkpoint.problem === 'too-old' && facts.checkpoint.skippedUnserved === true)
    return { state: 'failed', summary: refused ? `Not running: the beacon server would not start it from the checkpoint it was given, and no other is at hand.${note}` : `Not started: it needs a recent checkpoint to start from.${note}` }
  }
  if (facts.hostAsleep) return { state: 'waiting', summary: 'On, and waiting. It starts when a .eth address is opened, and stops again after ten minutes without one.' }
  const s = facts.lightClient
  switch (s.state) {
    case 'off': return { state: 'off', summary: 'Not running.' }
    case 'starting': return { state: 'starting', summary: 'Starting.' }
    case 'syncing': return { state: 'syncing', summary: `Catching up with the chain, since ${ago(now - s.since)}.` }
    case 'synced': {
      // The block's time is the chain's; a clock that runs behind or ahead is made up for before they are compared.
      const headAge = now + (s.clockLeadMs ?? 0) - s.at
      return headAge > STALE_HEAD_MS
        ? { state: 'syncing', summary: `Behind the chain: the newest block it has verified, ${s.block.toLocaleString('en-US')}, was produced ${ago(headAge)}.` }
        : { state: 'synced', summary: `Following the chain: block ${s.block.toLocaleString('en-US')}, produced ${ago(headAge)}.${s.clockLeadMs === undefined ? '' : ` This computer's clock is ${clockOff(s.clockLeadMs)}, and the light client allows for it. Setting the clock right, in the system's date and time settings, removes the need.`}` }
    }
    case 'failed': return { state: 'failed', summary: `Failed: ${s.reason}.${s.retryAt === undefined ? '' : ` Trying again ${s.retryAt <= now ? 'now' : `in ${String(Math.ceil((s.retryAt - now) / 1000))} s`}.`}` }
  }
}

export function lightClientView (facts: VerifierFacts, now: number): LightClientView {
  const head = facts.lightClient.state === 'synced' && !facts.switchedOff && facts.hostDown === undefined && !facts.hostAsleep ? facts.lightClient : undefined
  return {
    ...summaryOf(facts, now),
    ...(head !== undefined && { block: head.block, headAt: head.at }),
    ...(facts.checkpoint?.ok === true && { checkpointAgeSeconds: facts.checkpoint.ageSeconds }),
    ...(facts.checkpoint?.ok === true && facts.checkpoint.source === 'fetched' && { checkpointFetched: true as const }),
    checkpoint: checkpointLine(facts.checkpoint, facts.checkpointFetchProblem),
    about: ABOUT,
    ...(facts.swarmNode !== undefined && { swarmNode: swarmNodeView(facts.swarmNode) }),
    ...(facts.ipfsNode !== undefined && { ipfsNode: ipfsNodeView(facts.ipfsNode.state, facts.ipfsNode.lookupService) }),
    endpoints: [
      { label: 'Ethereum RPCs', urls: facts.endpoints.executionRpcs },
      { label: 'Beacon API', urls: [facts.endpoints.consensusRpc] },
      ...(facts.endpoints.checkpointBeaconApis === undefined ? [] : [{ label: 'Beacon servers for a fresh checkpoint, asked only when none is recent enough', urls: facts.endpoints.checkpointBeaconApis }]),
      ...(facts.ipfsNode === undefined
        ? [{ label: 'IPFS gateways', urls: facts.endpoints.gateways }]
        : [{ label: 'IPFS node, on this computer', urls: facts.endpoints.ipfsNodeEndpoints ?? [] }, { label: 'IPFS gateways, only for a site you load through them', urls: facts.endpoints.gateways }]),
      { label: 'Swarm node, on this computer', urls: facts.endpoints.swarmEndpoints },
      { label: 'IPNS name services', urls: facts.endpoints.ipnsNameServices },
      { label: 'DNS-over-HTTPS, for DNSLink', urls: facts.endpoints.dnsOverHttps }
    ]
  }
}

export interface SwarmNodeView {
  /** One word for the badge. */
  readonly state: SwarmNodeState['state']
  /** The sentence under it. */
  readonly summary: string
}

/** What Settings says about the Swarm node Orivon runs on this computer. */
export function swarmNodeView (node: SwarmNodeState): SwarmNodeView {
  switch (node.state) {
    case 'off': return {
      state: 'off',
      summary: node.reason === undefined
        ? 'Off. It starts when a Swarm address is opened, and stops again after ten minutes without one.'
        : `Off: ${node.reason}.`
    }
    case 'starting': return {
      state: 'starting',
      summary: node.peers === undefined || node.peers === 0 ? 'Starting, and finding peers.' : `Starting: ${String(node.peers)} peer${node.peers === 1 ? '' : 's'} found so far.`
    }
    case 'ready': return { state: 'ready', summary: `Running, with ${String(node.peers)} peer${node.peers === 1 ? '' : 's'}.` }
    case 'failed': return { state: 'failed', summary: `Not running: ${node.reason}. It tries again shortly.` }
  }
}

export interface IpfsNodeView {
  /** One word for the badge. */
  readonly state: IpfsNodeState['state']
  /** The sentence under it. */
  readonly summary: string
}

const NO_GATEWAYS = 'IPFS pages do not load meanwhile, unless you press "Load through public gateways" on a page\'s error or choose gateways under "Load IPFS sites from"'

/** What Settings says about the IPFS node Orivon runs on this computer, while the person reads IPFS from it. */
export function ipfsNodeView (node: IpfsNodeState, lookupService: boolean): IpfsNodeView {
  switch (node.state) {
    case 'off': return {
      state: 'off',
      summary: node.reason === undefined
        ? 'Off. It starts when an IPFS address is opened, and stops again after ten minutes without one.'
        : `Not in use: ${node.reason}. ${NO_GATEWAYS}.`
    }
    case 'starting': return { state: 'starting', summary: 'Starting.' }
    case 'ready': return { state: 'ready', summary: `Running, and IPFS content loads from it. It asks ${lookupService ? 'its lookup services and the IPFS network' : 'the IPFS network only'}.` }
    case 'failed': return { state: 'failed', summary: `Not running: ${node.reason}. ${NO_GATEWAYS}. The node tries again shortly.` }
  }
}

export interface LightClientLogLine {
  readonly level: 'log' | 'error'
  readonly text: string
}

/**
 * The main process's log lines for the light client's status, the only place a bug report finds them: the
 * verifier host's own output never reaches that log. A failure is logged once until its reason changes or a
 * sync succeeds, and a sync once until the next failure, so retries and refreshes add nothing.
 */
export function lightClientLog (): (status: LightClientState) => LightClientLogLine | undefined {
  let failure: string | undefined
  let syncLogged = false
  return (status) => {
    if (status.state === 'failed') {
      syncLogged = false
      if (status.reason === failure) return undefined
      failure = status.reason
      return { level: 'error', text: `light client failed: ${status.reason}` }
    }
    if (status.state !== 'synced' || syncLogged) return undefined
    syncLogged = true
    failure = undefined
    return { level: 'log', text: `light client synced at block ${String(status.block)}` }
  }
}
