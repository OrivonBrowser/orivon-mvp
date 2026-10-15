// What the Available networks popup shows: one card per node Orivon runs on this computer, in words. Pure: the
// facts come in (networks-source.ts gathers them), nothing here reads a process, a setting or a clock.

import type { LocalNodeState } from '../../protocols/local-node/protocol.js'
import type { NymState } from '../route/nym-status.js'
import type { LightClientView } from '../verifier/status-view.js'
import { ago } from '../verifier/status-view.js'

export type NetworkId = 'light-client' | 'ipfs' | 'swarm' | 'nym'
export type StatusWord = 'Running' | 'Starting' | 'Syncing' | 'Asleep' | 'Off' | 'Not running'
/** How a card counts toward the toolbar dot, and how its status is coloured: `ok` runs, `busy` starts or syncs, `bad` failed while switched on, `idle` is none of those. */
export type Tone = 'ok' | 'busy' | 'bad' | 'idle'
export type Dot = 'green' | 'amber' | 'red' | 'none'

export interface Metric {
  readonly label: string
  readonly value: string
}

export interface NetworkCard {
  readonly id: NetworkId
  readonly name: string
  readonly status: StatusWord
  readonly tone: Tone
  /** The switch: where it stands, and whether it can be moved. */
  readonly on: boolean
  readonly disabled: boolean
  /** Under the status: why the node is off, or that it sleeps until a page needs it. */
  readonly note?: string
  /** What the node does for the person, in one sentence. */
  readonly does: string
  /** Only the rows known: a node that does not run has no memory to show. */
  readonly metrics: readonly Metric[]
}

export interface NetworksView {
  readonly cards: readonly NetworkCard[]
  readonly dot: Dot
}

/** What `app.getAppMetrics()` and the supervisor say of one process; a field not known is absent. */
export interface ProcessFacts {
  readonly memoryKb?: number
  /** Percent of one core, absent until a second reading. */
  readonly cpuPercent?: number
  readonly startedAt?: number
}

export interface NodeFacts {
  /** Set while the whole browser is on a tunnel, which then carries the node: the tunnel as the person knows it. Absent: the node connects directly. */
  readonly through?: 'Nym' | 'your tunnel'
  readonly state: LocalNodeState
  readonly process?: ProcessFacts
  /** Reads in flight and bytes read this session, as the verifier host counted them. */
  readonly traffic: { readonly active: number, readonly bytes: number }
}

export interface NetworkFacts {
  readonly now: number
  readonly lightClient: {
    readonly view: LightClientView
    /** The person's switch (`web3.lightClient`). */
    readonly enabled: boolean
    /** The run was started with the light client forced off from outside: the switch cannot change it. */
    readonly forcedOff: boolean
    readonly process?: ProcessFacts
  }
  readonly ipfs: NodeFacts & { readonly enabled: boolean }
  readonly swarm: NodeFacts & { readonly enabled: boolean }
  readonly nym: {
    /** The person's switch (`network.nym.enabled`). */
    readonly enabled: boolean
    /** Whether the tunnel the person chose is Nym, and not their own SOCKS5 address. */
    readonly inUse: boolean
    readonly state: NymState
    readonly tunnels: { readonly connecting: number, readonly ready: number }
    readonly process?: ProcessFacts
  }
}

const ASLEEP = 'Asleep: it starts when a page needs it.'

const KB = 1024

