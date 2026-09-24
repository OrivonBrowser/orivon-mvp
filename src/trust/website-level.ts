// The Website level of the canonical Web3 scores page, as far as this
// browser can observe it: Level 1 or Level 2. Level 3 and above are judged,
// and only a Web3 Score provider may give them.

export type ObservedLevel = 1 | 2

/** A `.eth` site's content, as the verifier served it now or as an installed app's pin recorded it. */
export type ContentEvidence =
  | { readonly source: 'live', readonly cid: string, readonly ddoc: 'met' | 'not-met' | 'failed', readonly reason?: string }
  | { readonly source: 'pinned', readonly cid: string, readonly pointersVerified: boolean }

export interface WebsiteLevel {
  readonly level: ObservedLevel
  /** Why this level, in one sentence a person can read. */
  readonly because: string
  /** What a Web3 Score provider would assess: the CID of IPFS content, or a hash-pinned app's bundle hash. */
  readonly assessable: { readonly kind: 'cid' | 'bundle-hash', readonly value: string } | undefined
}

function levelOf (content: ContentEvidence | undefined): { level: ObservedLevel, because: string } {
  if (content === undefined) return { level: 1, because: 'Nothing observed ties this page\'s files to what its owner published.' }
  if (content.source === 'pinned') {
    return content.pointersVerified
      ? { level: 2, because: 'Every file was checked, when it was installed, against the content this name points to on Ethereum.' }
      : { level: 1, because: 'Installed through a DNS record anyone on the network path could forge; its files were still checked against the content that record named.' }
  }
  switch (content.ddoc) {
    case 'met': return { level: 2, because: 'Every file shown was checked against the content this name points to on Ethereum.' }
    case 'not-met': return { level: 1, because: `A step from the name to its content could not be verified (${content.reason ?? 'unknown'}); the files were still checked against the content it named.` }
    case 'failed': return { level: 1, because: `A file of this site failed its check from every source and was not shown (${content.reason ?? 'unknown'}). Someone may be tampering with it.` }
  }
}

/**
 * Level 2 only when every pointer from the name to its content and every
 * byte served were verified. An ordinary site is Level 1, pinned or not:
 * a hash tree on its own host is evidence, shown beside the level, not
 * DDOC (`open-questions.md` A254).
 */
export function websiteLevel (content: ContentEvidence | undefined, bundleHash: string | undefined): WebsiteLevel {
  const assessable = content !== undefined
    ? { kind: 'cid' as const, value: content.cid }
    : bundleHash !== undefined ? { kind: 'bundle-hash' as const, value: bundleHash } : undefined
  return { ...levelOf(content), assessable }
}
