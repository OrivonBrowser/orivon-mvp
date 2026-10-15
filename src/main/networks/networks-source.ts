// The Available networks popup's one door: gathers what the four nodes say (the verifier host's light client, the IPFS
// node, the Swarm node, the Nym tunnel), builds the view from it, and moves a card's switch by the setting Settings
// uses for the same thing, so the two never disagree. Electron-free: every source comes in.

import type { LocalNodeState } from '../../protocols/local-node/protocol.js'
import type { SettingValue } from '../settings/schema.js'
import type { SetResult } from '../settings/settings-store.js'
import type { NymState } from '../route/nym-status.js'
import type { ProcessInfo } from '../verifier/process-supervisor.js'
import type { LightClientView } from '../verifier/status-view.js'
import { buildNetworksView, dotOf } from './networks-view.js'
import type { Dot, NetworkFacts, NetworkId, NetworksView, NodeFacts, ProcessFacts } from './networks-view.js'

/** One process as `app.getAppMetrics()` reports it. */
export interface ProcessMetric {
  readonly pid: number
  readonly serviceName: string | undefined
  readonly memoryKb: number
  /** Percent of one core since the last reading; undefined when this is a first one. */
  readonly cpuPercent: number | undefined
}

export interface LocalNodeSource {
  readonly state: () => LocalNodeState
  readonly processInfo: () => ProcessInfo | undefined
  readonly onChange: (listener: () => void) => () => void
}

export interface NetworksEnv {
  readonly now?: () => number
  readonly settings: {
    readonly get: (key: NetworkSettingKey) => SettingValue
    readonly set: (key: string, value: unknown) => SetResult
    readonly onChange: (listener: (change: { readonly key: string }) => void) => () => void
  }
  readonly lightClient: {
    readonly view: () => LightClientView
    readonly forcedOff: () => boolean
    readonly process: () => ProcessInfo | undefined
    readonly onChange: (listener: () => void) => () => void
  }
  readonly ipfs: LocalNodeSource
  readonly swarm: LocalNodeSource
  /** What the verifier host has read from a local node, by the node's name. */
  readonly traffic: (node: 'ipfs-node' | 'swarm-node') => { readonly active: number, readonly bytes: number }
  readonly nym: {
    readonly state: () => NymState
    readonly tunnels: () => { readonly connecting: number, readonly ready: number }
    readonly processInfo: () => ProcessInfo | undefined
    readonly onChange: (listener: () => void) => () => void
  }
  /** Reads `app.getAppMetrics()`; asked only when a popup is drawn. */
  readonly metrics: () => readonly ProcessMetric[]
}

export type NetworkSettingKey = 'web3.lightClient' | 'web3.ipfsSource' | 'web3.swarmNode' | 'network.nym.enabled' | 'network.route.kind' | 'network.tunnel.everywhere'

const WATCHED: ReadonlySet<string> = new Set<NetworkSettingKey>(['web3.lightClient', 'web3.ipfsSource', 'web3.swarmNode', 'network.nym.enabled', 'network.route.kind', 'network.tunnel.everywhere'])

/** What each process is called to Electron's metrics, for a process whose pid the supervisor could not give. */
const SERVICE_NAMES: Readonly<Record<'verifier' | 'ipfs' | 'swarm' | 'nym', string>> = {
  verifier: 'Orivon verifier',
  ipfs: 'Orivon IPFS node',
  swarm: 'Orivon Swarm node',
  nym: 'Orivon Nym tunnel'
}

/** The setting a card's switch writes, and the value `on` gives it: the same key Settings uses for the same thing. */
export function switchSetting (id: NetworkId, on: boolean): { readonly key: string, readonly value: boolean | string } {
  switch (id) {
    case 'light-client': return { key: 'web3.lightClient', value: on }
    case 'ipfs': return { key: 'web3.ipfsSource', value: on ? 'node' : 'gateways' }
    case 'swarm': return { key: 'web3.swarmNode', value: on }
    case 'nym': return { key: 'network.nym.enabled', value: on }
  }
}

export function isNetworkId (value: unknown): value is NetworkId {
  return value === 'light-client' || value === 'ipfs' || value === 'swarm' || value === 'nym'
}

