// What the shell and the Swarm node's utility process say to each other over
// its parent port. Plain data only: it is structured-cloned.

/** The node counts as ready at this many connected peers. */
export const READY_PEERS = 8

export interface SwarmNodeConfig {
  /** The loopback port the node's HTTP API listens on. */
  readonly apiPort: number
  /** Where the node keeps its identity and peer snapshot; the only directory the component can reach. */
  readonly dataDir: string
  /** The directory holding the transpiled component. */
  readonly componentDir: string
  /** The component's name: its glue is `<name>.js`. */
  readonly componentName: string
}

export type ToNode = { readonly type: 'start', readonly config: SwarmNodeConfig }

export type FailureStage = 'artifact' | 'compile' | 'start' | 'run'

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
