import { describe, expect, it } from 'vitest'
import { toNodeStats } from '../node-fs-stats.js'

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
