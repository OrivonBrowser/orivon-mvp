import { describe, expect, it } from 'vitest'
import { buildSiteTrust } from '../site-trust.js'
import type { PinRecord } from '../../../broker/policy/pin.js'
import type { NameEvidence } from '../../verifier/name-evidence.js'

// The site-info popover's Web3 Score page. Pure -- no `electron`, no
// `loader`/`electron-serve` import -- the caller (site-info-ipc.js)
// supplies exactly what it already read (Loader.pinFor, Loader.ddocFor, the
// loader's isOriginServedFromCacheSync, pinCoverageFor), the same split
// deliveryLadder itself already follows (src/trust/README.md: never
// reach into another stream's internals).

const ORIGIN = 'https://app.example'

function pin (overrides: Partial<PinRecord> = {}): PinRecord {
  return { schema: 1, origin: ORIGIN, bundleHash: 'a'.repeat(64), assets: [], version: '1.0.0', pinnedAt: 1_000, ...overrides }
}

describe('buildSiteTrust -- connection', () => {
  it('cached wins over the scheme -- an app served from its pinned cache, even over https, reads as cached', () => {
    const trust = buildSiteTrust(ORIGIN, pin(), true, undefined, undefined, 2_000)
    expect(trust.connection).toBe('cached')
  })

  it('secure for an https origin not served from cache', () => {
    const trust = buildSiteTrust(ORIGIN, null, false, undefined, undefined, 2_000)
    expect(trust.connection).toBe('secure')
  })

  it('insecure for a plain http origin not served from cache', () => {
    const trust = buildSiteTrust('http://app.example', null, false, undefined, undefined, 2_000)
    expect(trust.connection).toBe('insecure')
  })
})

describe('buildSiteTrust -- delivery evidence, never overclaiming what was not observed', () => {
  it('never pinned: D1 met, D2/D3/D4 not, no pin evidence', () => {
    const trust = buildSiteTrust(ORIGIN, null, false, undefined, undefined, 2_000)

    expect(trust.delivery.rungs).toEqual([
      { rung: 'D1', met: true },
      { rung: 'D2', met: false },
      { rung: 'D3', met: false },
      { rung: 'D4', met: false }
    ])
    expect(trust.pin).toBeUndefined()
  })

  it('pinned and served from cache: D2 met, D3/D4 not (an ordinary origin is not content-addressed)', () => {
    const trust = buildSiteTrust(ORIGIN, pin({ pinnedAt: 1_000 }), true, undefined, undefined, 2_000)

    expect(trust.delivery.rungs).toEqual([
      { rung: 'D1', met: false },
      { rung: 'D2', met: true },
      { rung: 'D3', met: false },
      { rung: 'D4', met: false }
    ])
    expect(trust.delivery.evidence.pinAgeMs).toBe(1_000)
  })

  // The load-bearing case: this popover never re-fetches to compare
  // hashes, so there is no live "does this match the pin" observation to
  // report -- `currentFetchMatchesPin` must be null (unmeasured), never a
  // claimed match, which would overclaim exactly what ADR-0006 forbids.
  it('never claims the current fetch matches the pin -- there is no live fetch to compare', () => {
    const trust = buildSiteTrust(ORIGIN, pin(), true, undefined, undefined, 2_000)
    expect(trust.delivery.evidence.currentFetchMatchesPin).toBeNull()
  })

  it('exposes the pinned bundle hash, version and pin date for display', () => {
    const trust = buildSiteTrust(ORIGIN, pin({ bundleHash: 'b'.repeat(64), version: '2.0.0', pinnedAt: 500 }), true, undefined, undefined, 2_000)
    expect(trust.pin).toEqual({ bundleHash: 'b'.repeat(64), version: '2.0.0', pinnedAt: 500 })
  })

  it('carries pin coverage through unchanged when supplied', () => {
    const coverage = { pinnedRequests: 4, thirdPartyRequests: 1, deniedRequests: 0, pinnedBytes: 900, thirdPartyBytes: 100, bytesIncomplete: false }
    const trust = buildSiteTrust(ORIGIN, pin(), true, coverage, undefined, 2_000)
    expect(trust.delivery.evidence.pinCoverage).toEqual(coverage)
  })

  it('an ordinary origin never meets D3/D4, regardless of pin state', () => {
    const trust = buildSiteTrust(ORIGIN, pin(), true, undefined, undefined, 2_000)
    expect(trust.delivery.rungs.find((r) => r.rung === 'D3')?.met).toBe(false)
    expect(trust.delivery.rungs.find((r) => r.rung === 'D4')?.met).toBe(false)
  })
})

