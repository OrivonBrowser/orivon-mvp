import { describe, expect, it } from 'vitest'
import { powerBadge, sourceOf } from '../settings/controls/power-badge.js'

describe('the power badge', () => {
  it('says "On battery now" in the ok tone only on battery', () => {
    expect(powerBadge('battery')).toEqual({ text: 'On battery now', tone: 'ok' })
    expect(powerBadge('mains')).toEqual({ text: 'Plugged in', tone: '' })
  })

  it('says it cannot tell when the page has no battery reading', () => {
    expect(powerBadge('unknown')).toEqual({ text: 'Not detected', tone: '' })
    expect(sourceOf(null)).toBe('unknown')
  })

  it('reads a charging battery as mains and a discharging one as battery', () => {
    expect(sourceOf({ charging: true })).toBe('mains')
    expect(sourceOf({ charging: false })).toBe('battery')
  })
})
