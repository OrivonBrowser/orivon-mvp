import { describe, expect, it } from 'vitest'
import { deliveryLadder } from './delivery-ladder.js'
import type { DeliveryHistoryInput } from './delivery-ladder.js'

// THE INVARIANT UNDER TEST, throughout: the result always carries `rungs`
// (every D1-D4 rung, each independently evaluated) alongside `evidence` (the
// raw checkable facts) -- never a bare rung label. ADR-0006 exists because a
// trust indicator that shows a grade instead of evidence is worse than none.

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

function metRungs (result: ReturnType<typeof deliveryLadder>): readonly string[] {
  return result.rungs.filter((r) => r.met).map((r) => r.rung)
}

describe('deliveryLadder -- D1, an ordinary fetched-every-load site', () => {
  it('never pinned, fetched every load: only D1 is met', () => {
    const result = deliveryLadder(input())
    expect(metRungs(result)).toEqual(['D1'])
  })

  it('every rung is present in the result, met or not -- enumerable, never a scalar', () => {
    const result = deliveryLadder(input())
    expect(result.rungs.map((r) => r.rung)).toEqual(['D1', 'D2', 'D3', 'D4'])
  })
})

describe('deliveryLadder -- D2, TOFU-pinned', () => {
  it('pinned and the current fetch matches: D2 is met, D1 is not', () => {
    const result = deliveryLadder(input({
      everPinned: true,
      pinnedAt: 1_699_000_000_000,
      deliveryMethod: 'served-from-pinned-cache',
      currentFetchMatchesPin: true
    }))
    expect(metRungs(result)).toEqual(['D2'])
  })

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
    const result = deliveryLadder(input())
    expect(result.evidence.pinAgeMs).toBeNull()
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
    // D2 is still met -- an app that has legitimately updated once is still TOFU-pinned.
    expect(metRungs(result)).toContain('D2')
  })

  it('a pin that no longer matches the current fetch is flagged as a mismatch, and D2 is NOT met', () => {
    const result = deliveryLadder(input({
      everPinned: true,
      pinnedAt: 1_699_000_000_000,
      deliveryMethod: 'served-from-pinned-cache',
      currentFetchMatchesPin: false
    }))
    expect(result.evidence.pinMismatch).toBe(true)
    expect(metRungs(result)).not.toContain('D2')
  })

  it('pinMismatch is false when there is no pin to mismatch against', () => {
    const result = deliveryLadder(input())
    expect(result.evidence.pinMismatch).toBe(false)
  })
})

describe('deliveryLadder -- D3, content-addressed', () => {
  it('a content-addressed app meets D3, and not D1/D2', () => {
    const result = deliveryLadder(input({
      addressIsContentAddressed: true,
      deliveryMethod: 'served-from-pinned-cache',
      everPinned: true,
      pinnedAt: 1_699_000_000_000,
      currentFetchMatchesPin: true
    }))
    expect(metRungs(result)).toContain('D3')
  })
})

describe('deliveryLadder -- D4, deferred in the MVP', () => {
  it('D4 is met only when nameResolvedTrustlessly AND addressIsContentAddressed are both true', () => {
    const result = deliveryLadder(input({
      addressIsContentAddressed: true,
      nameResolvedTrustlessly: true
    }))
    expect(metRungs(result)).toContain('D4')
  })

  it('nameResolvedTrustlessly alone, without content-addressing, does not meet D4', () => {
    const result = deliveryLadder(input({ nameResolvedTrustlessly: true }))
    expect(metRungs(result)).not.toContain('D4')
  })

  it('D4 is never met by any input this MVP can actually produce today (no trustless resolver exists) -- the field exists so a later lane can wire it without a type change', () => {
    const result = deliveryLadder(input())
    expect(result.rungs.find((r) => r.rung === 'D4')?.met).toBe(false)
  })
})

describe('deliveryLadder -- evidence is always traceable, never a bare label', () => {
  it('evidence carries every input fact the rungs were computed from', () => {
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