describe('buildSiteTrust -- DDOC', () => {
  const tree = { bundleHash: 'sha256:' + 'c'.repeat(64), assets: [{ path: '/.well-known/orivon.json', leaf: 'sha256:' + 'd'.repeat(64) }] }

  it('not checked for a site with no pin -- nothing was installed to compare', () => {
    expect(buildSiteTrust(ORIGIN, null, false, undefined, { bundleHash: tree.bundleHash, leaves: tree.assets }, 2_000).ddoc).toEqual({ status: 'not-checked' })
  })

  it('verified when the published tree is the pinned one', () => {
    const trust = buildSiteTrust(ORIGIN, pin(tree), true, undefined, { bundleHash: tree.bundleHash, leaves: tree.assets }, 2_000)
    expect(trust.ddoc).toEqual({ status: 'verified' })
  })

  it('not published when the site published nothing', () => {
    expect(buildSiteTrust(ORIGIN, pin(tree), true, undefined, undefined, 2_000).ddoc).toEqual({ status: 'not-published' })
  })
})

describe('buildSiteTrust -- the Website level and a .eth name', () => {
  const CID = 'bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi'
  const proven: NameEvidence = { content: { source: 'live', cid: CID, pointersVerified: true }, nameProven: true, line: 'Name verified', rows: [{ term: 'Name', value: 'Proven' }] }

  it('an ordinary site is Level 1, and names its bundle hash only when pinned', () => {
    expect(buildSiteTrust(ORIGIN, null, false, undefined, undefined, 2_000).level).toMatchObject({ level: 1, assessable: undefined })
    expect(buildSiteTrust(ORIGIN, pin(), true, undefined, undefined, 2_000).level).toMatchObject({ level: 1, assessable: { kind: 'bundle-hash', value: 'a'.repeat(64) } })
    expect(buildSiteTrust(ORIGIN, null, false, undefined, undefined, 2_000).name).toBeUndefined()
  })

  it('an installed site whose files match the hash tree it publishes is Level 2: it supports DDOC', () => {
    const tree = { bundleHash: 'sha256:' + 'c'.repeat(64), assets: [{ path: '/.well-known/orivon.json', leaf: 'sha256:' + 'd'.repeat(64) }] }
    const trust = buildSiteTrust(ORIGIN, pin(tree), true, undefined, { bundleHash: tree.bundleHash, leaves: tree.assets }, 2_000)
    expect(trust.level).toMatchObject({ level: 2, assessable: { kind: 'bundle-hash', value: tree.bundleHash } })
    expect(trust.delivery.rungs.filter((r) => r.met).map((r) => r.rung)).toEqual(['D2'])
  })

  it('a verified .eth page is Level 2, meets D3 and D4, and carries its name rows', () => {
    const trust = buildSiteTrust('https://site.eth', null, false, undefined, undefined, 2_000, proven)
    expect(trust.level).toMatchObject({ level: 2, assessable: { kind: 'cid', value: CID } })
    expect(trust.delivery.rungs.filter((r) => r.met).map((r) => r.rung)).toEqual(['D1', 'D3', 'D4'])
    expect(trust.name).toEqual({ line: 'Name verified', rows: [{ term: 'Name', value: 'Proven' }] })
  })

  it('a .eth name through DNSLink meets DDOC but is not trustlessly named: Level 2, D3 without D4', () => {
    const viaDns: NameEvidence = { ...proven, content: { source: 'live', cid: CID, pointersVerified: false }, nameProven: false }
    const trust = buildSiteTrust('https://site.eth', null, false, undefined, undefined, 2_000, viaDns)
    expect(trust.level.level).toBe(2)
    expect(trust.delivery.rungs.filter((r) => r.met).map((r) => r.rung)).toEqual(['D1', 'D3'])
  })

  it('a .eth name the verifier could not answer for claims nothing beyond D1', () => {
    const unknown: NameEvidence = { content: undefined, nameProven: false, line: 'Name not verified.', rows: [] }
    const trust = buildSiteTrust('https://site.eth', null, false, undefined, undefined, 2_000, unknown)
    expect(trust.level.level).toBe(1)
    expect(trust.delivery.rungs.filter((r) => r.met).map((r) => r.rung)).toEqual(['D1'])
  })
})
