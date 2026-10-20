import { describe, expect, it, vi } from 'vitest'
import type { IntroPlan } from '../../shell/intro-state.js'
import { AfterWelcome } from '../after-welcome.js'

const plan = (welcome: boolean, onEntered = vi.fn(async () => {})): IntroPlan => ({ welcome, offerTelemetry: false, changes: [], chooseTelemetry: async () => {}, onEntered })

describe('AfterWelcome', () => {
  it('holds work until the click that leaves the screen, after the screen has remembered it', async () => {
    const order: string[] = []
    const after = new AfterWelcome()
    const intro = after.wrap(plan(true, vi.fn(async () => { order.push('remembered') })))
    after.whenEnded(() => { order.push('opened') })
    after.windowOpened(intro)
    expect(order).toEqual([])
    await intro?.onEntered()
    expect(order).toEqual(['remembered', 'opened'])
  })

  it('runs work at once when the launch has no welcome screen, or asks only the telemetry question', () => {
    for (const intro of [undefined, plan(false)]) {
      const after = new AfterWelcome()
      const work = vi.fn()
      after.whenEnded(work)
      after.windowOpened(after.wrap(intro))
      expect(work).toHaveBeenCalledTimes(1)
    }
  })

  it('runs work added after the screen closed at once, and each piece once', async () => {
    const after = new AfterWelcome()
    const intro = after.wrap(plan(true))
    await intro?.onEntered()
    const work = vi.fn()
    after.whenEnded(work)
    await intro?.onEntered()
    expect(work).toHaveBeenCalledTimes(1)
  })

  it('keeps going when one piece of work throws', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = new AfterWelcome()
    const intro = after.wrap(plan(true))
    const second = vi.fn()
    after.whenEnded(() => { throw new Error('x') })
    after.whenEnded(second)
    await intro?.onEntered()
    expect(second).toHaveBeenCalled()
    quiet.mockRestore()
  })
})
