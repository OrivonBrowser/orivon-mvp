// Wires the Available networks source to the live nodes: the verifier host's light client, the IPFS and Swarm nodes,
// the Nym tunnel and Electron's process metrics. The decisions are networks-source.ts's and networks-view.ts's.

import { app } from 'electron'
import { ipfsNode } from '../verifier/ipfs-node-subsystem.js'
import { swarmNode } from '../verifier/swarm-node-subsystem.js'
import { lightClientForcedOff, nodeTraffic, onVerifierChange, verifierProcessInfo, verifierView } from '../verifier/verifier-subsystem.js'
import type { SettingsStore } from '../settings/settings-store.js'
import type { SubsystemContext } from '../registry.js'
import { nymSourceFor } from './nym-watch.js'
import { createNetworksSource } from './networks-source.js'
import type { NetworksSource, ProcessMetric } from './networks-source.js'

/** Electron reports 0 CPU for a process until a second reading; a gap this long means the next one is a first. */
const CPU_WARM_MS = 10_000
let lastSample = 0

function readMetrics (): readonly ProcessMetric[] {
  const warm = Date.now() - lastSample < CPU_WARM_MS
  lastSample = Date.now()
  return app.getAppMetrics().map((metric) => ({
    pid: metric.pid,
    serviceName: metric.serviceName,
    memoryKb: metric.memory.workingSetSize,
    cpuPercent: warm ? metric.cpu.percentCPUUsage : undefined
  }))
}

export function createNetworks (settings: SettingsStore, ctx: SubsystemContext): NetworksSource {
  return createNetworksSource({
    settings: { get: (key) => settings.get(key), set: (key, value) => settings.set(key, value), onChange: (listener) => settings.onChange(listener) },
    lightClient: { view: verifierView, forcedOff: lightClientForcedOff, process: verifierProcessInfo, onChange: onVerifierChange },
    ipfs: ipfsNode,
    swarm: swarmNode,
    traffic: nodeTraffic,
    nym: nymSourceFor(ctx),
    metrics: readMetrics
  })
}
