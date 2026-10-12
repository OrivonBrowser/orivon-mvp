// What the shell and the Swarm node's utility process say to each other over
// its parent port. Plain data only: it is structured-cloned.

/** The node counts as ready at this many connected peers. */
export const READY_PEERS = 8

/** A file the build pins: its exact size and sha256, compiled into the app from the manifest. */
export interface PinnedFile {
  readonly name: string
  readonly bytes: number
  readonly sha256: string
}

export interface SwarmNodeConfig {
  /** The loopback port the node's HTTP API listens on. */
  readonly apiPort: number
  /** Where the node keeps its identity and peer snapshot; the only directory the component can reach. */
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

export type ToNode = { readonly type: 'start', readonly config: SwarmNodeConfig }

/** `port`: the API port was taken, so the next start needs another. */
export type FailureStage = 'artifact' | 'compile' | 'start' | 'run' | 'port'

/** The longest `failed.message` main accepts and the node sends. */
export const MAX_FAILURE_MESSAGE = 500

export type FromNode =
  /** The API answers; the node has not found its peers yet. */
  | { readonly type: 'listening' }
  | { readonly type: 'peers', readonly count: number }
  /** Sent once, when the peer count first reaches READY_PEERS. */
  | { readonly type: 'ready', readonly peers: number }
  | { readonly type: 'failed', readonly stage: FailureStage, readonly message: string }

/** What main tells the verifier host about the node (the wiring phase carries it over the host's own port). */
export type SwarmNodeState =
  | { readonly state: 'off', readonly reason?: string }
  | { readonly state: 'starting', readonly peers?: number }
  | { readonly state: 'ready', readonly peers: number }
  | { readonly state: 'failed', readonly reason: string }

export interface SwarmNodeWanted { readonly type: 'swarm-node-wanted' }
export interface SwarmNodeNotice { readonly type: 'swarm-node', readonly state: SwarmNodeState['state'], readonly reason?: string }
