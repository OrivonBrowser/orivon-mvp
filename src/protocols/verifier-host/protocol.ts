// What the shell and the verifier host say to each other over the utility
// process's parent port. Plain data only: it is structured-cloned, and a
// reply that never comes is the failure to expect, so every request has a
// deadline on the shell's side.

import type { ContentRoot, PointerStep } from '../resolution/records.js'
import type { DdocReport, ServedFrom } from '../resolution/providers.js'
import type { LocalNodeState } from '../local-node/protocol.js'

/** A beacon block root, as a checkpoint must be: Helios, handed anything else, silently uses one compiled into it, about a year old. */
export const BLOCK_ROOT_PATTERN = /^0x[0-9a-f]{64}$/

/** The tunnels a website can have: Nym, or the person's own SOCKS5 proxy. */
export type TunnelRoute = 'nym' | 'socks5'

/**
 * How a request's fetches leave this process. `direct`: Electron's `net`, outside the tunnel unless the whole browser is on
 * it. `nym` and `socks5`: a website in that tunnel's profile, which only that profile's front carries
 * (`HostConfig.profileFronts`).
 */
export type FetchRoute = 'direct' | TunnelRoute

export interface LightClientConfig {
  /** Asked in order: a request that fails or errors goes to the next. */
  readonly executionRpcs: readonly string[]
  readonly consensusRpc: string
  /** A finalized beacon block root, chosen by the shell. */
  readonly checkpoint: string
  /**
   * Of the addresses above, those the person named that are on this computer or their home network (`localhost`, or a loopback or
   * private address literal). They are reached by `local-rpc-fetch.ts` and by nothing else, never through a proxy or a tunnel; the host
   * checks each is such a literal and refuses to start the client if one is not, or if a local address above is missing from here.
   */
  readonly localEndpoints?: readonly string[]
  /** Whether the execution servers, and the consensus server, are the person's own and not Orivon's (the person's replace Orivon's, they are never added to them). Absent: Orivon's. */
  readonly ownServers?: { readonly execution: boolean, readonly consensus: boolean }
}

/** A mount needs the local node `node` (a kind's name): main starts it if it is not running. */
export interface NodeWanted { readonly type: 'node-wanted', readonly node: string }
/** What main says the local node `node` is doing, as its answer to `node-wanted` and whenever it changes. */
export interface NodeNotice { readonly type: 'node', readonly node: string, readonly state: LocalNodeState['state'], readonly reason?: string }

export interface HostConfig {
  readonly port: number
  /** Undefined when the light client does not run: every `.eth` name then fails closed. */
  readonly lightClient: LightClientConfig | undefined
  /** Why it does not run, in words for the error page. */
  readonly lightClientOff?: string
  readonly gateways: readonly string[]
  /** Which of `gateways` main found to have no proxy configured, as of this
   * host's start (`main/verifier/proxy-check.ts`) -- the DNS-tamper
   * fallback (`dns-fallback.ts`) reaches one of these directly only after
   * Electron's own `net.fetch` fails it AND the system resolver disagrees
   * with a DoH one; every other gateway, and every other kind of failure,
   * still goes through `net.fetch` alone. Empty turns the fallback off
   * entirely. */
  readonly unproxiedGateways: readonly string[]
  /** Whether main found NO proxy configured for the default session, as of
   * this host's start (`main/verifier/proxy-check.ts`) -- a snapshot, like
   * `unproxiedGateways` above, not re-checked until the host restarts. Only
   * this makes `guardedCcipRequest` (`egress.ts`) dial the address it
   * already checked directly; a configured proxy must keep doing the
   * resolving, never be silently gone around for one kind of request (T20). */
  readonly ccipDirect: boolean
  /**
   * Present while the whole browser is on the tunnel: the front the host's requests go through (main points the process's own
   * network context at it with `app.setProxy`), and the sign-in it expects. `net.fetch` in a utility process cannot answer the
   * front's challenge, so the host fetches with `net.request` and answers it itself, for this port alone. Absent, the host
   * fetches with `net.fetch` as it always has.
   */
  readonly front?: { readonly port: number, readonly username: string, readonly password: string }
  /**
   * The front of each tunnel's profile, which every fetch for a website in that profile goes through (`routed-fetch.ts`) and
   * nothing else carries. A tunnel with none here fails such a website's fetches: they are never made another way.
   */
  readonly profileFronts?: Readonly<Partial<Record<TunnelRoute, { readonly port: number, readonly username: string, readonly password: string }>>>
  /** w3name-style services asked for an IPNS record after the gateways. */
  readonly ipnsNameServices: readonly string[]
  readonly dnsOverHttps: readonly string[]
  /** Highest IPNS sequence seen per key, as decimal strings, from earlier runs. */
  readonly ipnsSequences: Readonly<Record<string, string>>
  /** Swarm endpoints asked for `/chunks`, in order of preference. Empty means no Swarm content can be opened. */
  readonly swarmEndpoints: readonly string[]
  /** Highest feed update index seen per feed, as decimal strings keyed `<owner>/<topic>`, from earlier runs. */
  readonly swarmFeedIndexes: Readonly<Record<string, string>>
  /** `swarmEndpoints` is the Swarm node Orivon runs: as each Swarm mount begins the host asks main for it (`node-wanted`), and a read waits for its state only where a chunk has to come from it. */
  readonly swarmNode?: boolean
  /** The person has switched Swarm off. Every Swarm mount is then held for the node's answer, which says so, before it reads anything: a site kept on disk does not open against the switch. */
  readonly swarmSwitchedOff?: boolean
  /**
   * Where verified Swarm chunks are kept between runs (`swarm-chunk-database.ts`): the verifier's directory in the profile, and the
   * per-profile salt in hex that keys the rows and names the file. Present in every run that reads Swarm, whether or not the IPFS node
   * is chosen; absent, chunks are kept in memory alone.
   */
  readonly swarmChunks?: { readonly dir: string, readonly salt: string }
  /** Present when the person chose to read IPFS from the node Orivon runs: `endpoint` is its origin. Each mount asks main for the node first (`node-wanted`), and a mount the node cannot serve reads from `gateways` and says why. */
  readonly ipfsNode?: {
    readonly endpoint: string
    /** Per-profile random bytes in hex that the partition keys the node's store by are made with (`partition-key.ts`). Never sent anywhere else. */
    readonly partitionSalt: string
    /** Whether a name service may be asked for an IPNS record after the node. It follows the lookup-service setting; `ipfs-lookup` changes it while the host runs. */
    readonly lookupService: boolean
    /** Test builds only: the wait before a block the node could not give is asked for again, in place of the node's own memory. */
    readonly retryWaitMs?: number
  }
  /**
   * For each tunnel, whether the local nodes may serve a website whose profile is that tunnel's. They run outside the tunnel unless
   * the whole browser is on it, so a tunnel is true when "Use tunnel to run network nodes" is off (the person accepted direct nodes),
   * or when it is the tunnel the nodes themselves run through, so that a website on the other tunnel never reads through the exit
   * the nodes use. Absent: false for both.
   */
  readonly tunnelSitesReadNodes?: Readonly<Partial<Record<TunnelRoute, boolean>>>
  /** The local nodes run through the tunnel (the whole browser is on it and "Use tunnel to run network nodes" is on): their reads wait as long as the tunnel does. Absent: they are direct, and wait as a direct connection does. */
  readonly nodesRouted?: boolean
  /**
   * The Ethereum light client and CCIP-Read run outside the tunnel ("Use tunnel to run network nodes" is off): a website in the tunnel
   * profile is proved by the shared light client and not by a tunnelled one of its own, and while the whole browser is on the tunnel
   * (`front`) the shared client's requests leave through `HostDeps.outside`. Absent: they follow the tunnel as before.
   */
  readonly ethereumOutside?: boolean
  /** Test builds only: `.eth` names mapped to content with no light client. */
  readonly fixtures?: Readonly<Record<string, string>>
}

