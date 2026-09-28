// fd_readdir, the preopens, and the three stdio descriptors.

import { afterEach, describe, expect, it } from 'vitest'
import { Errno } from '../errno.js'
import { createWasiHost } from '../host.js'
import { createHostHarness, type HostHarness } from './support/host-harness.js'

const ROOT_FD = 3
const READ = 1n << 1n
const WRITE = 1n << 6n
const CREAT = 1
const DIRECTORY = 2
const PATH = 0
const FD_OUT = 512
const IOV = 520
const NUM = 536
const STAT = 600
const BUF = 1024

let h: HostHarness | undefined

afterEach(async () => {
  await h?.cleanup()
  h = undefined
})

async function harness (options: Parameters<typeof createHostHarness>[0] = {}): Promise<HostHarness> {
  h = await createHostHarness(options)
  return h
}

async function openAt (hh: HostHarness, dirFd: number, path: string, oflags: number, rights: bigint): Promise<{ errno: number, fd: number }> {
  const errno = await hh.call('path_open', dirFd, 0, PATH, hh.put(PATH, path), oflags, rights, 0n, 0, FD_OUT)
  return { errno, fd: hh.u32(FD_OUT) }
}

interface Dirent { next: bigint, name: string, type: number }

function parseDirents (hh: HostHarness, used: number): Dirent[] {
  const out: Dirent[] = []
  let at = BUF
  while (at + 24 <= BUF + used) {
    const nameLength = hh.u32(at + 16)
    if (at + 24 + nameLength > BUF + used) break
    out.push({ next: hh.u64(at), name: hh.text(at + 24, nameLength), type: hh.u32(at + 20) & 0xff })
    at += 24 + nameLength
  }
  return out
}

describe('fd_readdir', () => {
  it('lists `.` and `..`, then each entry with its type', async () => {
    const hh = await harness()
    await hh.call('path_create_directory', ROOT_FD, PATH, hh.put(PATH, 'd'))
    await hh.call('path_create_directory', ROOT_FD, PATH, hh.put(PATH, 'd/sub'))
    await openAt(hh, ROOT_FD, 'd/f', CREAT, READ | WRITE)
    const { fd } = await openAt(hh, ROOT_FD, 'd', DIRECTORY, READ)
    expect(await hh.call('fd_readdir', fd, BUF, 4096, 0n, NUM)).toBe(Errno.SUCCESS)
    const entries = parseDirents(hh, hh.u32(NUM))
    expect(entries.map((entry) => entry.name).sort()).toEqual(['.', '..', 'f', 'sub'])
    expect(entries.find((entry) => entry.name === 'f')?.type).toBe(4)
    expect(entries.find((entry) => entry.name === 'sub')?.type).toBe(3)
    expect(entries.map((entry) => entry.next)).toEqual([1n, 2n, 3n, 4n])
  })

  it('resumes from a cookie, and fills a too-small buffer exactly so libc knows to call again', async () => {
    const hh = await harness()
    await hh.call('path_create_directory', ROOT_FD, PATH, hh.put(PATH, 'd'))
    await openAt(hh, ROOT_FD, 'd/a-rather-long-file-name', CREAT, READ | WRITE)
    const { fd } = await openAt(hh, ROOT_FD, 'd', DIRECTORY, READ)
    expect(await hh.call('fd_readdir', fd, BUF, 30, 0n, NUM)).toBe(Errno.SUCCESS)
    expect(hh.u32(NUM)).toBe(30)
    expect(await hh.call('fd_readdir', fd, BUF, 4096, 2n, NUM)).toBe(Errno.SUCCESS)
    expect(parseDirents(hh, hh.u32(NUM)).map((entry) => entry.name)).toEqual(['a-rather-long-file-name'])
  })

  it('cannot list the app root itself, which the broker refuses', async () => {
    const hh = await harness()
    expect(await hh.call('fd_readdir', ROOT_FD, BUF, 4096, 0n, NUM)).toBe(Errno.ACCES)
  })

  it('is NOTDIR on a file and BADF on an unknown descriptor', async () => {
    const hh = await harness()
    const { fd } = await openAt(hh, ROOT_FD, 'f', CREAT, READ | WRITE)
    expect(await hh.call('fd_readdir', fd, BUF, 64, 0n, NUM)).toBe(Errno.NOTDIR)
    expect(await hh.call('fd_readdir', 42, BUF, 64, 0n, NUM)).toBe(Errno.BADF)
  })
})