export interface NetworksSource {
  /** The popup's view, with each running process's memory and CPU. */
  readonly view: () => NetworksView
  /** Only the toolbar dot: nothing is measured. */
  readonly dot: () => Dot
  /** Moves a card's switch. False when the card cannot be switched now, or the setting refused the value. */
  readonly setSwitch: (id: unknown, on: unknown) => boolean
  /** Called whenever what a card or the dot says may have changed; returns the unsubscribe. */
  readonly onChange: (listener: () => void) => () => void
}

function processFactsOf (info: ProcessInfo | undefined, serviceName: string, metrics: readonly ProcessMetric[]): ProcessFacts | undefined {
  if (info === undefined) return undefined
  const metric = (info.pid === undefined ? undefined : metrics.find((candidate) => candidate.pid === info.pid)) ?? (info.pid === undefined ? metrics.find((candidate) => candidate.serviceName === serviceName) : undefined)
  return {
    startedAt: info.startedAt,
    ...(metric === undefined ? {} : { memoryKb: metric.memoryKb }),
    ...(metric?.cpuPercent === undefined ? {} : { cpuPercent: metric.cpuPercent })
  }
}

export function createNetworksSource (env: NetworksEnv): NetworksSource {
  const now = env.now ?? Date.now

  function facts (metrics: readonly ProcessMetric[]): NetworkFacts {
    // The nodes run through the tunnel while the whole browser is on it (ADR-0086); the card says which.
    const through = env.settings.get('network.tunnel.everywhere') === true ? (env.settings.get('network.route.kind') === 'socks5' ? 'your tunnel' as const : 'Nym' as const) : undefined
    const node = (source: LocalNodeSource, traffic: 'ipfs-node' | 'swarm-node', serviceName: string): NodeFacts => {
      const process = processFactsOf(source.processInfo(), serviceName, metrics)
      return { state: source.state(), traffic: env.traffic(traffic), ...(through === undefined ? {} : { through }), ...(process === undefined ? {} : { process }) }
    }
    const lightProcess = processFactsOf(env.lightClient.process(), SERVICE_NAMES.verifier, metrics)
    const nymProcess = processFactsOf(env.nym.processInfo(), SERVICE_NAMES.nym, metrics)
    return {
      now: now(),
      lightClient: { view: env.lightClient.view(), enabled: env.settings.get('web3.lightClient') === true, forcedOff: env.lightClient.forcedOff(), ...(lightProcess === undefined ? {} : { process: lightProcess }) },
      ipfs: { ...node(env.ipfs, 'ipfs-node', SERVICE_NAMES.ipfs), enabled: env.settings.get('web3.ipfsSource') !== 'gateways' },
      swarm: { ...node(env.swarm, 'swarm-node', SERVICE_NAMES.swarm), enabled: env.settings.get('web3.swarmNode') === true },
      nym: { enabled: env.settings.get('network.nym.enabled') === true, inUse: env.settings.get('network.route.kind') !== 'socks5', state: env.nym.state(), tunnels: env.nym.tunnels(), ...(nymProcess === undefined ? {} : { process: nymProcess }) }
    }
  }

  /** What the last change left: the dot, until a node or a switch changes. A push of every window reads it, so it is never built from the nodes again meanwhile (the light client's view can read a file). */
  let dot: Dot | undefined
  let watching = false
  const subscribe = (listener: () => void): (() => void) => {
    const stops = [
      env.lightClient.onChange(listener),
      env.ipfs.onChange(listener),
      env.swarm.onChange(listener),
      env.nym.onChange(listener),
      env.settings.onChange(({ key }) => { if (WATCHED.has(key)) listener() })
    ]
    return () => { for (const stop of stops) stop() }
  }

  return {
    view: () => buildNetworksView(facts(env.metrics())),
    dot: () => {
      // Watching starts with the first read, once Nym and the rest are there to be watched, and then lasts.
      if (!watching) { watching = true; subscribe(() => { dot = undefined }) }
      dot ??= dotOf(buildNetworksView(facts([])).cards)
      return dot
    },
    setSwitch: (id, on) => {
      if (!isNetworkId(id) || typeof on !== 'boolean') return false
      const card = buildNetworksView(facts([])).cards.find((candidate) => candidate.id === id)
      if (card === undefined || card.disabled) return false
      const change = switchSetting(id, on)
      return env.settings.set(change.key, change.value).ok
    },
    // The cached dot goes first, so a listener that reads it on this very change reads the new one.
    onChange: (listener) => subscribe(() => { dot = undefined; listener() })
  }
}
