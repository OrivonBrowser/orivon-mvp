// Arguments, environment, clocks, randomness, poll_oneoff, and the calls
// refused by name.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Errno } from '../errno.js'
import { WasiExit } from '../termination.js'
import { createHostHarness, type HostHarness } from './support/host-harness.js'

const COUNT = 0
const SIZE = 8
const TABLE = 64
const BUF = 1024
const OUT = 4096

let h: HostHarness | undefined

afterEach(async () => {
  await h?.cleanup()
  h = undefined
  vi.restoreAllMocks()
})

async function harness (options: Parameters<typeof createHostHarness>[0] = {}): Promise<HostHarness> {
  h = await createHostHarness(options)
  return h
}

function strings (hh: HostHarness, count: number): string[] {
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const at = hh.u32(TABLE + i * 4)
    const bytes = new Uint8Array(hh.memory.buffer, at, 256)
    out.push(new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0))))
  }
  return out
}

describe('arguments and environment', () => {
  it('lays argv out as a pointer table over NUL-terminated UTF-8 strings', async () => {
    const hh = await harness({ args: ['prog', 'two words', 'ü'] })
    expect(await hh.call('args_sizes_get', COUNT, SIZE)).toBe(Errno.SUCCESS)
    expect(hh.u32(COUNT)).toBe(3)
    expect(hh.u32(SIZE)).toBe(5 + 10 + 3)
    expect(await hh.call('args_get', TABLE, BUF)).toBe(Errno.SUCCESS)
    expect(strings(hh, 3)).toEqual(['prog', 'two words', 'ü'])
  })

  it('writes environ as KEY=VALUE, a value containing `=` intact', async () => {
    const hh = await harness({ env: { A: '1', B: 'x=y' } })
    expect(await hh.call('environ_sizes_get', COUNT, SIZE)).toBe(Errno.SUCCESS)
    expect(hh.u32(COUNT)).toBe(2)
    expect(await hh.call('environ_get', TABLE, BUF)).toBe(Errno.SUCCESS)
    expect(strings(hh, 2)).toEqual(['A=1', 'B=x=y'])
  })
})

describe('clocks and randomness', () => {
  it('reads the wall clock in nanoseconds, and a monotonic clock that does not go back', async () => {
    const hh = await harness()
    expect(await hh.call('clock_time_get', 0, 0n, OUT)).toBe(Errno.SUCCESS)
    const wallMs = Number(hh.u64(OUT) / 1_000_000n)
    expect(Math.abs(wallMs - Date.now())).toBeLessThan(1_000)
    await hh.call('clock_time_get', 1, 0n, OUT)
    const first = hh.u64(OUT)
    await hh.call('clock_time_get', 1, 0n, OUT)
    expect(hh.u64(OUT) >= first).toBe(true)
    expect(await hh.call('clock_res_get', 1, OUT)).toBe(Errno.SUCCESS)
    expect(hh.u64(OUT)).toBeGreaterThan(0n)
  })

  it('refuses the CPU-time clocks as NOTSUP and an unknown clock as INVAL', async () => {
    const hh = await harness()
    expect(await hh.call('clock_time_get', 2, 0n, OUT)).toBe(Errno.NOTSUP)
    expect(await hh.call('clock_time_get', 9, 0n, OUT)).toBe(Errno.INVAL)
  })

  it('fills a buffer larger than getRandomValues allows in one call', async () => {
    const hh = await harness()
    const length = 100_000
    expect(await hh.call('random_get', 0, length)).toBe(Errno.SUCCESS)
    const bytes = new Uint8Array(hh.memory.buffer, 0, length)
    expect(bytes.subarray(90_000).some((byte) => byte !== 0)).toBe(true)
  })
})

describe('exit and yield', () => {
  it('proc_exit unwinds with WasiExit carrying the code', async () => {
    const hh = await harness()
    await expect(hh.call('proc_exit', 3)).rejects.toEqual(new WasiExit(3))
  })

  it('sched_yield lets the event loop run and returns SUCCESS', async () => {
    const hh = await harness()
    expect(await hh.call('sched_yield')).toBe(Errno.SUCCESS)
  })
})

