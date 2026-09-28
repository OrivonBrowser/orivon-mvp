// The protocol part of the site-info popover: how a `.eth` name or an
// `ipfs://` address led to its content, in words, and the content evidence
// the Website level is judged from. For a page served live by the verifier,
// or an app installed from IPFS and served from its pin.

import type { ContentAddress } from '../../broker/policy/pin.js'
import { pointerChainVerdict } from '../../protocols/resolution/pointer-chain.js'
import type { ContentPointer, PointerStep, Provenance } from '../../protocols/resolution/records.js'
import type { ContentEvidence } from '../../trust/website-level.js'
import type { SiteProvenance } from '../../protocols/verifier-host/protocol.js'
import { ago } from './status-view.js'

export interface EvidenceRow {
  readonly term: string
  readonly value: string
}

export interface NameEvidence {
  /** Undefined when nothing says what content this name points to. */
  readonly content: ContentEvidence | undefined
  /** Whether every hop from the name to the content was verified: the Delivery level's D2, when the content is also content-addressed. */
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
    case 'address': return 'Read from the address itself'
  }
}

/** What an `ipfs://` or `ipns://` address itself establishes: only a CID names the content outright. */
function addressLine (pointer: ContentPointer): string {
  switch (pointer.kind) {
    case 'ipfs': return "The address is the content's own hash"
    case 'ipns-key': return 'The address is a key; the content is whatever its signed record names'
    case 'dnslink': return 'The address is a DNS name, followed through DNSLink'
    case 'unsupported': return `The address names ${pointer.protocol} content, which this build cannot load`
  }
}

function stepRow (step: PointerStep): EvidenceRow {
  switch (step.step) {
    case 'contenthash': return step.provenance.via === 'address' ? { term: 'Address', value: addressLine(step.pointer) } : { term: 'Name', value: provenLine(step.provenance) }
    case 'ipns-record': return { term: 'IPNS record', value: `Signed by its key ${shortId(step.key)}, sequence ${step.sequence.toString()}` }
    case 'dnslink': return { term: 'DNSLink', value: `Via DNS: ${step.domain}, which anyone on the network path could forge` }
  }
}

function contentOf (provenance: SiteProvenance, pointersVerified: boolean): ContentEvidence {
  const evidence = { source: 'live' as const, cid: provenance.root.cid, pointersVerified }
  return provenance.ddoc.status === 'failed' ? { ...evidence, failedResource: provenance.ddoc.resource } : evidence
}

function liveLine (provenance: SiteProvenance, now: number): string {
  const named = provenance.pointers[0]
  const viaDns = provenance.pointers.find((step) => step.step === 'dnslink')
  const term = named?.step === 'contenthash' && named.provenance.via === 'address' ? 'Address' : 'Name'
  if (viaDns !== undefined) return `${term} not verified: it points through DNS (${viaDns.domain})`
  if (named?.step === 'contenthash' && named.provenance.via === 'address') {
    const how = named.pointer.kind === 'ipns-key' ? 'names a key whose signed record was checked' : "is the content's own hash"
    return `Address verified: it ${how}, ${ago(now - provenance.mountedAt)}`
  }
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
  const nameProven = pointerChainVerdict(provenance.pointers).verified
  return {
    content: contentOf(provenance, nameProven),
    nameProven,
    line: liveLine(provenance, now),
    rows
  }
}

/** `address`: the origin is an address such as `ipfs://`, whose pin records no block because none was needed. */
export function pinnedNameEvidence (content: ContentAddress, address: boolean): NameEvidence {
  const term = address ? 'Address' : 'Name'
  const name = !content.pointersVerified
    ? 'Through a DNSLink, which anyone on the network path could forge'
    : address
      ? content.via === 'ipns-key' ? 'A key whose signed record named the content when installed' : "The address is the content's own hash"
      : content.block === undefined ? 'A test fixture when installed, not proven' : `Proven at block ${blockNumber(content.block)} when installed`
  return {
    content: { source: 'pinned', cid: content.cid, pointersVerified: content.pointersVerified },
    nameProven: content.pointersVerified,
    line: `Installed from the content its ${term.toLowerCase()} pointed to. ${name}`,
    rows: [{ term: 'Installed from', value: shortId(content.cid) }, { term, value: name }]
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
  now: number,
  address: boolean
): NameEvidence {
  if (pinned !== undefined && (servedFromCache || live === null)) return pinnedNameEvidence(pinned, address)
  if (live !== null) return liveNameEvidence(live, now)
  const term = address ? 'Address' : 'Name'
  return { content: undefined, nameProven: false, line: `${term} not verified. ${unanswered}`, rows: [{ term, value: `Not verified. ${unanswered}` }] }
}
