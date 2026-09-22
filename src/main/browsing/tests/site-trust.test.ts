import { describe, expect, it } from 'vitest'
import { buildSiteTrust } from '../site-trust.js'
import type { PinRecord } from '../../../broker/policy/pin.js'

// The site-info popover's Web3 Score page. Pure -- no `electron`, no
// `loader`/`electron-serve` import -- the caller (site-info-ipc.js)
// supplies exactly what it already read (Loader.pinFor, the loader's
// isOriginServedFromCacheSync, pinCoverageFor), the same split
// deliveryLadder itself already follows (src/trust/README.md: never
// reach into another stream's internals).

const ORIGIN = 'https://app.example'

function pin (overrides: Partial<PinRecord> = {}): PinRecord {
  return { schema: 1, origin: ORIGIN, bundleHash: 'a'.repeat(64), assets: [], version: '1.0.0', pinnedAt: 1_000, ...overrides }
}

describe('buildSiteTrust -- connection', () => {
  it('cached wins over the scheme -- an app served from its pinned cache, even over https, reads as cached', () => {
    const trust = buildSiteTrust(ORIGIN, pin(), true, undefined, 2_000)
    expect(trust.connection).toBe('cached')
  })

  it('secure for an https origin not served from cache', () => {
    const trust = buildSiteTrust(ORIGIN, null, false, undefined, 2_000)
    expect(trust.connection).toBe('secure')
  })

  it('insecure for a plain http origin not served from cache', () => {
    const trust = buildSiteTrust('http://app.example', null, false, undefined, 2_000)
    expect(trust.connection).toBe('insecure')
  })
})

describe('buildSiteTrust -- delivery evidence, never overclaiming what was not observed', () => {
  it('never pinned: D1 met, D2/D3/D4 not, no pin evidence', () => {
    const trust = buildSiteTrust(ORIGIN, null, false, undefined, 2_000)

    expect(trust.delivery.rungs).toEqual([
      { rung: 'D1', met: true },
      { rung: 'D2', met: false },
      { rung: 'D3', met: false },
      { rung: 'D4', met: false }
    ])
    expect(trust.pin).toBeUndefined()
  })

  it('pinned and served from cache: D2 met, D3/D4 not (no content-addressing or trustless resolution exists yet)', () => {
    const trust = buildSiteTrust(ORIGIN, pin({ pinnedAt: 1_000 }), true, undefined, 2_000)

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
    const trust = buildSiteTrust(ORIGIN, pin(), true, undefined, 2_000)
    expect(trust.delivery.evidence.currentFetchMatchesPin).toBeNull()
  })

  it('exposes the pinned bundle hash, version and pin date for display', () => {
    const trust = buildSiteTrust(ORIGIN, pin({ bundleHash: 'b'.repeat(64), version: '2.0.0', pinnedAt: 500 }), true, undefined, 2_000)
    expect(trust.pin).toEqual({ bundleHash: 'b'.repeat(64), version: '2.0.0', pinnedAt: 500 })
  })

  it('carries pin coverage through unchanged when supplied', () => {
    const coverage = { pinnedRequests: 4, thirdPartyRequests: 1, deniedRequests: 0, pinnedBytes: 900, thirdPartyBytes: 100, bytesIncomplete: false }
    const trust = buildSiteTrust(ORIGIN, pin(), true, coverage, 2_000)
    expect(trust.delivery.evidence.pinCoverage).toEqual(coverage)
  })

  it('no address-addressing or trustless resolution today -- D3/D4 never met, regardless of pin state', () => {
    const trust = buildSiteTrust(ORIGIN, pin(), true, undefined, 2_000)
    expect(trust.delivery.rungs.find((r) => r.rung === 'D3')?.met).toBe(false)
    expect(trust.delivery.rungs.find((r) => r.rung === 'D4')?.met).toBe(false)
  })
})
