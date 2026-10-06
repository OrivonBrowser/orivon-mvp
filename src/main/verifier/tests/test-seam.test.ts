import { describe, expect, it } from 'vitest'
import { parseUpdateWatchMs } from '../test-seam.js'

describe('parseUpdateWatchMs', () => {
  it('reads the interval a suite asked for', () => {
    expect(parseUpdateWatchMs({ ORIVON_TEST_UPDATE_WATCH_MS: '5000' })).toBe(5000)
  })

  it('is undefined when unset, malformed or too short to be a real interval', () => {
    expect(parseUpdateWatchMs({})).toBeUndefined()
    expect(parseUpdateWatchMs({ ORIVON_TEST_UPDATE_WATCH_MS: 'soon' })).toBeUndefined()
    expect(parseUpdateWatchMs({ ORIVON_TEST_UPDATE_WATCH_MS: '10' })).toBeUndefined()
  })
})
