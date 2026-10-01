import { describe, expect, it } from 'vitest'
import { FS_CONSTANTS as C } from '../constants.js'
import { normalizeOpenFlags } from '../flags.js'

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
    [C.O_WRONLY | C.O_CREAT | C.O_APPEND | C.O_EXCL, 'ax']
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
    ['create without truncate or append', C.O_WRONLY | C.O_CREAT]
  ])('refuses %s with EINVAL', (_name, flags) => {
    expect(() => normalizeOpenFlags(flags)).toThrow(expect.objectContaining({ code: 'EINVAL' }))
  })
})
