// The fd_* and path_* imports against a real directory. Each case is
// named for the POSIX behaviour a compiled program relies on.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Errno } from '../errno.js'
import { createHostHarness, type HostHarness } from './support/host-harness.js'

const ROOT_FD = 3
const READ = 1n << 1n
const WRITE = 1n << 6n
const CREAT = 1
const DIRECTORY = 2
const EXCL = 4
const TRUNC = 8
const APPEND = 1
const SYNC = 16
const WHENCE_SET = 0

const PATH = 0
const FD_OUT = 512
const IOV = 520
const NUM = 536
const STAT = 600
const BUF = 1024

let h: HostHarness

beforeEach(async () => { h = await createHostHarness() })
afterEach(async () => { await h.cleanup() })

async function open (path: string, oflags = 0, rights = READ | WRITE, fdflags = 0): Promise<{ errno: number, fd: number }> {
  const len = h.put(PATH, path)
  const errno = await h.call('path_open', ROOT_FD, 0, PATH, len, oflags, rights, 0n, fdflags, FD_OUT)
  return { errno, fd: h.u32(FD_OUT) }
}

async function create (path: string, text = ''): Promise<number> {
  const { errno, fd } = await open(path, CREAT | TRUNC)
  expect(errno).toBe(Errno.SUCCESS)
  if (text.length > 0) expect((await write(fd, text)).errno).toBe(Errno.SUCCESS)
  return fd
}

async function write (fd: number, text: string): Promise<{ errno: number, written: number }> {
  const len = h.put(BUF, text)
  h.iovec(IOV, BUF, len)
  const errno = await h.call('fd_write', fd, IOV, 1, NUM)
  return { errno, written: h.u32(NUM) }
}

async function read (fd: number, max = 64): Promise<{ errno: number, text: string }> {
  h.iovec(IOV, BUF, max)
  const errno = await h.call('fd_read', fd, IOV, 1, NUM)
  return { errno, text: errno === Errno.SUCCESS ? h.text(BUF, h.u32(NUM)) : '' }
}

async function pathCall (name: string, path: string): Promise<number> {
  return await h.call(name, ROOT_FD, PATH, h.put(PATH, path))
}

async function filestat (path: string): Promise<{ errno: number, filetype: number, size: bigint }> {
  const errno = await h.call('path_filestat_get', ROOT_FD, 0, PATH, h.put(PATH, path), STAT)
  return { errno, filetype: h.u32(STAT + 16) & 0xff, size: h.u64(STAT + 32) }
}

