import { describe, expect, it } from 'vitest'
import { Errno, errnoFor } from '../errno.js'

describe('the preview1 errno numbering', () => {
  it('pins the values wasi-libc and Rust read, which are not Linux\'s', () => {
    expect(Errno.SUCCESS).toBe(0)
    expect(Errno.ACCES).toBe(2)
    expect(Errno.BADF).toBe(8)
    expect(Errno.EXIST).toBe(20)
    expect(Errno.INVAL).toBe(28)
    expect(Errno.IO).toBe(29)
    expect(Errno.ISDIR).toBe(31)
    expect(Errno.NOENT).toBe(44)
    expect(Errno.NOSYS).toBe(52)
    expect(Errno.NOTDIR).toBe(54)
    expect(Errno.NOTEMPTY).toBe(55)
    expect(Errno.NOTSUP).toBe(58)
    expect(Errno.NOTCAPABLE).toBe(76)
  })
})

describe('errnoFor', () => {
  it('prefers the broker\'s platformCode, the one place ENOTEMPTY or EISDIR survives', () => {
    expect(errnoFor({ name: 'OrivonError', code: 'internal', platformCode: 'ENOTEMPTY' })).toBe(Errno.NOTEMPTY)
    expect(errnoFor({ name: 'OrivonError', code: 'internal', platformCode: 'EISDIR' })).toBe(Errno.ISDIR)
  })

  it('reads a Node-shaped code, as fs/root.ts throws for the app root', () => {
    expect(errnoFor({ code: 'EACCES', message: 'x' })).toBe(Errno.ACCES)
  })

  it('maps each Orivon code when no errno name came with it', () => {
    expect(errnoFor({ name: 'OrivonError', code: 'notFound' })).toBe(Errno.NOENT)
    expect(errnoFor({ name: 'OrivonError', code: 'exists' })).toBe(Errno.EXIST)
    expect(errnoFor({ name: 'OrivonError', code: 'denied' })).toBe(Errno.ACCES)
    expect(errnoFor({ name: 'OrivonError', code: 'invalid' })).toBe(Errno.INVAL)
    expect(errnoFor({ name: 'OrivonError', code: 'limit' })).toBe(Errno.NOSPC)
    expect(errnoFor({ name: 'OrivonError', code: 'closed' })).toBe(Errno.BADF)
  })

  it('falls back to IO for anything it cannot read, an inherited property name included', () => {
    expect(errnoFor({ code: 'toString' })).toBe(Errno.IO)
    expect(errnoFor({ code: 'EWHATEVER' })).toBe(Errno.IO)
    expect(errnoFor('boom')).toBe(Errno.IO)
    expect(errnoFor(null)).toBe(Errno.IO)
  })
})
