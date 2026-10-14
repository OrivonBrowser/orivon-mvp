// A local node on this computer, as the rest of the shell reaches it: ask for
// it (`ensure`), read what it is doing, and tell it the verifier host went to
// sleep. The process is created the first time something asks, so a run that
// never needs a kind of node never forks it. Not critical: without a node,
// what reads from it says so and nothing else changes. A kind's own file
// (swarm-node-subsystem.ts, ipfs-node-subsystem.ts) says which kind it is and
// when a test build serves its content otherwise.

import type { NodeIdentity } from '../../protocols/local-node/kind.js'
import type { LocalNodeState } from '../../protocols/local-node/protocol.js'
import { nodePort, renewNodePort } from './loopback-port.js'
import type { LocalNodeController } from './local-node-controller.js'
import { createLocalNodeController } from './local-node-launch.js'
import type { LocalNodeManifest } from './local-node-artifact.js'
import type { ProcessInfo } from './process-supervisor.js'

export interface LocalNodeSubsystemSpec {
  readonly kind: NodeIdentity
  readonly manifest: LocalNodeManifest
  /** Why the node must not start in this build, in words, or undefined. */
  readonly disabled?: () => string | undefined
  /** What the person chose that the node's arguments follow, read at each start. */
  readonly options?: () => Readonly<Record<string, string>>
  /** A test build's stand-in for the node: ready at this endpoint, with nothing started. */
  readonly standIn?: () => { readonly endpoint: string } | undefined
  /** The files in its data directory that hold what it kept about the sites it served, removed by `forget`. */
  readonly kept?: readonly string[]
}

export interface LocalNodeSubsystem {
  /** A mount needs the node: starts it if need be, and answers once it is ready, has failed, is off, or has been given the time a mount can spare. */
  ensure: () => Promise<LocalNodeState>
  /** What the node is doing; off while nothing has asked for it. */
  state: () => LocalNodeState
  /** The node's process while it runs. */
  processInfo: () => ProcessInfo | undefined
  /** The node's API origin, `http://127.0.0.1:<port>`. */
  endpoint: () => string
  /** Stops the node and deletes what it kept (`kept`), once its process has exited. A node that never ran has nothing running to stop. */
  forget: () => Promise<void>
  /** The person's switch for the node changed: a node that must not run is stopped, and one that may is asked for as usual. */
  reconsider: () => void
  /** The verifier host went to sleep: nothing reads from the node, so it sleeps too. */
  verifierIdle: () => void
  /** Called whenever what `state` says may have changed; returns the unsubscribe. */
  onChange: (listener: () => void) => () => void
  /**
   * Called when the node's endpoint changed, because its port was taken: whoever fixed the old one in place (the
   * verifier host holds it for as long as it runs) starts afresh. Returns the unsubscribe.
   */
  onEndpointChange: (listener: () => void) => () => void
}

export function createLocalNodeSubsystem (spec: LocalNodeSubsystemSpec): LocalNodeSubsystem {
  let controller: LocalNodeController | undefined
  const endpointListeners = new Set<() => void>()
  const created = (): LocalNodeController => {
    controller ??= createLocalNodeController({
      kind: spec.kind,
      manifest: spec.manifest,
      apiPort: () => nodePort(spec.kind.name),
      apiPortTaken: () => {
        renewNodePort(spec.kind.name)
        for (const listener of [...endpointListeners]) listener()
      },
      ...(spec.disabled === undefined ? {} : { disabled: spec.disabled }),
      ...(spec.options === undefined ? {} : { options: spec.options })
    })
    return controller
  }
  const READY: LocalNodeState = { state: 'ready', peers: 0 }
  return {
    ensure: async () => spec.standIn?.() !== undefined ? READY : await created().ensure(),
    state: () => spec.standIn?.() !== undefined ? READY : controller?.state() ?? { state: 'off' },
    processInfo: () => controller?.processInfo(),
    endpoint: () => spec.standIn?.()?.endpoint ?? `http://127.0.0.1:${String(nodePort(spec.kind.name))}`,
    reconsider: () => { controller?.reconsider() },
    verifierIdle: () => { controller?.verifierIdle() },
    forget: async () => { await created().forget(spec.kept ?? []) },
    onChange: (listener) => created().onChange(listener),
    onEndpointChange: (listener) => {
      endpointListeners.add(listener)
      return () => { endpointListeners.delete(listener) }
    }
  }
}
