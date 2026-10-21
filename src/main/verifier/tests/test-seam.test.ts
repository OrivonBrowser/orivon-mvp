import { describe, expect, it } from 'vitest'
import { parseBackgroundPinDelayMs, parseEthTestSeam, parseUpdateWatchMs } from '../test-seam.js'

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

describe('parseEthTestSeam -- a fixture IPFS node', () => {
  const fixtures = { ORIVON_TEST_ETH_FIXTURES: '{}' }

  it('reads the endpoint a suite serves as the IPFS node, and how long a block it could not give waits to be asked again', () => {
    const seam = parseEthTestSeam({ ...fixtures, ORIVON_TEST_IPFS_NODE: 'http://127.0.0.1:9999', ORIVON_TEST_IPFS_NODE_RETRY_WAIT_MS: '1500' })
    expect(seam?.ipfsNode).toEqual({ endpoint: 'http://127.0.0.1:9999', retryWaitMs: 1500 })
  })

  it('has no node unless a suite names one, and the ordinary wait unless it names a valid one', () => {
    expect(parseEthTestSeam(fixtures)?.ipfsNode).toBeUndefined()
    expect(parseEthTestSeam({ ...fixtures, ORIVON_TEST_IPFS_NODE: 'http://127.0.0.1:9999' })?.ipfsNode).toEqual({ endpoint: 'http://127.0.0.1:9999' })
    expect(parseEthTestSeam({ ...fixtures, ORIVON_TEST_IPFS_NODE: 'http://127.0.0.1:9999', ORIVON_TEST_IPFS_NODE_RETRY_WAIT_MS: 'soon' })?.ipfsNode).toEqual({ endpoint: 'http://127.0.0.1:9999' })
  })
})
