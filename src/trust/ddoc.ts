// DDOC evidence (ADR-0029): whether the bundle this browser pinned is the one
// the site publishes a hash tree for. Evidence only -- nothing here blocks a
// load; deciding what a failure means is the Web3 Score's job. The anchor is
// the site's own host, so "verified" says the files match what that host
// publishes, never who owns the domain.

/** Enough of a pin to compare against: its root and its path -> leaf table. */
export interface PinnedTree {
  readonly bundleHash: string
  readonly assets: ReadonlyArray<{ readonly path: string, readonly leaf: string }>
}

/** The tree the site published, in the same shape. */
export interface PublishedTree {
  readonly bundleHash: string
  readonly leaves: ReadonlyArray<{ readonly path: string, readonly leaf: string }>
}

export const MAX_NAMED_DIFFERENCES = 20

export type DdocVerdict =
  | { readonly status: 'not-checked' }
  | { readonly status: 'not-published' }
  | { readonly status: 'verified' }
  | {
    readonly status: 'failed'
    /** Sorted; at most MAX_NAMED_DIFFERENCES of them. A file changed, published but not received, or received but not published. */
    readonly differing: readonly string[]
    readonly differingCount: number
    /** False when every file matches but the published root does not: the site's own file contradicts itself. */
    readonly rootMatches: boolean
  }

/**
 * Compared against the CURRENT pin, so a tree stored for an earlier bundle
 * can only ever fail, never verify. Both the root and every leaf must
 * match: a matching root beside a wrong leaf table would let a provider
 * reading the table be misled.
 */
export function ddocVerdict (pin: PinnedTree | null, published: PublishedTree | undefined): DdocVerdict {
  if (pin === null) return { status: 'not-checked' }
  if (published === undefined) return { status: 'not-published' }

  const publishedLeaves = new Map(published.leaves.map(({ path, leaf }) => [path, leaf]))
  const pinnedPaths = new Set<string>()
  const differing: string[] = []
  for (const { path, leaf } of pin.assets) {
    pinnedPaths.add(path)
    if (publishedLeaves.get(path) !== leaf) differing.push(path)
  }
  for (const path of publishedLeaves.keys()) {
    if (!pinnedPaths.has(path)) differing.push(path)
  }

  const rootMatches = published.bundleHash === pin.bundleHash
  if (differing.length === 0 && rootMatches) return { status: 'verified' }
  differing.sort()
  return { status: 'failed', differing: differing.slice(0, MAX_NAMED_DIFFERENCES), differingCount: differing.length, rootMatches }
}
