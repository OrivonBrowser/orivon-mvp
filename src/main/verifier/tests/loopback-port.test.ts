import { describe, expect, it } from 'vitest'
import { choosePort, loopbackPort, QUIET_PORTS } from '../loopback-port.js'

describe('choosing the verifier port', () => {
  it('picks below every system\'s range for outgoing connections, where no connection is handed it before the host binds', () => {
    const port = loopbackPort()
    expect(port).toBeGreaterThanOrEqual(QUIET_PORTS.first)
    expect(port).toBeLessThan(32_768)
  })

  it('tries another port when one is taken', () => {
    const picks = [0, 0.5]
    const tried: number[] = []
    const port = choosePort(() => picks.shift() ?? 0.9, (candidate) => { tried.push(candidate); return tried.length === 2 }, () => 1)
    expect(tried).toEqual([QUIET_PORTS.first, QUIET_PORTS.first + Math.floor(0.5 * (QUIET_PORTS.last - QUIET_PORTS.first + 1))])
    expect(port).toBe(tried[1])
  })

  it('stays inside the range at both ends of the random draw', () => {
    const seen: number[] = []
    choosePort(() => 0, (candidate) => { seen.push(candidate); return true }, () => 1)
    choosePort(() => 0.999999, (candidate) => { seen.push(candidate); return true }, () => 1)
    expect(seen).toEqual([QUIET_PORTS.first, QUIET_PORTS.last])
  })

  it('falls back to any free port when every try is taken', () => {
    let tries = 0
    expect(choosePort(Math.random, () => { tries++; return false }, () => 54_321)).toBe(54_321)
    expect(tries).toBe(64)
  })
})
