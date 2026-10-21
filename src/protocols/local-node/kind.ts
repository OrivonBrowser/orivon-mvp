// What a kind of local node supplies to the shared host: its name, its
// arguments and config files, and how it tells that it is ready. Everything
// else (the pinned-file check, the confined network and files, the data
// directory, the port, the reports to main) is the same for every kind.

import type { FromNode, LocalNodeConfig } from './protocol.js'

/** Where the component sees the data directory. */
export const GUEST_DATA_DIR = '/data'

/** What main and the process both need to know of a kind. */
export interface NodeIdentity {
  /** The resources folder and the manifest's name (`resources/<name>/<name>.json`), and the key the process finds the kind by. */
  readonly name: string
  /** How a sentence names it after "the": `Swarm node`. */
  readonly noun: string
}

export type Fetcher = (url: string, signal: AbortSignal) => Promise<{ ok: boolean, json: () => Promise<unknown> }>

export interface ReadinessDeps {
  /** The node's API, `http://127.0.0.1:<port>`. */
  readonly base: string
  readonly fetcher: Fetcher
  readonly post: (message: FromNode) => void
  readonly everyMs: number
}

export interface Readiness {
  /** Every line the node writes, for a kind whose log says what its API does not. */
  readonly onLog?: (line: string) => void
  /** Ends the watch. */
  readonly stop: () => void
}

export interface NodeKind extends NodeIdentity {
  /** `argv` of the component, the program name first. */
  arguments: (config: LocalNodeConfig) => string[]
  /** Makes what the node reads from its data directory (a config file, a key's password) for this run, with the directory made. */
  prepare: (dataDir: string, apiPort: number) => Promise<void>
  /** Posts `listening` once the API answers and `ready` once the node is usable, until stopped. */
  watchReadiness: (deps: ReadinessDeps) => Readiness
}
