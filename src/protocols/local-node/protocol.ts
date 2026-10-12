// What the shell and a local node's utility process say to each other over
// its parent port. Plain data only: it is structured-cloned.

/** A file the build pins: its exact size and sha256, compiled into the app from the manifest. */
export interface PinnedFile {
  readonly name: string
  readonly bytes: number
  readonly sha256: string
}

export interface LocalNodeConfig {
  /** Which kind of node to run: the kind's `name`, which is also its resources folder (`swarm-node`). */
  readonly kind: string
  /** The loopback port the node's HTTP API listens on. */
  readonly apiPort: number
  /** Where the node keeps its identity and state; the only directory the component can reach. */
  readonly dataDir: string
  /** The directory holding the transpiled component. */
  readonly componentDir: string
  /** The component's name: its glue is `<name>.js`. */
  readonly componentName: string
  /** The files the component is made of, as pinned. The process reads each once and runs only bytes that match. */
  readonly files: readonly PinnedFile[]
}

/** A `failed` message whose text is cut to what main accepts. */
export function failure (stage: FailureStage, message: string): FromNode {
  return { type: 'failed', stage, message: message.length > MAX_FAILURE_MESSAGE ? `${message.slice(0, MAX_FAILURE_MESSAGE - 1)}…` : message }
}

export type ToNode = { readonly type: 'start', readonly config: LocalNodeConfig }

/** `port`: the API port was taken, so the next start needs another. */
export type FailureStage = 'artifact' | 'compile' | 'start' | 'run' | 'port'

/** The longest `failed.message` main accepts and the node sends. */
export const MAX_FAILURE_MESSAGE = 500

export type FromNode =
  /** The API answers; the node is not ready yet. */
  | { readonly type: 'listening' }
  /** A node that counts peers reports them as the count changes. */
  | { readonly type: 'peers', readonly count: number }
  /** Sent once, when the node's own readiness rule is met; `peers` is 0 for a node that does not count them. */
  | { readonly type: 'ready', readonly peers: number }
  | { readonly type: 'failed', readonly stage: FailureStage, readonly message: string }

/** What main knows about a node. */
export type LocalNodeState =
  | { readonly state: 'off', readonly reason?: string }
  | { readonly state: 'starting', readonly peers?: number }
  | { readonly state: 'ready', readonly peers: number }
  | { readonly state: 'failed', readonly reason: string }

/** The environment variable a kind's setting is read from: `ORIVON_SWARM_NODE_DIR` for the kind `swarm-node` and the suffix `DIR`. */
export function envName (kind: string, suffix: string): string {
  return `ORIVON_${kind.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${suffix}`
}
