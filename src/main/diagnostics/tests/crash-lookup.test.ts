import { describe, expect, it } from 'vitest'
import { markEndedOnPurpose, takeEndedOnPurpose } from '../crash-lookup.js'

describe('a page ended on purpose', () => {
  it('is reported once as ended, and not for a page that was never marked', () => {
    markEndedOnPurpose(41)
    expect(takeEndedOnPurpose(40)).toBe(false)
    expect(takeEndedOnPurpose(41)).toBe(true)
    expect(takeEndedOnPurpose(41)).toBe(false)
  })
})