describe('poll_oneoff', () => {
  const SUBS = 0
  const EVENTS = 512
  const NEVENTS = 1000

  function clockSubscription (hh: HostHarness, at: number, userdata: bigint, timeoutNs: bigint): void {
    const view = new DataView(hh.memory.buffer)
    view.setBigUint64(at, userdata, true)
    view.setUint8(at + 8, 0)
    view.setUint32(at + 16, 1, true)
    view.setBigUint64(at + 24, timeoutNs, true)
    view.setUint16(at + 40, 0, true)
  }

  function fdSubscription (hh: HostHarness, at: number, userdata: bigint, fd: number): void {
    const view = new DataView(hh.memory.buffer)
    view.setBigUint64(at, userdata, true)
    view.setUint8(at + 8, 1)
    view.setUint32(at + 16, fd, true)
  }

  it('waits out a relative clock and reports its userdata', async () => {
    const hh = await harness()
    clockSubscription(hh, SUBS, 42n, 20_000_000n)
    const started = performance.now()
    expect(await hh.call('poll_oneoff', SUBS, EVENTS, 1, NEVENTS)).toBe(Errno.SUCCESS)
    expect(performance.now() - started).toBeGreaterThanOrEqual(15)
    expect(hh.u32(NEVENTS)).toBe(1)
    expect(hh.u64(EVENTS)).toBe(42n)
  })

  it('does not fire early on a wait longer than setTimeout can hold, and ends it when killed', async () => {
    vi.useFakeTimers()
    try {
      const hh = await harness()
      clockSubscription(hh, SUBS, 9n, 30n * 24n * 3_600n * 1_000_000_000n)
      let settled = false
      const pending = hh.call('poll_oneoff', SUBS, EVENTS, 1, NEVENTS).then(() => { settled = true }, () => { settled = true })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(settled).toBe(false)
      hh.host.kill()
      await pending
      expect(settled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns a ready descriptor at once rather than waiting for the clock', async () => {
    const hh = await harness()
    clockSubscription(hh, SUBS, 1n, 5_000_000_000n)
    fdSubscription(hh, SUBS + 48, 2n, 0)
    expect(await hh.call('poll_oneoff', SUBS, EVENTS, 2, NEVENTS)).toBe(Errno.SUCCESS)
    expect(hh.u32(NEVENTS)).toBe(1)
    expect(hh.u64(EVENTS)).toBe(2n)
    expect(hh.u32(EVENTS + 8) & 0xffff).toBe(Errno.SUCCESS)
  })

  it('reports BADF on the event for an unknown descriptor, and INVAL for no subscriptions', async () => {
    const hh = await harness()
    fdSubscription(hh, SUBS, 7n, 99)
    expect(await hh.call('poll_oneoff', SUBS, EVENTS, 1, NEVENTS)).toBe(Errno.SUCCESS)
    expect(hh.u32(EVENTS + 8) & 0xffff).toBe(Errno.BADF)
    expect(await hh.call('poll_oneoff', SUBS, EVENTS, 0, NEVENTS)).toBe(Errno.INVAL)
  })
})

describe('refused by name', () => {
  it('names each refused call once on the console, and answers with the errno a runtime would', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hh = await harness()
    expect(await hh.call('path_symlink', 0, 0, 3, 0, 0)).toBe(Errno.NOTSUP)
    expect(await hh.call('path_symlink', 0, 0, 3, 0, 0)).toBe(Errno.NOTSUP)
    expect(await hh.call('proc_raise', 9)).toBe(Errno.NOSYS)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/path_symlink/)
  })

  it('checks a contradictory file-times request before refusing the call itself', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hh = await harness()
    expect(await hh.call('fd_filestat_set_times', 3, 0n, 0n, 4 | 8)).toBe(Errno.INVAL)
    expect(await hh.call('fd_filestat_set_times', 3, 0n, 0n, 4)).toBe(Errno.NOTSUP)
  })

  it('treats every valid descriptor as not a socket, since none was handed over', async () => {
    const hh = await harness()
    expect(await hh.call('sock_shutdown', 1, 0)).toBe(Errno.NOTSOCK)
    expect(await hh.call('sock_shutdown', 77, 0)).toBe(Errno.BADF)
  })
})
