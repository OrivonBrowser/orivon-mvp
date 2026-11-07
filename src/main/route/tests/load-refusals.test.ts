import { describe, expect, it } from 'vitest'
import { createLoadRefusals } from '../load-refusals.js'

describe('the loads a tab was refused, which the sheet over it explains', () => {
  it('claims the address that was refused in that tab, with its reason, once', () => {
    const refusals = createLoadRefusals()
    refusals.note(7, 'http://abc.onion/', 'onion')
    expect(refusals.claims(8, 'http://abc.onion/')).toBeUndefined()
    expect(refusals.claims(7, 'http://other.onion/')).toBeUndefined()
    expect(refusals.claims(7, 'http://abc.onion/')).toBe('onion')
    expect(refusals.claims(7, 'http://abc.onion/')).toBeUndefined()
  })

  it('keeps the reason each refusal was noted with', () => {
    const refusals = createLoadRefusals()
    refusals.note(1, 'https://a.eth/', 'would-see')
    refusals.note(2, 'https://b.eth/', 'unsure')
    refusals.note(3, 'http://c.eth/', 'plain')
    expect([refusals.claims(1, 'https://a.eth/'), refusals.claims(2, 'https://b.eth/'), refusals.claims(3, 'http://c.eth/')]).toEqual(['would-see', 'unsure', 'plain'])
  })

  it('remembers the newest refusal of a tab, and a bounded number of tabs', () => {
    const refusals = createLoadRefusals(2)
    refusals.note(1, 'http://a.onion/', 'onion')
    refusals.note(1, 'http://b.onion/', 'onion')
    expect(refusals.claims(1, 'http://a.onion/')).toBeUndefined()
    expect(refusals.claims(1, 'http://b.onion/')).toBe('onion')
    refusals.note(1, 'http://a.onion/', 'onion')
    refusals.note(2, 'http://a.onion/', 'onion')
    refusals.note(3, 'http://a.onion/', 'onion')
    expect(refusals.claims(1, 'http://a.onion/')).toBeUndefined()
    expect(refusals.claims(3, 'http://a.onion/')).toBe('onion')
  })

  it('notes nothing for a request that belongs to no tab', () => {
    const refusals = createLoadRefusals()
    refusals.note(undefined, 'http://abc.onion/', 'onion')
    expect(refusals.claims(0, 'http://abc.onion/')).toBeUndefined()
  })
})
