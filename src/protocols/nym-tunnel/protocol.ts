// What the shell and the Nym tunnel's utility process say to each other over
// its parent port. Plain data only: it is structured-cloned.

import type { NodeIdentity } from '../local-node/kind.js'
import type { PinnedFile } from '../local-node/protocol.js'

export type { PinnedFile }

/** The resources folder and manifest name (`resources/nym-tunnel/nym-tunnel.json`), which `ORIVON_NYM_TUNNEL_DIR` and `ORIVON_NYM_TUNNEL_LOG` follow from. */
export const NYM_TUNNEL_IDENTITY: NodeIdentity = { name: 'nym-tunnel', noun: 'Nym tunnel' }

/** The module's glue: `<name>.js`, next to `<name>_bg.wasm`. */
export const MODULE_GLUE = 'smolmix_wasm.js'
export const MODULE_WASM = 'smolmix_wasm_bg.wasm'

/** How much of Nym's decoy traffic a tunnel sends, which is what an observer of the connection learns about when the person is active (the host's README.md says what each costs). */
export type NymPrivacy = 'balanced' | 'strongest'
export const NYM_PRIVACY_LEVELS: readonly NymPrivacy[] = ['balanced', 'strongest']
export const DEFAULT_NYM_PRIVACY: NymPrivacy = 'balanced'

export function isNymPrivacy (value: unknown): value is NymPrivacy {
  return NYM_PRIVACY_LEVELS.includes(value as NymPrivacy)
}

/** The module's `setupMixTunnel` options for each level. */
export interface MixPrivacyOptions {
  readonly disablePoissonTraffic: boolean
  readonly disableCoverTraffic: boolean
}

/** Balanced drops the steady stream of packets and keeps the loop cover traffic; strongest is Nym's own default. A value that is neither is read as strongest, the one that hides more. */
export function mixOptionsFor (privacy: NymPrivacy): MixPrivacyOptions {
  return { disablePoissonTraffic: privacy === 'balanced', disableCoverTraffic: false }
}

export interface NymTunnelConfig {
  /** The directory holding the module. */
  readonly moduleDir: string
  /** The files the module is made of, as pinned. The process reads each once and runs only bytes that match. */
  readonly files: readonly PinnedFile[]
  /** The loopback port the SOCKS5 server listens on. */
  readonly port: number
  /** The password every client must send; made fresh for each start. */
  readonly secret: string
  /** Most tunnels alive at once; past it a new app is refused. */
  readonly maxInstances: number
  /** The level every tunnel started from now on is made at; `privacy` messages change it. */
  readonly privacy: NymPrivacy
  /** Prints the module's own log lines in this process's output. */
  readonly log?: boolean
}

export type ToHost =
  | { readonly type: 'start', readonly config: NymTunnelConfig }
  /** A new level: tunnels started after this are made at it, and the ones running are replaced as soon as nothing is using them. */
  | { readonly type: 'privacy', readonly privacy: NymPrivacy }

/** `artifact`: the files are not the pinned ones; `load`: the module would not start; `listen`: the port is taken. */
export type FailureStage = 'artifact' | 'load' | 'listen' | 'run'

/** The longest `failed.message` main accepts and the process sends. */
export const MAX_FAILURE_MESSAGE = 500

export type FromHost =
  /** The SOCKS5 server accepts connections. */
  | { readonly type: 'listening' }
  /** Posted whenever the tunnels change. `problem` is why the latest one could not come up or was refused, until a later one is ready. */
  | { readonly type: 'instances', readonly connecting: number, readonly ready: number, readonly started: number, readonly problem?: string }
  | { readonly type: 'failed', readonly stage: FailureStage, readonly message: string }

export function failure (stage: FailureStage, message: string): FromHost {
  return { type: 'failed', stage, message: message.length > MAX_FAILURE_MESSAGE ? `${message.slice(0, MAX_FAILURE_MESSAGE - 1)}…` : message }
}

/** A user name made for one short use (the Settings test): its tunnel is closed soon after the use ends, since it costs a core's worth of cover traffic for as long as it is open. */
export const SHORT_LIVED_USER_PREFIX = 'orivon-test-'
export const SHORT_LIVED_USER = 'orivon-test-settings'
export const SHORT_LIVED_IDLE_MS = 5_000

/** The user names a SOCKS5 client may send: what `isolationCredentials` makes, and what a test may use. */
export const USER_NAME = /^[\w.-]{1,64}$/
