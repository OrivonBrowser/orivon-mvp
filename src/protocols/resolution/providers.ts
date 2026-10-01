// The two provider shapes of the canonical DNS resolution and Data gathering
// pages, as internal interfaces. Built in, not yet open to Apps; a protocol
// (../protocol.ts) groups them under the namespaces it serves.

import type { ContentRoot, NameRecord, PointerStep } from './records.js'

/**
 * Where a name lives: a top-level domain, `.eth`, whose names are hosts; or
 * an address scheme, `ipfs:`, whose names are whatever follows `ipfs://`.
 */
export type Namespace = `.${string}` | `${string}:`

/** Resolves names in the namespaces it declares, to every record a gatherer can use. */
export interface NameResolver {
  readonly id: string
  /** Lowercase: `['.eth']`, `['ipfs:']`. */
  readonly namespaces: readonly Namespace[]
  /**
   * An address scheme's one spelling of `name`, which becomes the host label
   * of its origin: two spellings would be two origins for one site. Throws a
   * ResolutionError `invalid-name`. Without it, the lowercased name is canonical.
   */
  canonicalName?: (name: string) => string
  /** Throws a ResolutionError; an empty list means the name has no usable record. */
  resolve: (name: string, signal?: AbortSignal) => Promise<NameRecord[]>
}

/** Inclusive offsets, as an HTTP Range and src/loader/serve/range.ts's ByteRange are. */
export interface GatherRange {
  readonly start: number
  readonly end: number
}

export interface GatheredFile {
  /** The file actually served, decoded: `/docs/index.html` for a request of `/docs`. */
  readonly servedPath: string
  /** The whole file's size, whatever range was asked for. */
  readonly size: number
  /** Set when the path carries no extension to derive a type from: the site's root is itself a file. */
  readonly contentType?: string
  /** Only bytes that were checked against their hash before being yielded. */
  readonly body: AsyncIterable<Uint8Array>
}

/**
 * DDOC as the site's own bytes have shown it so far, for as long as it
 * stays mounted: every request in its partition adds to one report.
 * `met`: every byte served was checked against the content's hashes, which
 * is how IPFS content meets DDOC by design. `failed`: a resource could not
 * be served verified from any source. Whether the name's pointers to the
 * content were proven is a separate question, answered by the site's
 * `pointers` (`pointer-chain.ts`).
 */
export type DdocReport =
  | { readonly status: 'met', readonly refusals: readonly Refusal[] }
  | { readonly status: 'failed', readonly resource: string, readonly refusals: readonly Refusal[] }

/** A source that sent bytes which failed verification. Nothing it sent was used. */
export interface Refusal {
  readonly source: string
  readonly resource: string
}

/** A name's content, with every pointer to its root already followed and checked. */
export interface MountedSite {
  readonly gatherer: string
  readonly root: ContentRoot
  readonly pointers: readonly PointerStep[]
  /** `/` and a directory serve its `index.html`. Throws a ResolutionError; `not-found` for a missing path. */
  open: (path: string, range?: GatherRange, signal?: AbortSignal) => Promise<GatheredFile>
  ddoc: () => DdocReport
}

/**
 * Loads a site from a resolver's records. Mounting once per navigation is
 * what keeps every file of one page, or one bundle, under one root.
 */
export interface DataGatherer {
  readonly id: string
  supports: (records: readonly NameRecord[]) => boolean
  /**
   * Throws a ResolutionError. `partition` names the cache the mount may
   * share with earlier ones; mounts in different partitions share nothing a
   * page could time, and a mount with none keeps nothing it fetched.
   */
  mount: (name: string, records: readonly NameRecord[], signal?: AbortSignal, partition?: string) => Promise<MountedSite>
}
