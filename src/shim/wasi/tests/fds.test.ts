import { describe, expect, it } from 'vitest'
import { Errno } from '../errno.js'
import { type DirectoryEntry, FdTable, PathError, inodeFor, resolveGuestPath } from '../fds.js'

const ROOT: DirectoryEntry = { kind: 'directory', path: '.' }
const SUB: DirectoryEntry = { kind: 'directory', path: 'data/sub' }

function errnoOf (run: () => unknown): number | undefined {
  try {
    run()
    return undefined
  } catch (error) {
    return error instanceof PathError ? error.errno : -1
  }
}

describe('resolveGuestPath', () => {
  it('joins a relative path onto its directory', () => {
    expect(resolveGuestPath(ROOT, 'a/b.txt')).toEqual({ path: 'a/b.txt', trailingSlash: false })
    expect(resolveGuestPath(SUB, 'c.txt')).toEqual({ path: 'data/sub/c.txt', trailingSlash: false })
    expect(resolveGuestPath(SUB, 'x/../c.txt').path).toBe('data/sub/c.txt')
  })

  it('names the directory itself for `.` and for a path that returns to it', () => {
    expect(resolveGuestPath(ROOT, '.').path).toBe('.')
    expect(resolveGuestPath(SUB, 'x/..').path).toBe('data/sub')
  })

  it('remembers a trailing slash, which a regular file must refuse', () => {
    expect(resolveGuestPath(ROOT, 'dir/')).toEqual({ path: 'dir', trailingSlash: true })
  })

  it('is NOTCAPABLE for a path above its own directory, even one still inside the app root', () => {
    expect(errnoOf(() => resolveGuestPath(ROOT, '../escape'))).toBe(Errno.NOTCAPABLE)
    expect(errnoOf(() => resolveGuestPath(ROOT, 'a/../../escape'))).toBe(Errno.NOTCAPABLE)
    expect(errnoOf(() => resolveGuestPath(SUB, '../sibling'))).toBe(Errno.NOTCAPABLE)
  })

  it('is NOTCAPABLE for an absolute path, NOENT for an empty one, INVAL for an embedded NUL', () => {
    expect(errnoOf(() => resolveGuestPath(ROOT, '/etc/passwd'))).toBe(Errno.NOTCAPABLE)
    expect(errnoOf(() => resolveGuestPath(ROOT, ''))).toBe(Errno.NOENT)
    expect(errnoOf(() => resolveGuestPath(ROOT, 'a\0b'))).toBe(Errno.INVAL)
  })
})

describe('FdTable', () => {
  it('hands out the lowest free descriptor, as POSIX does', () => {
    const table = new FdTable()
    expect(table.add({ kind: 'stdin' })).toBe(0)
    expect(table.add({ kind: 'stdout' })).toBe(1)
    expect(table.add({ kind: 'stderr' })).toBe(2)
    table.remove(1)
    expect(table.add(ROOT)).toBe(1)
    expect(table.add(SUB)).toBe(3)
  })
})

describe('inodeFor', () => {
  it('is stable for one path and differs between paths', () => {
    expect(inodeFor('a/b')).toBe(inodeFor('a/b'))
    expect(inodeFor('a/b')).not.toBe(inodeFor('a/c'))
    expect(inodeFor('a/b') < 1n << 64n).toBe(true)
  })
})