describe('reading and writing a file', () => {
  it('creates a file, writes through the cursor, seeks back and reads the same bytes', async () => {
    const fd = await create('out.txt', 'hello')
    expect(await h.call('fd_seek', fd, 0n, WHENCE_SET, NUM)).toBe(Errno.SUCCESS)
    expect(await read(fd)).toEqual({ errno: Errno.SUCCESS, text: 'hello' })
    expect(await h.disk.readRealFile('out.txt')).toBe('hello')
  })

  it('pwrite and pread use their own position and leave the cursor where it was', async () => {
    const fd = await create('f', 'abcdef')
    const len = h.put(BUF, 'XY')
    h.iovec(IOV, BUF, len)
    expect(await h.call('fd_pwrite', fd, IOV, 1, 2n, NUM)).toBe(Errno.SUCCESS)
    expect(await h.call('fd_tell', fd, NUM)).toBe(Errno.SUCCESS)
    expect(h.u64(NUM)).toBe(6n)
    h.iovec(IOV, BUF, 3)
    expect(await h.call('fd_pread', fd, IOV, 1, 1n, NUM)).toBe(Errno.SUCCESS)
    expect(h.text(BUF, h.u32(NUM))).toBe('bXY')
    expect(await h.disk.readRealFile('f')).toBe('abXYef')
  })

  it('an APPEND descriptor writes at the end even after a seek, and reports the flag', async () => {
    const { errno, fd } = await open('log', CREAT, READ | WRITE, APPEND)
    expect(errno).toBe(Errno.SUCCESS)
    await write(fd, 'one')
    await h.call('fd_seek', fd, 0n, WHENCE_SET, NUM)
    await write(fd, 'two')
    expect(await h.disk.readRealFile('log')).toBe('onetwo')
    expect(await h.call('fd_fdstat_get', fd, STAT)).toBe(Errno.SUCCESS)
    expect(h.u32(STAT) >>> 16 & APPEND).toBe(APPEND)
  })

  it('refuses the synchronous-write fdflags rather than accepting and ignoring them', async () => {
    expect((await open('s', CREAT, READ | WRITE, SYNC)).errno).toBe(Errno.NOTSUP)
  })

  it('a read-only descriptor refuses a write with BADF and reports no write right', async () => {
    await create('ro', 'x')
    const { fd } = await open('ro', 0, READ)
    expect((await write(fd, 'y')).errno).toBe(Errno.BADF)
    await h.call('fd_fdstat_get', fd, STAT)
    expect(h.u64(STAT + 8) & WRITE).toBe(0n)
    expect(h.u64(STAT + 8) & READ).toBe(READ)
  })

  it('truncates and extends through fd_filestat_set_size, and fd_allocate never shrinks', async () => {
    const fd = await create('t', 'abcdef')
    expect(await h.call('fd_filestat_set_size', fd, 2n)).toBe(Errno.SUCCESS)
    expect(await h.disk.readRealFile('t')).toBe('ab')
    expect(await h.call('fd_allocate', fd, 0n, 1n)).toBe(Errno.SUCCESS)
    expect((await filestat('t')).size).toBe(2n)
    expect(await h.call('fd_allocate', fd, 2n, 3n)).toBe(Errno.SUCCESS)
    expect((await filestat('t')).size).toBe(5n)
  })
})

