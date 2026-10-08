import { describe, expect, it } from 'vitest'
import { FS_CONSTANTS as C } from '../constants.js'
import { CREATE_IN_PLACE, normalizeOpenFlags, openFlagged, openFlaggedSync } from '../flags.js'

describe('normalizeOpenFlags', () => {
  it('passes a string through untouched and defaults a missing flag to "r"', () => {
    expect(normalizeOpenFlags('wx')).toBe('wx')
    expect(normalizeOpenFlags(null)).toBe('r')
    expect(normalizeOpenFlags(undefined)).toBe('r')
  })

  it.each([
    [C.O_RDONLY, 'r'],
    [C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK, 'r'],
    [C.O_RDWR, 'r+'],
    [C.O_WRONLY, 'r+'],
    [C.O_WRONLY | C.O_CREAT | C.O_TRUNC, 'w'],
    [C.O_RDWR | C.O_CREAT | C.O_TRUNC, 'w+'],
    [C.O_WRONLY | C.O_CREAT | C.O_EXCL, 'wx'],
    [C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_TRUNC, 'wx'],
    [C.O_RDWR | C.O_CREAT | C.O_EXCL, 'wx+'],
    [C.O_WRONLY | C.O_CREAT | C.O_APPEND, 'a'],
    [C.O_RDWR | C.O_CREAT | C.O_APPEND, 'a+'],
    [C.O_WRONLY | C.O_CREAT | C.O_APPEND | C.O_EXCL, 'ax'],
    [C.O_RDWR | C.O_CREAT, CREATE_IN_PLACE],
    [C.O_WRONLY | C.O_CREAT, CREATE_IN_PLACE]
  ])('maps %i to %s', (flags, expected) => {
    expect(normalizeOpenFlags(flags)).toBe(expected)
  })

  it.each([
    ['an unknown bit', 1 << 20],
    ['access mode 3', 3],
    ['read-only with O_CREAT', C.O_RDONLY | C.O_CREAT],
    ['read-only with O_TRUNC', C.O_RDONLY | C.O_TRUNC],
    ['O_EXCL without O_CREAT', C.O_WRONLY | C.O_EXCL],
    ['O_APPEND without O_CREAT', C.O_WRONLY | C.O_APPEND],
    ['O_TRUNC without O_CREAT', C.O_WRONLY | C.O_TRUNC],
    ['O_APPEND with O_TRUNC', C.O_WRONLY | C.O_CREAT | C.O_APPEND | C.O_TRUNC],
    ['NaN', Number.NaN],
    ['a fraction', 1.5],
    ['a negative number', -1]
  ])('refuses %s with EINVAL', (_name, flags) => {
    expect(() => normalizeOpenFlags(flags)).toThrow(expect.objectContaining({ code: 'EINVAL' }))
  })
})

/** A disk of names, where 'r+' needs the file and 'wx+' needs it absent, as orivon.fs answers them. */
function fakeDisk (files: Set<string>, onOpen: (path: string, flags: string) => void = () => {}) {
  const calls: string[] = []
  const fail = (code: string): Error => Object.assign(new Error(code), { code })
  const open = (path: string, flags: string): string => {
    calls.push(flags)
    onOpen(path, flags)
    if (flags === 'r+' && !files.has(path)) throw fail('notFound')
    if (flags === 'wx+' && files.has(path)) throw fail('exists')
    files.add(path)
    return `${flags}:${path}`
  }
  return { calls, open }
}

describe('openFlagged: O_CREAT without O_TRUNC, as random-access-file opens every file', () => {
  it('keeps an existing file: one r+ open', async () => {
    const disk = fakeDisk(new Set(['a']))
    expect(await openFlagged(async (p, f) => disk.open(p, f), 'a', CREATE_IN_PLACE)).toBe('r+:a')
    expect(disk.calls).toEqual(['r+'])
  })

  it('creates a missing file without truncating anything: r+, then wx+', async () => {
    const disk = fakeDisk(new Set())
    expect(await openFlagged(async (p, f) => disk.open(p, f), 'a', CREATE_IN_PLACE)).toBe('wx+:a')
    expect(disk.calls).toEqual(['r+', 'wx+'])
  })

  it('opens the file another opener created between the two steps', async () => {
    const files = new Set<string>()
    const disk = fakeDisk(files, (path, flags) => { if (flags === 'wx+' && !files.has(path)) files.add(path) })
    expect(await openFlagged(async (p, f) => disk.open(p, f), 'a', CREATE_IN_PLACE)).toBe('r+:a')
    expect(disk.calls).toEqual(['r+', 'wx+', 'r+'])
  })

  it('passes any other error through, and any other flag straight to open', async () => {
    const denied = async (): Promise<string> => { throw Object.assign(new Error('denied'), { code: 'denied' }) }
    await expect(openFlagged(denied, 'a', CREATE_IN_PLACE)).rejects.toMatchObject({ code: 'denied' })
    const disk = fakeDisk(new Set())
    expect(await openFlagged(async (p, f) => disk.open(p, f), 'a', 'w+')).toBe('w+:a')
    expect(disk.calls).toEqual(['w+'])
  })

  it('does the same synchronously', () => {
    const disk = fakeDisk(new Set())
    expect(openFlaggedSync((p, f) => disk.open(p, f), 'a', CREATE_IN_PLACE)).toBe('wx+:a')
    expect(openFlaggedSync((p, f) => disk.open(p, f), 'a', CREATE_IN_PLACE)).toBe('r+:a')
    expect(disk.calls).toEqual(['r+', 'wx+', 'r+'])
  })
})
