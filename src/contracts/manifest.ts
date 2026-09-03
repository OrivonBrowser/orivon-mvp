// Transcribed from docs/architecture/capability-api.md SSManifest.
//
// The manifest is served alongside the app's frontend assets at
// /.well-known/orivon.json and fetched before first run. It DECLARES what an
// app may ask for; the user GRANTS what it actually gets. An app can never
// obtain a capability absent from its manifest, even with user consent, and
// absence means absence, not default-allow (design rules 4 and 5).
//
// NEVER PROBED AUTOMATICALLY. An unsolicited request to every origin the user
// visits is an active, attributable "this visitor runs Orivon" signal, sent
// from a privacy-branded browser. v0 discovery is a <link rel="orivon-manifest">
// hint in HTML already delivered, or explicit user action ("Open as app").

/** Opaque identifier for one persisted grant. See ./capability-api.js. */
export type GrantId = string

/**
 * A host:port pattern such as `"*:*"` or `"api.example.com:443"`, or a port
 * range such as `"6881-6889"`.
 *
 * Patterns are matched against RESOLVED ADDRESSES, never against the hostname
 * the app supplied (security-model.md T12 -- a correct glob matcher fed a
 * hostname is still fully defeated by DNS rebinding).
 */
export type Pattern = string

export interface Manifest {
  /** 0 means UNSTABLE: breaking changes are permitted until it reaches 1. */
  readonly orivonApiVersion: 0
  /**
   * Reverse-DNS, and INFORMATIONAL ONLY. The origin is the real isolation key
   * -- it keys storage, the session partition, the grant ledger entry and the
   * derived identity key. An `id` collision with an installed app is surfaced
   * explicitly to the user (security-model.md T18).
   */
  readonly id: string
  /**
   * Self-asserted by the site. The grant prompt renders the ORIGIN as the
   * largest, primary, non-app-controlled element and marks this as merely
   * claimed -- any origin can serve a manifest, so a hostile site can present
   * itself as "Orivon Torrent" with an otherwise identical prompt.
   */
  readonly name: string
  /**
   * Semver core plus optional prerelease; build metadata is stripped and
   * ignored (capability-api.md SSversion). Backs the per-origin VERSION FLOOR
   * (security-model.md T19): an update below the highest version ever
   * installed is rejected, so a validly-hash-pinned older bundle cannot be
   * replayed to suppress a fix. A version that does not parse as semver FAILS
   * CLOSED -- treated as below the floor -- so the app loader must reject one
   * at first install, not only on update.
   */
  readonly version: string
  readonly entry: string
  /**
   * Every other frontend file the app ships, alongside `entry`. Publisher-
   * declared, never inferred (ADR-0011) -- this is the leaf set ADR-0009's
   * bundle hash is computed over. Omit when the app is `entry` alone; an
   * empty array is rejected as the same ambiguity every other optional list
   * in this file rejects it as.
   */
  readonly assets?: readonly string[]
  readonly capabilities: Capabilities
}

export interface Capabilities {
  readonly net?: NetCapability
  readonly fs?: FsCapability
  readonly id?: IdCapability
  /**
   * Schemes the shell may route to this app, e.g. `["magnet"]`. Declaration
   * alone never wins the default: routing requires its own user prompt, first
   * registrant is the default, and conflicts are resolved by the user. The URI
   * is validated against a strict grammar before it touches any other code
   * (security-model.md T23).
   */
  readonly protocols?: readonly string[]
}

export interface NetCapability {
  readonly tcp?: TcpCapability
  readonly udp?: UdpCapability
}

export interface TcpCapability {
  /**
   * host:port patterns. `"*:*"` is permitted and is what a P2P app genuinely
   * needs -- DHT and peer exchange reach arbitrary hosts. The grant prompt
   * must say so in plain words ("connect to any computer on the internet"),
   * not hide it behind a pattern string. Understating it would be exactly the
   * dishonesty ADR-0006 exists to prevent.
   */
  readonly connect?: readonly Pattern[]
  /**
   * Port ranges. `"*"` is REJECTED here -- a declared range is required, and
   * privileged ports below 1024 are denied outright at every tier
   * (capability-api.md A9 SS1). Listening opens a service rather than making
   * an outbound call, and gets a distinct, more serious prompt.
   */
  readonly listen?: readonly Pattern[]
}

export interface UdpCapability {
  /** Port ranges, same rules as tcp.listen. */
  readonly bind?: readonly Pattern[]
  /** host:port patterns, same rules as tcp.connect. */
  readonly send?: readonly Pattern[]
}

export interface FsCapability {
  /**
   * ENFORCED, not advisory (capability-api.md A9 SS3). Advisory means a buggy
   * or hostile app fills the user's disk -- security-model.md T11, and a
   * genuinely bad first-run experience for a torrent-first browser. The broker
   * maintains a running per-origin byte counter, checks it on write, and
   * yields 'limit' when exceeded, reconciling against the directory on startup
   * rather than walking the tree on every operation.
   */
  readonly quotaBytes?: number
}

export interface IdCapability {
  readonly curves?: readonly string[]
}

/**
 * One capability actually granted to one origin.
 *
 * KEYED ON (origin, capability, pattern set) -- capability-api.md A9 SS2. The
 * pattern set is load-bearing and not decoration: the re-consent trigger is a
 * SUBSET CHECK over it, not a comparison of capability kinds. An update
 * changing `connect: ["api.example.com:443"]` to `connect: ["*:*"]` requests
 * no new capability KIND and would install silently under a kind comparison --
 * the user granted "talk to one host" and the app would hold "connect to any
 * computer on the internet", which is the exact grant journey 1 puts on
 * camera.
 */
export interface Grant {
  readonly id: GrantId
  /** The web origin: scheme + host + port. Deliberately the web's definition. */
  readonly origin: string
  readonly capability: CapabilityKind
  /** What was granted. Empty for capabilities that carry no patterns. */
  readonly patterns: readonly Pattern[]
  readonly grantedAt: number
}

export type CapabilityKind =
  | 'tcp.connect'
  | 'tcp.listen'
  | 'udp.bind'
  | 'udp.send'
  | 'fs'
  | 'id'
