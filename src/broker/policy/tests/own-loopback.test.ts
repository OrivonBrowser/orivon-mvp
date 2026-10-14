import { describe, expect, it } from 'vitest'
import { reachesOwnLoopbackPort } from '../own-loopback.js'

const own = (port: number): boolean => port === 23456

describe('reachesOwnLoopbackPort', () => {
  it('is true for every spelling of this machine on a held port', () => {
    for (const host of ['localhost', 'LOCALHOST.', '127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', '0.0.0.0', '::']) {
      expect(reachesOwnLoopbackPort([host], 23456, own), host).toBe(true)
    }
  })
  it('is false for another port, another machine, or no provider', () => {
    expect(reachesOwnLoopbackPort(['127.0.0.1'], 23457, own)).toBe(false)
    expect(reachesOwnLoopbackPort(['93.184.216.34', '192.168.1.5'], 23456, own)).toBe(false)
    expect(reachesOwnLoopbackPort(['127.0.0.1'], 23456, undefined)).toBe(false)
  })
  it('is true when any one of several addresses is this machine', () => {
    expect(reachesOwnLoopbackPort(['93.184.216.34', '127.0.0.1'], 23456, own)).toBe(true)
  })
})
