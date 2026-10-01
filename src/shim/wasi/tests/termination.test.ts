// How a program stops, and how a failed orivon.fs call reaches it.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Errno } from '../errno.js'
import { WasiTerminated } from '../termination.js'
import { createHostHarness, type HostHarness } from './support/host-harness.js'

const STAT = 600
const PATH = 0

let h: HostHarness | undefined

afterEach(async () => {
  await h?.cleanup()
  h = undefined
  vi.restoreAllMocks()
})

async function harness (): Promise<HostHarness> {
  h = await createHostHarness()
  return h
}

function orivonError (code: string, platformCode?: string): Error {
  return Object.assign(new Error(code), { name: 'OrivonError', code, ...(platformCode === undefined ? {} : { platformCode }) })
}

async function statFile (hh: HostHarness): Promise<number> {
  return await hh.call('path_filestat_get', 3, 0, PATH, hh.put(PATH, 'f'), STAT)
}

describe('kill()', () => {
  it('stops the program at its next import, whether that import suspends or not', async () => {
    const hh = await harness()
    hh.host.kill()
    await expect(statFile(hh)).rejects.toEqual(new WasiTerminated('killed'))
    await expect(hh.call('clock_time_get', 0, 0n, STAT)).rejects.toEqual(new WasiTerminated('killed'))
  })

  it('stops a program suspended in an orivon.fs call before it sees the result', async () => {
    const hh = await harness()
    let release: () => void = () => {}
    vi.spyOn(hh.disk.orivon.fs, 'stat').mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { size: 0, isFile: true, isDirectory: false, mtimeMs: 0 }
    })
    const pending = statFile(hh)
    await new Promise((resolve) => setTimeout(resolve, 5))
    hh.host.kill()
    release()
    await expect(pending).rejects.toEqual(new WasiTerminated('killed'))
  })
})

describe('a file opened just as the program is killed', () => {
  it('is closed when its open resolves, rather than leaked out of the descriptor table', async () => {
    const hh = await harness()
    let release: () => void = () => {}
    let entered: () => void = () => {}
    const openEntered = new Promise<void>((resolve) => { entered = resolve })
    let closed = false
    const handle = { id: 'late', closed: new Promise<void>(() => {}), close: async () => { closed = true } }
    vi.spyOn(hh.disk.orivon.fs, 'open').mockImplementation(async () => {
      entered()
      await new Promise<void>((resolve) => { release = resolve })
      return handle as unknown as Awaited<ReturnType<typeof hh.disk.orivon.fs.open>>
    })
    const pending = hh.call('path_open', 3, 0, PATH, hh.put(PATH, 'new.txt'), 1, (1n << 1n) | (1n << 6n), 0n, 0, STAT)
    await openEntered
    hh.host.kill()
    await expect(pending).rejects.toEqual(new WasiTerminated('killed'))
    release()
    await vi.waitFor(() => { expect(closed).toBe(true) })
  })
})

describe('failed orivon.fs calls', () => {
  it('a revoked grant terminates the program rather than returning an errno it would retry', async () => {
    const hh = await harness()
    vi.spyOn(hh.disk.orivon.fs, 'stat').mockRejectedValue(orivonError('revoked'))
    await expect(statFile(hh)).rejects.toEqual(new WasiTerminated('revoked'))
    await expect(hh.call('clock_time_get', 0, 0n, STAT)).rejects.toEqual(new WasiTerminated('revoked'))
  })

  it('retries a transient limit, and reports NOSPC once the retries are spent', async () => {
    const hh = await harness()
    const stat = vi.spyOn(hh.disk.orivon.fs, 'stat')
      .mockRejectedValueOnce(orivonError('limit'))
      .mockRejectedValueOnce(orivonError('limit'))
      .mockResolvedValueOnce({ size: 1, isFile: true, isDirectory: false, mtimeMs: 0 })
    expect(await statFile(hh)).toBe(Errno.SUCCESS)
    expect(stat).toHaveBeenCalledTimes(3)
    stat.mockReset().mockRejectedValue(orivonError('limit'))
    vi.useFakeTimers()
    try {
      const spent = statFile(hh)
      await vi.advanceTimersByTimeAsync(6000)
      expect(await spent).toBe(Errno.NOSPC)
    } finally {
      vi.useRealTimers()
    }
    // The first call and one retry after each of the ten delays.
    expect(stat).toHaveBeenCalledTimes(11)
  })

  it('does not retry a full disk, which comes with its own errno', async () => {
    const hh = await harness()
    const stat = vi.spyOn(hh.disk.orivon.fs, 'stat').mockRejectedValue(orivonError('limit', 'ENOSPC'))
    expect(await statFile(hh)).toBe(Errno.NOSPC)
    expect(stat).toHaveBeenCalledTimes(1)
  })

  it('lets a bug in the host trap loudly instead of reaching the program as a plausible EIO', async () => {
    const hh = await harness()
    vi.spyOn(hh.disk.orivon.fs, 'stat').mockRejectedValue(new TypeError('undefined is not a function'))
    await expect(statFile(hh)).rejects.toThrow(TypeError)
  })
})

describe('bad guest input', () => {
  it('a pointer past the end of memory is FAULT, and a path that is not UTF-8 is ILSEQ', async () => {
    const hh = await harness()
    expect(await hh.call('path_filestat_get', 3, 0, 200_000, 4, STAT)).toBe(Errno.FAULT)
    new Uint8Array(hh.memory.buffer, PATH, 2).set([0xff, 0xfe])
    expect(await hh.call('path_filestat_get', 3, 0, PATH, 2, STAT)).toBe(Errno.ILSEQ)
  })
})
