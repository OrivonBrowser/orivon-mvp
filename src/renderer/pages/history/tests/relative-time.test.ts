import { describe, expect, it } from 'vitest'
import { relativeTime } from '../relative-time.js'

const MIN = 60_000

describe('relativeTime', () => {
  it('says how long ago in the fewest words', () => {
    expect(relativeTime(0, 30_000)).toBe('Just now')
    expect(relativeTime(0, 2 * MIN)).toBe('2 min ago')
    expect(relativeTime(0, 59 * MIN)).toBe('59 min ago')
    expect(relativeTime(0, 60 * MIN)).toBe('1 h ago')
    expect(relativeTime(0, 26 * 60 * MIN)).toBe('1 d ago')
  })

  it('reads a time in the future as just now', () => {
    expect(relativeTime(10 * MIN, 0)).toBe('Just now')
  })
})