/** A size a person reads: bytes up to a kilobyte, then one decimal below ten and none above. */
export function bytesWords (bytes: number): string {
  if (bytes < KB) return `${String(bytes)} bytes`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / KB
  let unit = 0
  while (unit < units.length - 1 && Number(value.toFixed(value < 10 ? 1 : 0)) >= KB) {
    value /= KB
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? 'GB'}`
}

function durationWords (ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${String(seconds)} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)} min`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${String(hours)} h ${String(minutes % 60)} min` : `${String(Math.floor(hours / 24))} days`
}

function checkpointAge (seconds: number): string {
  const hours = seconds / 3600
  if (hours < 1) return 'under an hour'
  return hours < 48 ? `${String(Math.round(hours))} hours` : `${String(Math.round(hours / 24))} days`
}

/** Memory, CPU and how long it has run: only for a process that runs, and only the figures known. */
export function processMetrics (process: ProcessFacts | undefined, now: number): Metric[] {
  if (process === undefined) return []
  return [
    ...(process.memoryKb === undefined ? [] : [{ label: 'Memory', value: bytesWords(process.memoryKb * KB) }]),
    ...(process.cpuPercent === undefined ? [] : [{ label: 'CPU', value: `${String(Math.round(process.cpuPercent))}%` }]),
    ...(process.startedAt === undefined ? [] : [{ label: 'Running for', value: durationWords(Math.max(0, now - process.startedAt)) }])
  ]
}

function lightClientCard (facts: NetworkFacts['lightClient'], now: number): NetworkCard {
  const { view } = facts
  const on = facts.enabled && !facts.forcedOff
  const base = { id: 'light-client', name: 'Ethereum light client', on, disabled: facts.forcedOff, does: 'Proves what a .eth name points to on this computer before its page loads, so nobody has to be trusted to say.' } as const
  if (!on) {
    return { ...base, status: 'Off', tone: 'idle', note: facts.forcedOff ? 'This run was started with the light client switched off, so the switch cannot change it.' : 'Switched off: no .eth name loads.', metrics: [] }
  }
  const metrics = (running: boolean): Metric[] => [
    ...(view.block === undefined ? [] : [{ label: 'Latest verified block', value: view.block.toLocaleString('en-US') }]),
    ...(view.headAt === undefined ? [] : [{ label: 'Block produced', value: ago(now - view.headAt) }]),
    ...(view.checkpointAgeSeconds === undefined ? [] : [{ label: 'Checkpoint', value: `${checkpointAge(view.checkpointAgeSeconds)} old` }]),
    ...(running ? processMetrics(facts.process, now) : [])
  ]
  switch (view.state) {
    case 'waiting': return { ...base, status: 'Asleep', tone: 'idle', note: ASLEEP, metrics: metrics(false) }
    case 'starting': return { ...base, status: 'Starting', tone: 'busy', metrics: metrics(true) }
    case 'syncing': return { ...base, status: 'Syncing', tone: 'busy', note: view.summary, metrics: metrics(true) }
    case 'synced': return { ...base, status: 'Running', tone: 'ok', metrics: metrics(true) }
    case 'failed':
    case 'down': return { ...base, status: 'Not running', tone: 'bad', note: view.summary, metrics: metrics(false) }
    case 'off': return { ...base, status: 'Off', tone: 'idle', note: view.summary, metrics: metrics(false) }
  }
}

/** The card of an IPFS or Swarm node: the two differ in their words, their switch and whether they count peers. */
function nodeCard (kind: 'ipfs' | 'swarm', facts: NodeFacts & { readonly enabled: boolean }, now: number): NetworkCard {
  const ipfs = kind === 'ipfs'
  const base = {
    id: kind,
    name: ipfs ? 'IPFS node' : 'Swarm node',
    on: facts.enabled,
    disabled: false,
    does: ipfs
      ? 'Fetches ipfs:// and ipns:// pages from the IPFS network and checks every block before it is shown.'
      : 'Fetches bzz:// pages from the Swarm network and checks every chunk before it is shown.'
  } as const
  if (!facts.enabled) {
    return { ...base, status: 'Off', tone: 'idle', note: ipfs ? 'Switched off: ipfs:// pages load through public gateways, which learn which sites you open.' : 'Switched off: a bzz:// address says Swarm is off.', metrics: [] }
  }
  const { state, through } = facts
  const slower = through === undefined ? undefined : `Connected through ${through}: its peers see ${through === 'Nym' ? "Nym's exit" : 'your tunnel'}, not your address. This is slower than a direct connection.`
  const peers = state.state === 'ready' || state.state === 'starting' ? state.peers : undefined
  const metrics = (): Metric[] => [
    ...(!ipfs && peers !== undefined ? [{ label: 'Peers', value: String(peers) }] : []),
    { label: 'Requests now', value: String(facts.traffic.active) },
    { label: 'Data read this session', value: bytesWords(facts.traffic.bytes) },
    ...processMetrics(facts.process, now)
  ]
  switch (state.state) {
    case 'ready': return { ...base, status: 'Running', tone: 'ok', ...(slower === undefined ? {} : { note: slower }), metrics: metrics() }
    case 'starting': return { ...base, status: 'Starting', tone: 'busy', ...(through === undefined ? {} : { note: `Starting through ${through}: the first connection takes a little while.` }), metrics: metrics() }
    case 'failed': return { ...base, status: 'Not running', tone: 'bad', note: `${state.reason}.`, metrics: [] }
    case 'off': return state.reason === undefined
      ? { ...base, status: 'Asleep', tone: 'idle', note: through === undefined ? ASLEEP : `${ASLEEP} It then connects through ${through}.`, metrics: [] }
      : { ...base, status: 'Off', tone: 'idle', note: `${state.reason}.`, metrics: [] }
  }
}

function nymCard (facts: NetworkFacts['nym'], now: number): NetworkCard {
  const base = { id: 'nym', name: 'Nym tunnel', on: facts.enabled, does: 'Carries the traffic of every app and website you set to use the tunnel through the Nym mixnet.' } as const
  if (!facts.inUse) {
    return { ...base, disabled: true, status: 'Off', tone: 'idle', note: 'Nym is not in use: your tunnel is your own SOCKS5 address. Choose Nym under Tunnels in Settings to use it.', metrics: [] }
  }
  const movable = { ...base, disabled: false } as const
  if (!facts.enabled) {
    return { ...movable, status: 'Off', tone: 'idle', note: 'Switched off: every app and website set to use the tunnel is stopped, not sent directly.', metrics: [] }
  }
  const { state, tunnels } = facts
  const metrics = (): Metric[] => [
    { label: 'Tunnels open', value: String(tunnels.ready) },
    ...(tunnels.connecting > 0 ? [{ label: 'Tunnels connecting', value: String(tunnels.connecting) }] : []),
    ...processMetrics(facts.process, now)
  ]
  switch (state.state) {
    case 'off': return { ...movable, status: 'Asleep', tone: 'idle', note: 'Asleep: it starts when an app or website set to use the tunnel connects.', metrics: [] }
    case 'idle': return { ...movable, status: 'Running', tone: 'ok', note: 'No tunnel is open now.', metrics: metrics() }
    case 'connecting': return { ...movable, status: 'Starting', tone: 'busy', metrics: metrics() }
    case 'ready': return { ...movable, status: 'Running', tone: 'ok', ...(state.reason === undefined ? {} : { note: state.reason }), metrics: metrics() }
    case 'failed': return { ...movable, status: 'Not running', tone: 'bad', note: `${state.reason}.`, metrics: [] }
    case 'unavailable': return { ...movable, status: 'Off', tone: 'idle', note: `${state.reason}.`, metrics: [] }
  }
}

/**
 * The toolbar button's dot, from the cards a person has switched on: red when one of them failed, amber while one starts
 * or syncs, green when one runs, none when nothing does (a node that sleeps or is off shows nothing).
 */
export function dotOf (cards: ReadonlyArray<Pick<NetworkCard, 'on' | 'tone'>>): Dot {
  const live = cards.filter((card) => card.on)
  if (live.some((card) => card.tone === 'bad')) return 'red'
  if (live.some((card) => card.tone === 'busy')) return 'amber'
  if (live.some((card) => card.tone === 'ok')) return 'green'
  return 'none'
}

export function buildNetworksView (facts: NetworkFacts): NetworksView {
  const cards = [
    lightClientCard(facts.lightClient, facts.now),
    nodeCard('ipfs', facts.ipfs, facts.now),
    nodeCard('swarm', facts.swarm, facts.now),
    nymCard(facts.nym, facts.now)
  ]
  return { cards, dot: dotOf(cards) }
}
