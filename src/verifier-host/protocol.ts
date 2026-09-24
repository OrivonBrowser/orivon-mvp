// What the shell and the verifier host say to each other over the utility
// process's parent port. Plain data only: it is structured-cloned, and a
// reply that never comes is the failure to expect, so every request has a
// deadline on the shell's side.

import type { ContentRoot, PointerStep } from '../resolution/records.js'
import type { DdocReport } from '../resolution/providers.js'

export interface LightClientConfig {
  readonly executionRpc: string
  readonly consensusRpc: string
  /** A finalized beacon block root, chosen by the shell. */
  readonly checkpoint: string
}

export interface HostConfig {
  readonly port: number
  /** Undefined when the light client is switched off: every `.eth` name then fails closed. */
  readonly lightClient: LightClientConfig | undefined
  readonly gateways: readonly string[]
  /** w3name-style services asked for an IPNS record after the gateways. */
  readonly ipnsNameServices: readonly string[]
  readonly dnsOverHttps: readonly string[]
  /** Highest IPNS sequence seen per key, as decimal strings, from earlier runs. */
  readonly ipnsSequences: Readonly<Record<string, string>>
  /** Test builds only: `.eth` names mapped to content with no light client. */
  readonly fixtures?: Readonly<Record<string, string>>
}

export type LightClientState =
  | { readonly state: 'off' }
  | { readonly state: 'starting' }
  | { readonly state: 'syncing', readonly since: number }
  | { readonly state: 'synced', readonly block: number, readonly at: number }
  | { readonly state: 'failed', readonly reason: string, readonly retryAt: number | undefined }

export interface SiteProvenance {
  readonly host: string
  readonly resolver: string
  readonly root: ContentRoot
  readonly pointers: readonly PointerStep[]
  readonly ddoc: DdocReport
  readonly mountedAt: number
}

export type HostRequest =
  | { readonly kind: 'provenance', readonly host: string }
  | { readonly kind: 'status' }

export interface HostReplies {
  provenance: SiteProvenance | null
  status: LightClientState
}

export type ToHost =
  | { readonly type: 'start', readonly config: HostConfig }
  | { readonly type: 'request', readonly id: number, readonly request: HostRequest }

export type FromHost =
  | { readonly type: 'listening', readonly fingerprint: string }
  | { readonly type: 'failed', readonly stage: 'start' | 'listen', readonly message: string }
  | { readonly type: 'reply', readonly id: number, readonly ok: true, readonly value: unknown }
  | { readonly type: 'reply', readonly id: number, readonly ok: false, readonly message: string }
  | { readonly type: 'status', readonly status: LightClientState }
  /** A newer finalized checkpoint the light client verified, for the shell to store. */
  | { readonly type: 'checkpoint', readonly root: string, readonly timestamp: number }
  | { readonly type: 'ipns-sequence', readonly key: string, readonly sequence: string }
