// Transcribed from docs/architecture/capability-api.md's "Manifest" section.
//
// manifest.ts - What an app can declare
//
// The manifest is served alongside the app's frontend assets at
// /.well-known/orivon.json and fetched before first run. It DECLARES what an
// app may ask for; the user GRANTS what it actually gets. An app can never
// obtain a capability absent from its manifest, even with user consent, and
// absence means absence, not default-allow (design rules 4 and 5).
//
// NEVER PROBED AUTOMATICALLY. An unsolicited request to every origin the user
// visits is an active, attributable "this visitor runs Orivon" signal, sent
// from a privacy-branded browser. Discovery is a <link rel="orivon-manifest">
// hint in HTML already delivered -- the only trigger; there is no separate
// user action (capability-api.md's 2026-09-03 correction).

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

/**
 * How much control a person gets over which of this app's declared
 * capabilities they actually grant. See `Manifest.consentGranularity`, which
 * is where the default-when-absent and the reason the app (not Orivon)
 * chooses are argued.
 */
export type ConsentGranularity =
  /**
   * The whole declared capability set is one decision: accept everything,
   * or run nothing. There is no moment where the app holds part of what it
   * declared -- every grant it ever receives is all of it or none of it.
   */
  | 'all-or-nothing'
  /**
   * Each declared capability is its own decision. A person can grant the
   * app's network access and refuse its filesystem access in the same
   * sitting. The app finds out what it actually got from
   * `orivon.app.grants()`, which may report less than its manifest declared.
   */
  | 'per-capability'

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
   * ignored (capability-api.md's "version" section). Backs the per-origin VERSION FLOOR
   * (security-model.md T19): an update below the highest version ever
   * installed is rejected, so a validly-hash-pinned older bundle cannot be
   * replayed to suppress a fix. A version that does not parse as semver FAILS
   * CLOSED -- treated as below the floor -- so the app loader must reject one
   * at first install, not only on update.
   */
  readonly version: string
  /** Path to the app's entry HTML, relative to the manifest's own origin. */
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
  /**
   * Which consent style this app can survive -- see `ConsentGranularity`
   * for what each value means for the person granting it. **The app
   * declares this, not Orivon**, because only the app's own author knows
   * which their code can survive: code ported from Node or Electron was
   * never written to handle a capability being refused, so a person
   * refusing just one of several requested capabilities is not a smaller
   * version of that app working, it is an unhandled crash wearing a
   * different shape. An app written for Orivon from the start can check
   * `orivon.app.grants()` on purpose and degrade a missing capability
   * gracefully, so its author is free to offer a person real per-item
   * choice instead.
   *
   * OMITTED MEANS `'all-or-nothing'`. Every manifest written before this
   * field existed was written with no knowledge that a partial grant could
   * ever happen -- which describes a ported app exactly -- so the safe
   * reading of silence is the one that can never hand an unprepared app a
   * state it has no code path for. This costs the generous case (a person
   * who wants the app but not its filesystem access still has only the
   * choice to decline the whole thing) to avoid the unsafe one (an app
   * mid-crash on a refusal its own code has no way to interpret). A person
   * who wants finer control over an app that has not opted in still has
   * the settings-list revoke path (`docs/open-questions.md` A101) once the
   * app is running -- narrower than a row in the install prompt, but not
   * nothing.
   *
   * ONE FLAG FOR THE WHOLE MANIFEST, not one per capability. The choice
   * this expresses is about whether the app's OWN CODE can cope with an
   * incomplete grant at all, which is a property of the app as a whole --
   * a ported app has no code path for a missing filesystem grant any more
   * than for a missing network one, so a finer split would ask an author
   * to answer a question their code does not actually distinguish.
   * (`docs/open-questions.md` A138.)
   */
  readonly consentGranularity?: ConsentGranularity
}

export interface Capabilities {
  readonly net?: NetCapability
  readonly fs?: FsCapability
  readonly id?: IdCapability
  /**
   * Isolated contexts (ADR-0019): an empty document at an origin the app
   * names, for running that site's own script as that site would -- with
   * none of the person's data there, and no network beyond this app's own
   * `https.connect` grant. See `capability-api.ts`'s `OrivonWeb`.
   */
  readonly web?: WebCapability
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
  readonly https?: HttpsCapability
  /**
   * How many sockets this app may hold open at once -- TcpSocket, UdpSocket
   * and accepted connections combined, the same total `LIMITS.concurrentSockets`
   * bounds. A TLS-terminated socket from `net.connectSecure` counts here too:
   * it is the same handle shape, the same read/write credit windows, and the
   * same OS socket underneath -- ADR-0017 changes who does the handshake, not
   * what the socket costs.
   *
   * DECLARED BY THE APP, SHOWN AT GRANT TIME, ENFORCED BY THE BROKER, exactly
   * as `FsCapability.quotaBytes` already is (owner decision, 2026-09-06). The
   * number a person approves is the app's own stated need rather than a hidden
   * platform default, and it is the honest one to show, because this is also
   * what bounds the memory an app can pin: every open socket carries a read
   * and a write credit window (`readWindowBytes` + `writeWindowBytes`), so the
   * socket count IS the memory ceiling.
   *
   * Omitted means `LIMITS.defaultConcurrentSockets`, deliberately modest --
   * an ordinary app never reaches it, and anything that genuinely needs more
   * (a P2P app talking to a swarm) has to say so, which is the point: the
   * heavy case is always a number the user was shown. Declaring MORE than
   * `LIMITS.concurrentSockets` is not a manifest error; the broker enforces
   * the lower of the two, so the platform ceiling always wins.
   */
  readonly concurrentSockets?: number
}

