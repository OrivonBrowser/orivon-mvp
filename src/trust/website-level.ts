// The Website level of the canonical Web3 scores page, as far as this
// browser can observe it: Level 1 or Level 2. Level 3 and above are judged,
// and only a Web3 Score provider may give them.

import type { DdocVerdict } from './ddoc.js'

export type ObservedLevel = 1 | 2

/** A `.eth` site's content, as the verifier served it now or as an installed app's pin recorded it. */
export interface ContentEvidence {
  readonly source: 'live' | 'pinned'
  readonly cid: string
  /** Whether every pointer from the name to the CID was proven: false through a DNSLink. */
  readonly pointersVerified: boolean
  /** A file of a live page that failed its check from every source. */
  readonly failedResource?: string
}

export interface WebsiteLevel {
  readonly level: ObservedLevel
  /** Why this level, in one sentence a person can read. */
  readonly because: string
  /** What a Web3 Score provider would assess: the CID of IPFS content, or a hash-pinned app's bundle hash. */
  readonly assessable: { readonly kind: 'cid' | 'bundle-hash', readonly value: string } | undefined
}

function contentLevel (content: ContentEvidence): { level: ObservedLevel, because: string } {
  if (content.failedResource !== undefined) {
    return { level: 1, because: `A file of this site failed its check from every source and was not shown (${content.failedResource}). Someone may be tampering with it.` }
  }
  const checked = content.source === 'live' ? 'Every file shown was checked' : 'Every file was checked, when it was installed,'
  return content.pointersVerified
    ? { level: 2, because: `${checked} against the content this name points to on Ethereum.` }
    : { level: 2, because: `${checked} against the content a DNSLink record names. That record is ordinary DNS, which the delivery rungs below show unproven.` }
}

function hostedLevel (ddoc: DdocVerdict): { level: ObservedLevel, because: string } {
  switch (ddoc.status) {
    case 'verified': return { level: 2, because: 'Its installed files match the hash tree this site publishes, which is DDOC. The tree sits on the site\'s own host.' }
    case 'failed': return { level: 1, because: 'Its installed files differ from the hash tree this site publishes. Someone may have altered them.' }
    case 'not-published': return { level: 1, because: 'This site publishes no hash tree, so nothing ties its files to what its owner published.' }
    case 'not-checked': return { level: 1, because: 'This site is not installed, so its files have not been checked against any hash tree.' }
  }
}

/**
 * Level 2 whenever DDOC holds, as the canonical page defines it: a site's
 * files match the hashes its owner published, whether IPFS content does so
 * by design or a site publishes its hash tree (`ADR-0029`). How well that
 * anchor is held, a name proven on Ethereum or a DNS record, is evidence
 * beside the level, never part of it.
 */
export function websiteLevel (content: ContentEvidence | undefined, ddoc: DdocVerdict, bundleHash: string | undefined): WebsiteLevel {
  const assessable = content !== undefined
    ? { kind: 'cid' as const, value: content.cid }
    : bundleHash !== undefined ? { kind: 'bundle-hash' as const, value: bundleHash } : undefined
  return { ...(content !== undefined ? contentLevel(content) : hostedLevel(ddoc)), assessable }
}
