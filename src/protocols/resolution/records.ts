// What a name resolver returns and what a data gatherer reads: the records,
// where each one came from, and the failures both can report. Plain data, so
// it crosses a MessagePort unchanged. Rationale: README.md's Design notes.

/**
 * A contenthash, decoded (ENSIP-7). CIDs and keys stay strings here so this
 * directory needs no IPFS library; the gatherer parses them and refuses what
 * does not parse.
 */
export type ContentPointer =
  | { readonly kind: 'ipfs', readonly cid: string }
  /** An IPNS name that is a public key, as a libp2p-key CID string. Its record is signed. */
  | { readonly kind: 'ipns-key', readonly key: string }
  /** An IPNS name that is a DNS name: its last hop is a DNSLink TXT record, which DNS can forge. */
  | { readonly kind: 'dnslink', readonly domain: string }
  /** Swarm, Arweave, an unknown codec: shown as unsupported, never guessed at. */
  | { readonly kind: 'unsupported', readonly protocol: string }

/** How a record reached this machine. */
export type Provenance =
  /** Proven by the light client at `block`. `offchain`: a CCIP-Read answer took part, checked inside the proven call. */
  | { readonly via: 'chain', readonly block: number, readonly offchain: boolean }
  /** Read from DNS, unauthenticated. */
  | { readonly via: 'dns', readonly domain: string }
  /** A test build's fixed name, never compiled into an ordinary build. */
  | { readonly via: 'fixture' }

export interface NameRecord {
  readonly type: 'contenthash'
  readonly pointer: ContentPointer
  readonly provenance: Provenance
}

/** One hop from a name to the content's root, as evidence. */
export type PointerStep =
  | { readonly step: 'contenthash', readonly name: string, readonly pointer: ContentPointer, readonly provenance: Provenance }
  /** A signed IPNS record, its signature and validity checked, and never older than the highest sequence seen for its key. */
  | { readonly step: 'ipns-record', readonly key: string, readonly sequence: bigint, readonly target: string }
  | { readonly step: 'dnslink', readonly domain: string, readonly target: string }

/** The identifier a Web3 Score provider would assess for this content. */
export interface ContentRoot {
  readonly kind: 'ipfs'
  readonly cid: string
}

/**
 * Why a name could not be loaded, in the order the error pages need:
 * `not-synced` is "cannot verify yet"; `unverifiable` (an answer failed its
 * proof or its hash) and `unavailable` (nobody answered) are "cannot
 * verify"; `not-found` and `invalid-name` are "not found"; `unsupported` is
 * a contenthash this build cannot load.
 */
export type ResolutionFailure = 'invalid-name' | 'not-found' | 'unsupported' | 'not-synced' | 'unverifiable' | 'unavailable'

export class ResolutionError extends Error {
  override readonly name = 'ResolutionError'
  constructor (readonly failure: ResolutionFailure, message: string) {
    super(message)
  }
}

/**
 * When every provider failed, the failure worth showing. A detected lie
 * outranks everything, because hiding it behind "unavailable" would hide an
 * attack; nobody answering is the least specific.
 */
const FAILURE_PRECEDENCE: readonly ResolutionFailure[] = ['unverifiable', 'not-synced', 'not-found', 'unsupported', 'invalid-name', 'unavailable']

export function mostSpecificFailure (failures: readonly ResolutionFailure[]): ResolutionFailure {
  return FAILURE_PRECEDENCE.find((failure) => failures.includes(failure)) ?? 'unavailable'
}