describe('preopens', () => {
  it('names the default preopen `/`, and a too-small name buffer is NAMETOOLONG', async () => {
    const hh = await harness()
    expect(await hh.call('fd_prestat_get', ROOT_FD, STAT)).toBe(Errno.SUCCESS)
    expect(hh.u32(STAT)).toBe(0)
    expect(hh.u32(STAT + 4)).toBe(1)
    expect(await hh.call('fd_prestat_dir_name', ROOT_FD, BUF, 1)).toBe(Errno.SUCCESS)
    expect(hh.text(BUF, 1)).toBe('/')
    expect(await hh.call('fd_prestat_dir_name', ROOT_FD, BUF, 0)).toBe(Errno.NAMETOOLONG)
    expect(await hh.call('fd_prestat_get', ROOT_FD + 1, STAT)).toBe(Errno.BADF)
  })

  it('maps a guest name onto a folder under the virtual root', async () => {
    const hh = await harness({ preopens: { '/data': '/orivon/app/data' } })
    await hh.disk.orivon.fs.mkdir('data')
    await openAt(hh, ROOT_FD, 'inside.txt', CREAT, READ | WRITE)
    expect(await hh.disk.existsOnDisk('data/inside.txt')).toBe(true)
    expect(await hh.call('fd_readdir', ROOT_FD, BUF, 4096, 0n, NUM)).toBe(Errno.SUCCESS)
  })

  it('refuses at creation a preopen outside the virtual root', async () => {
    const hh = await harness()
    expect(() => createWasiHost({ fs: hh.disk.orivon.fs, preopens: { '/': '/etc' } })).toThrow(/EACCES/)
  })
})

describe('stdio', () => {
  it('reports character devices with no seek or tell, which is how isatty() recognises one', async () => {
    const hh = await harness()
    expect(await hh.call('fd_fdstat_get', 1, STAT)).toBe(Errno.SUCCESS)
    expect(hh.u32(STAT) & 0xff).toBe(2)
    expect(hh.u64(STAT + 8) & ((1n << 2n) | (1n << 5n))).toBe(0n)
    expect(await hh.call('fd_seek', 1, 0n, 0, NUM)).toBe(Errno.SPIPE)
  })

  it('sends fd 1 and fd 2 to the embedder\'s sinks, and reads fd 0 from its source until end of input', async () => {
    const out: string[] = []
    const err: string[] = []
    const input = [new TextEncoder().encode('typed')]
    const hh = await harness({
      stdout: (bytes) => { out.push(new TextDecoder().decode(bytes)) },
      stderr: (bytes) => { err.push(new TextDecoder().decode(bytes)) },
      stdin: { read: async () => input.shift() ?? new Uint8Array(0) }
    })
    hh.iovec(IOV, BUF, hh.put(BUF, 'to out'))
    expect(await hh.call('fd_write', 1, IOV, 1, NUM)).toBe(Errno.SUCCESS)
    hh.iovec(IOV, BUF, hh.put(BUF, 'to err'))
    expect(await hh.call('fd_write', 2, IOV, 1, NUM)).toBe(Errno.SUCCESS)
    expect(out).toEqual(['to out'])
    expect(err).toEqual(['to err'])
    hh.iovec(IOV, BUF, 64)
    expect(await hh.call('fd_read', 0, IOV, 1, NUM)).toBe(Errno.SUCCESS)
    expect(hh.text(BUF, hh.u32(NUM))).toBe('typed')
    expect(await hh.call('fd_read', 0, IOV, 1, NUM)).toBe(Errno.SUCCESS)
    expect(hh.u32(NUM)).toBe(0)
    expect(await hh.call('fd_write', 0, IOV, 1, NUM)).toBe(Errno.BADF)
    expect(await hh.call('fd_read', 1, IOV, 1, NUM)).toBe(Errno.BADF)
  })

  it('waits for a slow stdout consumer before fd_write returns', async () => {
    let release: () => void = () => {}
    const hh = await harness({ stdout: async () => { await new Promise<void>((resolve) => { release = resolve }) } })
    hh.iovec(IOV, BUF, hh.put(BUF, 'x'))
    let settled = false
    const pending = hh.call('fd_write', 1, IOV, 1, NUM).then((errno) => { settled = true; return errno })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    release()
    expect(await pending).toBe(Errno.SUCCESS)
  })
})
