import { describe, expect, it } from 'vitest'
import { bootTimeMs, isPidRecordAlive } from '../pid-liveness.js'

describe('bootTimeMs', () => {
  it('is now minus uptime, rounded to the second', () => {
    expect(bootTimeMs(1_700_000_000_123, 86_400.4)).toBe(1_700_000_000_000 - 86_400_000)
  })

  it('agrees for two reads a moment apart, in the same boot', () => {
    // uptime() grows with the clock, so the difference stays put.
    expect(bootTimeMs(1_000_000, 100)).toBe(bootTimeMs(1_003_000, 103))
  })
})

describe('isPidRecordAlive', () => {
  const NOW = 1_700_000_000_000
  const UPTIME = 86_400 // 1 day, in seconds
  const BOOT = bootTimeMs(NOW, UPTIME)
  const alwaysAlive = (): boolean => true
  const alwaysGone = (): boolean => false

  it('trusts the probe alone when the marker has no boot time (written before this existed)', () => {
    expect(isPidRecordAlive({ pid: 1 }, alwaysAlive, NOW, UPTIME)).toBe(true)
    expect(isPidRecordAlive({ pid: 1 }, alwaysGone, NOW, UPTIME)).toBe(false)
  })

  it('trusts the probe when the boot time matches the current one', () => {
    expect(isPidRecordAlive({ pid: 1, bootTime: BOOT }, alwaysAlive, NOW, UPTIME)).toBe(true)
    expect(isPidRecordAlive({ pid: 1, bootTime: BOOT }, alwaysGone, NOW, UPTIME)).toBe(false)
  })

  it('tolerates a few seconds of drift between the write and the check', () => {
    expect(isPidRecordAlive({ pid: 1, bootTime: BOOT + 2000 }, alwaysAlive, NOW, UPTIME)).toBe(true)
    expect(isPidRecordAlive({ pid: 1, bootTime: BOOT - 2000 }, alwaysAlive, NOW, UPTIME)).toBe(true)
  })

  it('refuses a pid the OS could have reused since a reboot, even if the probe says alive', () => {
    // The exact failure this fixes: process.kill(pid, 0) answers for whatever
    // now holds that pid, which after a reboot is not the marker's process.
    const reused = BOOT - 3600_000 // an hour before this boot: a different boot entirely
    expect(isPidRecordAlive({ pid: 1, bootTime: reused }, alwaysAlive, NOW, UPTIME)).toBe(false)
  })

  it('never says alive on a boot-time mismatch, whatever the probe would have said', () => {
    const reused = BOOT + 3600_000
    expect(isPidRecordAlive({ pid: 1, bootTime: reused }, alwaysGone, NOW, UPTIME)).toBe(false)
  })
})