export interface TcpCapability {
  /**
   * host:port patterns. `"*:*"` is permitted and is what a P2P app genuinely
   * needs -- DHT and peer exchange reach arbitrary hosts. The grant prompt
   * must say so in plain words ("connect to any computer on the internet"),
   * not hide it behind a pattern string. Understating it would be exactly the
   * dishonesty ADR-0006 exists to prevent.
   *
   * Matched against the RESOLVED address, same as every pattern in this
   * interface (T12) -- unaffected by `HttpsCapability` below, which is a
   * separate grant with a different, and differently justified, matching
   * rule.
   */
  readonly connect?: readonly Pattern[]
  /**
   * Port ranges. `"*"` is REJECTED here -- a declared range is required, and
   * privileged ports below 1024 are denied outright at every tier
   * (capability-api.md's open item A9, point 1). Listening opens a service rather than making
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

/**
 * TLS terminated on the trusted side (ADR-0017): the broker performs the
 * handshake, certificate chain validation and hostname verification, using
 * the encryption stack already in the shipped runtime -- no new dependency
 * (Rule 8 unaffected). `net.connectSecure` hands the app back a
 * `SecureTcpSocket`: `net.connect`'s `TcpSocket` shape, carrying plaintext
 * bytes, plus what the handshake established (./handles.js).
 *
 * A SEPARATE GRANT FROM `TcpCapability`, deliberately -- `net.tcp.connect`'s
 * raw path is unaffected by this capability's existence. Two apps that both
 * declare network access can present very differently to the person
 * granting it: "connect to any computer on the internet" (raw TCP) reads as
 * a materially different, scarier claim than "reach any HTTPS website"
 * (this capability), and collapsing them into one grant would either
 * understate the first or overstate the second.
 */
export interface HttpsCapability {
  /**
   * host:port patterns, same syntax as `TcpCapability.connect` -- including
   * `"*:*"` for unlimited HTTPS, which a manifest may legitimately declare
   * (ADR-0017). **The prompt must render this breadth as visibly as
   * `tcp.connect: ["*:*"]` already must** (`open-questions.md` A100): the
   * widest permission in the system must not look identical to a narrow
   * one just because its name sounds tamer.
   *
   * MATCHED AGAINST THE HOSTNAME THE APP ASKED FOR, not the resolved
   * address -- the one deliberate departure from every other pattern list
   * in this file, and it is safe rather than a regression of T12.
   * `tcp.connect` matches on the resolved address because nothing else ties
   * a hostname to who actually answered; here, the broker's own certificate
   * and hostname verification already does that binding cryptographically
   * -- an attacker who controls DNS still cannot present a certificate a
   * trusted root signed for that hostname. Matching on the verified
   * hostname is what lets the grant prompt name the real site the app is
   * talking to (ADR-0017's "the trusted side sees the real hostname, so a
   * grant can name it directly").
   */
  readonly connect?: readonly Pattern[]
}

export interface FsCapability {
  /**
   * ENFORCED, not advisory (capability-api.md's open item A9, point 3). Advisory means a buggy
   * or hostile app fills the user's disk -- security-model.md T11, and a
   * genuinely bad first-run experience for a torrent-first browser. The broker
   * maintains a running per-origin byte counter, checks it on write, and
   * yields 'limit' when exceeded, reconciling against the directory on startup
   * rather than walking the tree on every operation.
   */
  readonly quotaBytes?: number
}

export interface IdCapability {
  /** Curve names the app may pass to `orivon.id.publicKey`/`sign`, e.g. `["secp256k1"]`. Omitted means none. */
  readonly curves?: readonly string[]
}

/**
 * ADR-0019. The prompt names every origin listed here, in words that say what
 * it means: "run code as www.youtube.com, in a private, empty session".
 */
export interface WebCapability {
  /**
   * Origins the app may open an isolated context at. Each is an EXACT
   * `https://host` or `https://host:port` origin -- no wildcard, no path, no
   * userinfo, and never an address literal outside public unicast
   * (security-model.md T12) or a `localhost` name. A grant's `patterns` for
   * `web.context` are these strings, compared exactly.
   */
  readonly contexts?: readonly string[]
}

/**
 * One capability actually granted to one origin.
 *
 * KEYED ON (origin, capability, pattern set) -- capability-api.md's open item A9, point 2. The
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
  | 'https.connect'
  | 'fs'
  | 'id'
  | 'web.context'
