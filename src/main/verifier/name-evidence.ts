// The `.eth` part of the site-info popover: how the name led to its
// content, in words, and the content evidence the Website level is judged
// from. For a page served live by the verifier, or an app installed from
// IPFS and served from its pin.

import type { ContentAddress } from '../../broker/policy/pin.js'
import { pointerChainVerdict } from '../../resolution/pointer-chain.js'
import type { PointerStep, Provenance } from '../../resolution/records.js'
import type { ContentEvidence } from '../../trust/website-level.js'
import type { SiteProvenance } from '../../verifier-host/protocol.js'
import { ago } from './status-view.js'

export interface EvidenceRow {
  readonly term: string
  readonly value: string
}

export interface NameEvidence {
  /** Undefined when nothing says what content this name points to. */
  readonly content: ContentEvidence | undefined
  /** Whether every hop from the name to the content was verified: the delivery ladder's D4. */
  readonly nameProven: boolean
  /** The popover's one line about the name. */
  readonly line: string
  readonly rows: readonly EvidenceRow[]
}

function shortId (id: string): string {
  return id.length > 22 ? `${id.slice(0, 12)}…${id.slice(-8)}` : id
}

function blockNumber (block: number): string {
  return block.toLocaleString('en-US')
}

function provenLine (provenance: Provenance): string {
  switch (provenance.via) {
    case 'chain': return `Proven by the light client at block ${blockNumber(provenance.block)}${provenance.offchain ? ', through an offchain resolver the contract checked' : ''}`
    case 'fixture': return 'A test fixture, not proven'
    case 'dns': return `Read from DNS (${provenance.domain}), unverified`
  }
}

function stepRow (step: PointerStep): EvidenceRow {
  switch (step.step) {
    case 'contenthash': return { term: 'Name', value: provenLine(step.provenance) }
    case 'ipns-record': return { term: 'IPNS record', value: `Signed by its key ${shortId(step.key)}, sequence ${step.sequence.toString()}` }
    case 'dnslink': return { term: 'DNSLink', value: `Via DNS: ${step.domain}, which anyone on the network path could forge` }
  }
}

function contentOf (provenance: SiteProvenance): ContentEvidence {
  const cid = provenance.root.cid
  switch (provenance.ddoc.status) {
    case 'met': return { source: 'live', cid, ddoc: 'met' }
    case 'not-met': return { source: 'live', cid, ddoc: 'not-met', reason: provenance.ddoc.reason }
    case 'failed': return { source: 'live', cid, ddoc: 'failed', reason: provenance.ddoc.resource }
  }
}

function liveLine (provenance: SiteProvenance, now: number): string {
  const viaDns = provenance.pointers.find((step) => step.step === 'dnslink')
  if (viaDns !== undefined) return `Name not verified: it points through DNS (${viaDns.domain})`
  const named = provenance.pointers[0]
  if (named?.step !== 'contenthash' || named.provenance.via !== 'chain') return 'Name from a test fixture, not verified'
  return `Name verified by the light client at block ${blockNumber(named.provenance.block)}, ${ago(now - provenance.mountedAt)}`
}

export function liveNameEvidence (provenance: SiteProvenance, now: number): NameEvidence {
  const rows = [
    ...provenance.pointers.map(stepRow),
    { term: 'Content', value: shortId(provenance.root.cid) },
    { term: 'Checked', value: ago(now - provenance.mountedAt) }
  ]
  const refused = provenance.ddoc.refusals
  if (refused.length > 0) {
    const sources = [...new Set(refused.map((r) => r.source))].join(', ')
    rows.push({ term: 'Refused', value: `${String(refused.length)} response(s) from ${sources} failed their check and were not used` })
  }
  return {
    content: contentOf(provenance),
    nameProven: pointerChainVerdict(provenance.pointers).verified,
    line: liveLine(provenance, now),
    rows
  }
}

export function pinnedNameEvidence (content: ContentAddress): NameEvidence {
  const name = !content.pointersVerified
    ? 'Through a DNSLink, which anyone on the network path could forge'
    : content.block === undefined ? 'A test fixture when installed, not proven' : `Proven at block ${blockNumber(content.block)} when installed`
  return {
    content: { source: 'pinned', cid: content.cid, pointersVerified: content.pointersVerified },
    nameProven: content.pointersVerified,
    line: `Installed from the content its name pointed to. ${name}`,
    rows: [{ term: 'Installed from', value: shortId(content.cid) }, { term: 'Name', value: name }]
  }
}

/**
 * The evidence for the bytes this tab shows: the pin's when an installed app
 * is served from it, else the verifier's current mount, else the pin's, and
 * otherwise why nothing is known (`unanswered`, the light client's state).
 */
export function chooseNameEvidence (
  pinned: ContentAddress | undefined,
  servedFromCache: boolean,
  live: SiteProvenance | null,
  unanswered: string,
  now: number
): NameEvidence {
  if (pinned !== undefined && (servedFromCache || live === null)) return pinnedNameEvidence(pinned)
  if (live !== null) return liveNameEvidence(live, now)
  return { content: undefined, nameProven: false, line: `Name not verified. ${unanswered}`, rows: [{ term: 'Name', value: `Not verified. ${unanswered}` }] }
}
