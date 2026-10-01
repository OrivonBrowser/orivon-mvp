import { describe, expect, it } from 'vitest'
import { CLICK_GUARD_MS, ClickGuard } from '../click-guard.js'

function clock () {
  let at = 10_000
  return { now: () => at, advance: (ms: number) => { at += ms } }
}

describe('ClickGuard', () => {
  it('ignores every action in a peek for a moment after it appears', () => {
    const time = clock()
    const guard = new ClickGuard(time.now, true)
    guard.shown()
    expect(guard.allows('keep', 'a')).toBe(false)
    expect(guard.allows('cancel', 'a')).toBe(false)
    time.advance(CLICK_GUARD_MS)
    expect(guard.allows('keep', 'a')).toBe(true)
    expect(guard.allows('cancel', 'a')).toBe(true)
  })

  it('does not delay the buttons of a bubble the person opened', () => {
    const time = clock()
    const guard = new ClickGuard(time.now, false)
    guard.shown()
    expect(guard.allows('pause', 'a')).toBe(true)
    expect(guard.allows('discard', 'a')).toBe(true)
  })

  it('makes Keep wait for its own row to settle, in a peek or a bubble, and no other action', () => {
    for (const peek of [true, false]) {
      const time = clock()
      const guard = new ClickGuard(time.now, peek)
      guard.heldNow('a')
      expect(guard.allows('keep', 'a')).toBe(false)
      expect(guard.allows('discard', 'a')).toBe(true)
      expect(guard.allows('keep', 'b')).toBe(true)
      time.advance(CLICK_GUARD_MS)
      expect(guard.allows('keep', 'a')).toBe(true)
    }
  })
})
