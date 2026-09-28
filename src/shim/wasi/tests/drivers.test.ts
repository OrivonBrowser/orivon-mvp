// The two drivers an import function runs under: which imports suspend, and
// what the synchronous driver a native addon gets answers.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Errno } from '../errno.js'
import { createHostHarness, type HostHarness } from './support/host-harness.js'

const ROOT_FD = 3
const READ = 1n << 1n
const PATH = 0
const FD_OUT = 512
const IOV = 520
const NUM = 536
const STAT = 600
const BUF = 1024

type SyncCall = (...args: Array<number | bigint>) => number

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

function syncOf (hh: HostHarness): Record<string, SyncCall> {
  return hh.host.syncFunctions as unknown as Record<string, SyncCall>
}

function orivonError (code: string): Error {
  return Object.assign(new Error(code), { name: 'OrivonError', code })
}

describe('which imports suspend', () => {
  it('only those that may wait: fd_renumber closes without waiting, so a reactor JavaScript calls directly can dup2', async () => {
    const hh = await harness()
    expect(hh.host.suspending.has('fd_renumber')).toBe(false)
    expect(hh.host.suspending.has('clock_time_get')).toBe(false)
    expect(hh.host.suspending.has('fd_read')).toBe(true)
  })
})

describe('the synchronous imports a native addon gets', () => {
  it('write stdout to the synchronous sink, answer BADF for an unknown descriptor, and refuse a file call by name without a synchronous fs', async () => {
    const written: string[] = []
    const hh = await harness({ syncStdout: (bytes) => { written.push(new TextDecoder().decode(bytes)) } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sync = syncOf(hh)
    hh.iovec(IOV, BUF, hh.put(BUF, 'from an addon'))
    expect(sync.fd_write?.(1, IOV, 1, NUM)).toBe(Errno.SUCCESS)
    expect(written).toEqual(['from an addon'])
    expect(hh.u32(NUM)).toBe(13)
    expect(sync.fd_write?.(99, IOV, 1, NUM)).toBe(Errno.BADF)
    expect(sync.path_open?.(ROOT_FD, 0, PATH, hh.put(PATH, 'f'), 1, READ, 0n, 0, FD_OUT)).toBe(Errno.NOSYS)
    expect(warn.mock.calls[0]?.[0]).toMatch(/cross-origin isolated/)
    expect(sync.sched_yield?.()).toBe(Errno.SUCCESS)
  })

  it('read stdin as end of input, saying so once', async () => {
    const hh = await harness()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hh.iovec(IOV, BUF, 16)
    expect(syncOf(hh).fd_read?.(0, IOV, 1, NUM)).toBe(Errno.SUCCESS)
    expect(syncOf(hh).fd_read?.(0, IOV, 1, NUM)).toBe(Errno.SUCCESS)
    expect(hh.u32(NUM)).toBe(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(/stdin/)
  })

  it('retry a bare limit, as the asynchronous driver does', async () => {
    const stat = vi.fn()
      .mockImplementationOnce(() => { throw orivonError('limit') })
      .mockImplementationOnce(() => { throw orivonError('limit') })
      .mockReturnValue({ size: 3, isFile: true, isDirectory: false, mtimeMs: 0 })
    const hh = await harness()
    const withFs = await createHostHarness({ syncFs: { ...hh.disk.syncFs, stat } })
    try {
      expect(syncOf(withFs).path_filestat_get?.(ROOT_FD, 0, PATH, withFs.put(PATH, 'f'), STAT)).toBe(Errno.SUCCESS)
      expect(stat).toHaveBeenCalledTimes(3)
    } finally {
      await withFs.cleanup()
    }
  })

  it('answer a revoked grant as that call\'s EIO and keep serving, since an addon outlives any one call', async () => {
    const hh = await harness()
    const revoked = await createHostHarness({ syncFs: { ...hh.disk.syncFs, stat: () => { throw orivonError('revoked') } } })
    try {
      const sync = syncOf(revoked)
      expect(sync.path_filestat_get?.(ROOT_FD, 0, PATH, revoked.put(PATH, 'f'), STAT)).toBe(Errno.IO)
      expect(sync.clock_time_get?.(1, 0n, STAT)).toBe(Errno.SUCCESS)
      expect(sync.path_filestat_get?.(ROOT_FD, 0, PATH, revoked.put(PATH, 'f'), STAT)).toBe(Errno.IO)
    } finally {
      await revoked.cleanup()
    }
  })
})
