import { describe, expect, it } from 'vitest'
import { createNagLimit, NAG_SUSPENDED_MS, NAG_WINDOW_MS } from '../permission-nag-limit.js'

describe('createNagLimit', () => {
  it('suspends an extension after three denials inside a minute, for ten minutes', () => {
    let now = 0
    const limit = createNagLimit(() => now)
    limit.denied('a'); limit.denied('a')
    expect(limit.suspended('a')).toBe(false)
    limit.denied('a')
    expect(limit.suspended('a')).toBe(true)
    expect(limit.suspended('b')).toBe(false)
    now = NAG_SUSPENDED_MS - 1
    expect(limit.suspended('a')).toBe(true)
    now = NAG_SUSPENDED_MS
    expect(limit.suspended('a')).toBe(false)
  })

  it('does not count denials further apart than the window', () => {
    let now = 0
    const limit = createNagLimit(() => now)
    for (let i = 0; i < 5; i++) { limit.denied('a'); now += NAG_WINDOW_MS }
    expect(limit.suspended('a')).toBe(false)
  })

  it('forgets the denials once the person allows', () => {
    const limit = createNagLimit(() => 0)
    limit.denied('a'); limit.denied('a'); limit.allowed('a'); limit.denied('a')
    expect(limit.suspended('a')).toBe(false)
  })
})