export type LightClientState =
  | { readonly state: 'off' }
  | { readonly state: 'starting' }
  | { readonly state: 'syncing', readonly since: number }
  /** `at`: when the newest verified block was produced, in ms, so a head that stopped advancing shows its age. `clockLeadMs`: how far this computer's clock is behind the chain's, negative when it is ahead, when the light client allows for it. */
  | { readonly state: 'synced', readonly block: number, readonly at: number, readonly clockLeadMs?: number }
  /**
   * `bootstrapMissing`: Helios could not start because the consensus server answered 404 to the bootstrap of the checkpoint it was given.
   * `ownServersFailed`: a server the person named is why: every execution server they named is in trouble or none is mainnet, or their
   * beacon server did not give the bootstrap. Absent when the clock, or one of Orivon's servers, may be the cause.
   */
  | { readonly state: 'failed', readonly reason: string, readonly retryAt: number | undefined, readonly bootstrapMissing?: true, readonly ownServersFailed?: true }

export interface SiteProvenance {
  readonly host: string
  readonly resolver: string
  readonly root: ContentRoot
  readonly pointers: readonly PointerStep[]
  readonly ddoc: DdocReport
  readonly mountedAt: number
  /** Where the bytes came from, for a protocol that reads from sources the person can choose between. */
  readonly servedFrom?: ServedFrom
}

export type HostRequest =
  /** What is mounted for a host in a partition now, or null; never resolves anything. */
  | { readonly kind: 'provenance', readonly host: string, readonly partition: string, readonly route?: TunnelRoute }
  /** Resolves and mounts the host in the partition if it is not mounted there, then answers as `provenance` does. `latest` proves the name now even when it is mounted. */
  | { readonly kind: 'mount', readonly host: string, readonly partition: string, readonly route?: TunnelRoute, readonly latest?: true }
  | { readonly kind: 'status' }

export interface HostReplies {
  provenance: SiteProvenance | null
  mount: SiteProvenance
  status: LightClientState
}

export type ToHost =
  | { readonly type: 'start', readonly config: HostConfig }
  | { readonly type: 'request', readonly id: number, readonly request: HostRequest }
  | NodeNotice
  /** The person changed whether IPFS may ask a lookup service: from the next IPNS lookup, a name service is asked or not. */
  | { readonly type: 'ipfs-lookup', readonly allowed: boolean }

export type FromHost =
  | { readonly type: 'listening', readonly fingerprint: string }
  | { readonly type: 'failed', readonly stage: 'start' | 'listen', readonly message: string }
  | { readonly type: 'reply', readonly id: number, readonly ok: true, readonly value: unknown }
  | { readonly type: 'reply', readonly id: number, readonly ok: false, readonly message: string }
  | { readonly type: 'status', readonly status: LightClientState }
  /** A newer finalized checkpoint the light client verified, for the shell to store. */
  | { readonly type: 'checkpoint', readonly root: string, readonly timestamp: number }
  | { readonly type: 'ipns-sequence', readonly key: string, readonly sequence: string }
  | { readonly type: 'swarm-feed-index', readonly feed: string, readonly index: string }
  | NodeWanted
  /** What the host has read from the local node `node` this session: reads in flight now, and bytes read in all. Sent at most once a second, and only while the node is read. */
  | { readonly type: 'node-traffic', readonly node: string, readonly active: number, readonly bytes: number }
  /** A top-level-domain name was mounted from content of the protocol serving `scheme`, so the shell can show `<scheme>://<host>`. */
  | { readonly type: 'name-scheme', readonly host: string, readonly scheme: string }