describe('opening', () => {
  it('a missing file without CREAT is NOENT, and CREAT|EXCL on an existing one is EXIST', async () => {
    expect((await open('missing')).errno).toBe(Errno.NOENT)
    await create('there')
    expect((await open('there', CREAT | EXCL)).errno).toBe(Errno.EXIST)
  })

  it('a directory opens for reading as a directory descriptor, and for writing is ISDIR', async () => {
    expect(await pathCall('path_create_directory', 'd')).toBe(Errno.SUCCESS)
    expect((await open('d', 0, READ | WRITE)).errno).toBe(Errno.ISDIR)
    const { errno, fd } = await open('d', DIRECTORY, READ)
    expect(errno).toBe(Errno.SUCCESS)
    expect((await read(fd)).errno).toBe(Errno.ISDIR)
    expect(await h.call('fd_seek', fd, 0n, WHENCE_SET, NUM)).toBe(Errno.BADF)
    await h.call('fd_fdstat_get', fd, STAT)
    expect(h.u32(STAT) & 0xff).toBe(3)
  })

  it('DIRECTORY on a regular file is NOTDIR, and a trailing slash after one is NOTDIR too', async () => {
    await create('f')
    expect((await open('f', DIRECTORY, READ)).errno).toBe(Errno.NOTDIR)
    expect((await filestat('f/')).errno).toBe(Errno.NOTDIR)
  })

  it('a path above the directory, or an absolute one, is NOTCAPABLE and never reaches orivon.fs', async () => {
    const stat = vi.spyOn(h.disk.orivon.fs, 'stat')
    const openSpy = vi.spyOn(h.disk.orivon.fs, 'open')
    expect((await open('../escape', CREAT)).errno).toBe(Errno.NOTCAPABLE)
    expect((await open('a/../../escape', CREAT)).errno).toBe(Errno.NOTCAPABLE)
    expect((await open('/etc/passwd')).errno).toBe(Errno.NOTCAPABLE)
    expect(stat).not.toHaveBeenCalled()
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('opens a file that appeared after the stat when O_EXCL was not asked for, and is EXIST when it was', async () => {
    await create('raced', 'kept')
    const notFound = Object.assign(new Error('gone'), { name: 'OrivonError', code: 'notFound' })
    const stat = vi.spyOn(h.disk.orivon.fs, 'stat').mockRejectedValueOnce(notFound)
    const { errno, fd } = await open('raced', CREAT)
    expect(errno).toBe(Errno.SUCCESS)
    expect(await read(fd)).toEqual({ errno: Errno.SUCCESS, text: 'kept' })
    stat.mockRejectedValueOnce(notFound)
    expect((await open('raced', CREAT | EXCL)).errno).toBe(Errno.EXIST)
  })

  it('a descriptor that is not a directory cannot anchor a path, and an unknown one is BADF', async () => {
    const fd = await create('f')
    const len = h.put(PATH, 'x')
    expect(await h.call('path_open', fd, 0, PATH, len, 0, READ, 0n, 0, FD_OUT)).toBe(Errno.NOTDIR)
    expect(await h.call('path_open', 99, 0, PATH, len, 0, READ, 0n, 0, FD_OUT)).toBe(Errno.BADF)
  })
})

describe('describing, removing and renaming', () => {
  it('path_filestat_get reports each kind and a file\'s size', async () => {
    await create('f', 'abc')
    await pathCall('path_create_directory', 'd')
    expect(await filestat('f')).toEqual({ errno: Errno.SUCCESS, filetype: 4, size: 3n })
    expect((await filestat('d')).filetype).toBe(3)
    expect((await filestat('nope')).errno).toBe(Errno.NOENT)
  })

  it('rmdir refuses a non-empty directory, unlink refuses a directory, and each removes its own kind', async () => {
    await pathCall('path_create_directory', 'd')
    await create('d/x')
    expect(await pathCall('path_remove_directory', 'd')).toBe(Errno.NOTEMPTY)
    expect(await pathCall('path_unlink_file', 'd')).toBe(Errno.ISDIR)
    expect(await pathCall('path_remove_directory', 'd/x')).toBe(Errno.NOTDIR)
    expect(await pathCall('path_unlink_file', 'd/x')).toBe(Errno.SUCCESS)
    expect(await pathCall('path_remove_directory', 'd')).toBe(Errno.SUCCESS)
    expect(await h.disk.existsOnDisk('d')).toBe(false)
  })

  it('creating a directory that exists is EXIST', async () => {
    await pathCall('path_create_directory', 'd')
    expect(await pathCall('path_create_directory', 'd')).toBe(Errno.EXIST)
  })

  it('renames a file', async () => {
    await create('a', 'moved')
    const from = h.put(PATH, 'a')
    const to = h.put(PATH + 16, 'b')
    expect(await h.call('path_rename', ROOT_FD, PATH, from, ROOT_FD, PATH + 16, to)).toBe(Errno.SUCCESS)
    expect(await h.disk.readRealFile('b')).toBe('moved')
  })

  it('answers the app root locally: it is a directory, and nothing removes, replaces or recreates it', async () => {
    expect((await filestat('.')).filetype).toBe(3)
    expect(await pathCall('path_remove_directory', '.')).toBe(Errno.INVAL)
    expect(await pathCall('path_unlink_file', '.')).toBe(Errno.ISDIR)
    expect(await pathCall('path_create_directory', '.')).toBe(Errno.EXIST)
  })

  it('path_readlink is INVAL for an existing name, since orivon.fs has no links', async () => {
    await create('f')
    expect(await h.call('path_readlink', ROOT_FD, PATH, h.put(PATH, 'f'), BUF, 64, NUM)).toBe(Errno.INVAL)
  })
})

describe('closing', () => {
  it('fd_close closes the broker handle, and a second close is BADF', async () => {
    const fd = await create('f')
    expect(await h.call('fd_close', fd)).toBe(Errno.SUCCESS)
    expect(await h.call('fd_close', fd)).toBe(Errno.BADF)
  })

  it('finish() closes every file the program left open', async () => {
    const closed: string[] = []
    const realOpen = h.disk.orivon.fs.open.bind(h.disk.orivon.fs)
    vi.spyOn(h.disk.orivon.fs, 'open').mockImplementation(async (path, flags) => {
      const handle = await realOpen(path, flags)
      return { ...handle, close: async () => { closed.push(path); await handle.close() } }
    })
    await create('left-open')
    await h.host.finish()
    expect(closed).toEqual(['left-open'])
  })
})
