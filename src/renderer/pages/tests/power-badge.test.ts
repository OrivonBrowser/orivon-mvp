import { afterEach, describe, expect, it, vi } from 'vitest'
import { powerBadge, sourceOf } from '../settings/controls/power-badge.js'

afterEach(() => { vi.unstubAllGlobals() })

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

  it('subscribes to the battery once however often the section is drawn, and keeps the one badge', async () => {
    vi.stubGlobal('document', { createElement: () => ({ className: '', textContent: '' }) })
    const battery = { charging: true, addEventListener: vi.fn() }
    vi.stubGlobal('navigator', { getBattery: vi.fn(async () => battery) })
    vi.resetModules()
    const { renderPowerBadge } = await import('../settings/controls/power-badge.js')
    const first = renderPowerBadge()
    expect(renderPowerBadge()).toBe(first)
    expect(renderPowerBadge()).toBe(first)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(battery.addEventListener).toHaveBeenCalledTimes(1)
    expect(first.textContent).toBe('Plugged in')
  })
})
