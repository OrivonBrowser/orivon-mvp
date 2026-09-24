// The two provider shapes of the canonical DNS resolution and Data gathering
// pages, as internal interfaces. Built in, not yet open to Apps.

import type { ContentRoot, NameRecord, PointerStep } from './records.js'

/** Resolves names under the top-level domains it declares, to every record a gatherer can use. */
export interface NameResolver {
  readonly id: string
  /** Lowercase, without a dot: `['eth']`. */
  readonly topLevelDomains: readonly string[]
  /** Throws a ResolutionError; an empty list means the name has no usable record. */
  resolve: (name: string, signal?: AbortSignal) => Promise<NameRecord[]>
}

/** Inclusive offsets, as an HTTP Range and src/loader/serve-range.ts's ByteRange are. */
export interface GatherRange {
  readonly start: number
  readonly end: number
}

export interface GatheredFile {
  /** The file actually served, decoded: `/docs/index.html` for a request of `/docs`. */
  readonly servedPath: string
  /** The whole file's size, whatever range was asked for. */
  readonly size: number
  /** Only bytes that were checked against their hash before being yielded. */
  readonly body: AsyncIterable<Uint8Array>
}

/**
 * What the site's own bytes have shown so far this navigation. `met`: every
 * pointer from the name to the root was verified, and every byte served
 * was. `not-met`: a pointer could not be verified (DNSLink), though the
 * bytes still were, against the root that pointer named. `failed`: a
 * resource could not be served verified from any source.
 */
export type DdocReport =
  | { readonly status: 'met', readonly refusals: readonly Refusal[] }
  | { readonly status: 'not-met', readonly reason: string, readonly refusals: readonly Refusal[] }
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
  /** Throws a ResolutionError. */
  mount: (name: string, records: readonly NameRecord[], signal?: AbortSignal) => Promise<MountedSite>
}
