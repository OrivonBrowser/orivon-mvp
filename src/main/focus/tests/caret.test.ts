import { describe, expect, it } from 'vitest'
import { caretAppliesTo, caretPlan } from '../caret.js'

describe('caretPlan', () => {
  it('asks before turning on while the setting says to ask', () => {
    expect(caretPlan({ on: false, ask: true })).toBe('ask')
  })

  it('turns on at once when it need not ask', () => {
    expect(caretPlan({ on: false, ask: false })).toBe('turn-on')
  })

  it('turns off without asking, whatever the ask setting is', () => {
    expect(caretPlan({ on: true, ask: true })).toBe('turn-off')
    expect(caretPlan({ on: true, ask: false })).toBe('turn-off')
  })
})

describe('caretAppliesTo', () => {
  it('leaves the new-tab page out', () => {
    expect(caretAppliesTo({ isDashboardTab: true })).toBe(false)
    expect(caretAppliesTo({ isDashboardTab: false })).toBe(true)
  })
})
