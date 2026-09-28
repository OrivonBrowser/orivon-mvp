import { describe, expect, it } from 'vitest'
import { deliveryLadder } from '../delivery-ladder.js'
import type { DeliveryHistoryInput, PinCoverageEvidence } from '../delivery-ladder.js'

// THE INVARIANT UNDER TEST, throughout: the result always carries `level`
// (the canonical Connection-trustlessity level this delivery earns) alongside
// `evidence` (the raw checkable facts) -- never a bare label with nothing
// under it. ADR-0006 exists because a trust indicator that shows a grade
// instead of evidence is worse than none.

function input (overrides: Partial<DeliveryHistoryInput> = {}): DeliveryHistoryInput {
  return {
    everPinned: false,
    pinnedAt: null,
    now: 1_700_000_000_000,
    deliveryMethod: 'fetched-each-load',
    currentFetchMatchesPin: null,
    pinHasChanged: false,
    addressIsContentAddressed: false,
    nameResolvedTrustlessly: false,
    ...overrides
  }
}

describe('deliveryLadder -- Level 1, everything short of a proven .eth name', () => {
  it('an ordinary fetched-every-load site is Level 1', () => {
    expect(deliveryLadder(input()).level).toBe(1)
  })

  it('a TOFU-pinned installed app, current fetch matching, is still Level 1 -- the pin is trusted on first use, not proven trustless', () => {
    const result = deliveryLadder(input({
      everPinned: true,
      pinnedAt: 1_699_000_000_000,
      deliveryMethod: 'served-from-pinned-cache',
      currentFetchMatchesPin: true
    }))
    expect(result.level).toBe(1)
  })

  it('content-addressed through an unproven DNSLink name is still Level 1 -- the CID itself is unproven', () => {
    const result = deliveryLadder(input({ addressIsContentAddressed: true, nameResolvedTrustlessly: false }))
    expect(result.level).toBe(1)
  })

  it('a trustlessly-resolved name alone, without content-addressing, is still Level 1', () => {
    expect(deliveryLadder(input({ nameResolvedTrustlessly: true })).level).toBe(1)
  })
})

describe('deliveryLadder -- Level 2, a proven .eth name', () => {
  it('is met only when nameResolvedTrustlessly AND addressIsContentAddressed are both true', () => {
    const result = deliveryLadder(input({ addressIsContentAddressed: true, nameResolvedTrustlessly: true }))
    expect(result.level).toBe(2)
  })
})

describe('deliveryLadder -- Level 3 is never reached automatically in this build', () => {
  it('every input this module can be given still tops out at Level 2', () => {
    const result = deliveryLadder(input({
      addressIsContentAddressed: true,
      nameResolvedTrustlessly: true,
      everPinned: true,
      pinnedAt: 1_699_000_000_000,
      deliveryMethod: 'served-from-pinned-cache',
      currentFetchMatchesPin: true
    }))
    expect(result.level).toBe(2)
  })
})

describe('deliveryLadder -- pin evidence is kept, even though it no longer decides the level', () => {
  it('reports the pin age in the evidence, computed from now - pinnedAt', () => {
    const result = deliveryLadder(input({
      everPinned: true,
      pinnedAt: 1_699_000_000_000,
      now: 1_700_000_000_000,
      deliveryMethod: 'served-from-pinned-cache',
      currentFetchMatchesPin: true
    }))
    expect(result.evidence.pinAgeMs).toBe(1_000_000_000)
  })

  it('pinAgeMs is null when never pinned', () => {
    expect(deliveryLadder(input()).evidence.pinAgeMs).toBeNull()
  })

  it('pinHasChanged is carried through into evidence as a plain fact, never judged', () => {
    const result = deliveryLadder(input({
      everPinned: true,
      pinnedAt: 1_699_000_000_000,
      deliveryMethod: 'served-from-pinned-cache',
      currentFetchMatchesPin: true,
      pinHasChanged: true
    }))
    expect(result.evidence.pinHasChanged).toBe(true)
  })

  it('a pin that no longer matches the current fetch is flagged as a mismatch', () => {
    const result = deliveryLadder(input({
      everPinned: true,
      pinnedAt: 1_699_000_000_000,
      deliveryMethod: 'served-from-pinned-cache',
      currentFetchMatchesPin: false
    }))
    expect(result.evidence.pinMismatch).toBe(true)
  })

  it('pinMismatch is false when there is no pin to mismatch against', () => {
    expect(deliveryLadder(input()).evidence.pinMismatch).toBe(false)
  })
})

describe('deliveryLadder -- pinCoverage is passed through, never scored', () => {
  it('is undefined in evidence when the caller has none to report', () => {
    expect(deliveryLadder(input()).evidence.pinCoverage).toBeUndefined()
  })

  it('flows straight from input to evidence, unchanged', () => {
    const pinCoverage: PinCoverageEvidence = {
      pinnedRequests: 2, thirdPartyRequests: 1, deniedRequests: 0, pinnedBytes: 500, thirdPartyBytes: 50_000, bytesIncomplete: false
    }
    const result = deliveryLadder(input({ pinCoverage }))
    expect(result.evidence.pinCoverage).toEqual(pinCoverage)
  })

  it('does not change the level -- a thin, mostly-remote app is graded the same as a fully-shipped one', () => {
    const thin: PinCoverageEvidence = {
      pinnedRequests: 1, thirdPartyRequests: 1, deniedRequests: 0, pinnedBytes: 200, thirdPartyBytes: 50_000, bytesIncomplete: false
    }
    const whole: PinCoverageEvidence = {
      pinnedRequests: 2, thirdPartyRequests: 0, deniedRequests: 0, pinnedBytes: 50_200, thirdPartyBytes: 0, bytesIncomplete: false
    }
    const base = { everPinned: true, pinnedAt: 1_699_000_000_000, deliveryMethod: 'served-from-pinned-cache' as const, currentFetchMatchesPin: true }

    const thinResult = deliveryLadder(input({ ...base, pinCoverage: thin }))
    const wholeResult = deliveryLadder(input({ ...base, pinCoverage: whole }))

    expect(thinResult.level).toBe(wholeResult.level)
  })
})

describe('deliveryLadder -- evidence is always traceable, never a bare label', () => {
  it('evidence carries every input fact the level was computed from', () => {
    const src = input({
      everPinned: true,
      pinnedAt: 1_699_000_000_000,
      deliveryMethod: 'served-from-pinned-cache',
      currentFetchMatchesPin: true,
      pinHasChanged: true,
      addressIsContentAddressed: false
    })
    const result = deliveryLadder(src)
    expect(result.evidence).toMatchObject({
      pinned: true,
      pinHasChanged: true,
      currentFetchMatchesPin: true,
      deliveryMethod: 'served-from-pinned-cache',
      addressIsContentAddressed: false
    })
  })
})
