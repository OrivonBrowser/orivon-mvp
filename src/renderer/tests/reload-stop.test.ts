import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStopSwitch, STOP_DELAY_MS } from '../chrome/reload-stop.js'
import { countText } from '../overlay/find/count.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('the Stop switch', () => {
  it('turns to Stop only after a load has lasted the delay', () => {
    const apply = vi.fn()
    const mode = createStopSwitch(apply)

    mode.update(true)
    vi.advanceTimersByTime(STOP_DELAY_MS - 1)
    expect(apply).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(apply).toHaveBeenCalledExactlyOnceWith(true)
    expect(mode.stopping()).toBe(true)
  })

  it('never shows Stop for a load that ends inside the delay', () => {
    const apply = vi.fn()
    const mode = createStopSwitch(apply)

    mode.update(true)
    vi.advanceTimersByTime(STOP_DELAY_MS - 10)
    mode.update(false)
    vi.advanceTimersByTime(STOP_DELAY_MS * 2)

    expect(apply).not.toHaveBeenCalled()
    expect(mode.stopping()).toBe(false)
  })

  it('goes back to Reload at once when the load ends', () => {
    const apply = vi.fn()
    const mode = createStopSwitch(apply)
    mode.update(true)
    vi.advanceTimersByTime(STOP_DELAY_MS)

    mode.update(false)

    expect(apply).toHaveBeenLastCalledWith(false)
    expect(mode.stopping()).toBe(false)
  })

  it('keeps one wait running across the state pushes of a single load', () => {
    const apply = vi.fn()
    const mode = createStopSwitch(apply)

    mode.update(true)
    vi.advanceTimersByTime(STOP_DELAY_MS - 50)
    mode.update(true)
    vi.advanceTimersByTime(50)

    expect(apply).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('does not redraw Stop on later pushes of the same load', () => {
    const apply = vi.fn()
    const mode = createStopSwitch(apply)
    mode.update(true)
    vi.advanceTimersByTime(STOP_DELAY_MS)

    mode.update(true)
    vi.advanceTimersByTime(STOP_DELAY_MS)

    expect(apply).toHaveBeenCalledTimes(1)
  })
})

describe('countText', () => {
  it('says nothing without a query or before an answer', () => {
    expect(countText('', { active: 1, total: 3 })).toBe('')
    expect(countText('a', null)).toBe('')
  })

  it('says how far through the matches the active one is', () => {
    expect(countText('a', { active: 3, total: 17 }, 'en-US')).toBe('3 of 17')
    expect(countText('a', { active: 1, total: 1234 }, 'en-US')).toBe('1 of 1,234')
  })

  it('says No results for zero matches', () => {
    expect(countText('zzz', { active: 0, total: 0 })).toBe('No results')
  })
})
