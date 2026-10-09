import { describe, expect, it } from 'vitest'
import { parseBackgroundPinDelayMs, parseUpdateWatchMs } from '../test-seam.js'

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

describe('parseBackgroundPinDelayMs', () => {
  it('reads how long a suite asked the background download to wait, zero included', () => {
    expect(parseBackgroundPinDelayMs({ ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: '20000' })).toBe(20_000)
    expect(parseBackgroundPinDelayMs({ ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: '0' })).toBe(0)
  })

  it('is undefined when unset or malformed, so the ordinary delay applies', () => {
    expect(parseBackgroundPinDelayMs({})).toBeUndefined()
    expect(parseBackgroundPinDelayMs({ ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: 'later' })).toBeUndefined()
    expect(parseBackgroundPinDelayMs({ ORIVON_TEST_BACKGROUND_PIN_DELAY_MS: '-5' })).toBeUndefined()
  })
})
