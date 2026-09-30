import { describe, expect, it } from 'vitest'
import { toNodeStats } from '../stats.js'

describe('toNodeStats', () => {
  it('exposes isFile/isDirectory as callable methods, matching real fs.Stats', () => {
    const stats = toNodeStats({ size: 42, isFile: true, isDirectory: false, mtimeMs: 1_700_000_000_000 })
    expect(stats.isFile()).toBe(true)
    expect(stats.isDirectory()).toBe(false)
    expect(stats.isSymbolicLink()).toBe(false)
  })

  it('exposes a real Date on .mtime, not just mtimeMs -- webtorrent calls stat.mtime.getTime()', () => {
    const stats = toNodeStats({ size: 0, isFile: true, isDirectory: false, mtimeMs: 1_700_000_000_000 })
    expect(stats.mtime).toBeInstanceOf(Date)
    expect(stats.mtime.getTime()).toBe(1_700_000_000_000)
  })

  it('carries size through unchanged', () => {
    expect(toNodeStats({ size: 12345, isFile: true, isDirectory: false, mtimeMs: 0 }).size).toBe(12345)
  })
})

describe('toNodeStats: the full Node field set', () => {
  const file = { size: 5000, isFile: true, isDirectory: false, mtimeMs: 1_700_000_000_123 }

  it('carries every field etag and express.static read', () => {
    const stats = toNodeStats(file, '/a/b.txt')
    for (const key of ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev', 'size', 'blksize', 'blocks', 'atimeMs', 'mtimeMs', 'ctimeMs', 'birthtimeMs'] as const) {
      expect(typeof stats[key], key).toBe('number')
    }
    for (const key of ['atime', 'mtime', 'ctime', 'birthtime'] as const) {
      expect(stats[key], key).toBeInstanceOf(Date)
      expect(stats[key].getTime()).toBe(file.mtimeMs)
    }
    expect(stats.isBlockDevice()).toBe(false)
    expect(stats.isSocket()).toBe(false)
  })

  it('derives ino from the path: stable per path, different across paths, a safe integer', () => {
    const one = toNodeStats(file, '/a/b.txt').ino
    expect(toNodeStats({ ...file, size: 1 }, '/a/b.txt').ino).toBe(one)
    expect(toNodeStats(file, '/a/c.txt').ino).not.toBe(one)
    expect(Number.isSafeInteger(one)).toBe(true)
    expect(one).toBeGreaterThan(0)
  })

  it('reports a regular file or a directory in mode, and whole blocks', () => {
    expect(toNodeStats(file).mode & 0o170000).toBe(0o100000)
    expect(toNodeStats({ size: 0, isFile: false, isDirectory: true, mtimeMs: 0 }).mode & 0o170000).toBe(0o040000)
    expect(toNodeStats(file).blocks).toBe(16)
  })

  it('has the shape the etag package checks', () => {
    const stats = toNodeStats(file, '/a')
    expect(typeof stats === 'object' && stats.ctime instanceof Date && typeof stats.ino === 'number').toBe(true)
  })
})
