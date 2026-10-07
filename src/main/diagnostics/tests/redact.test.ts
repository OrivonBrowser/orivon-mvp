import { describe, expect, it } from 'vitest'
import { redactDeep, redactHome } from '../redact.js'

describe('redactHome', () => {
  it('turns the home directory into ~ wherever a path starts with it', () => {
    expect(redactHome('at /home/ann/git/orivon/src/main/index.ts:12', '/home/ann')).toBe('at ~/git/orivon/src/main/index.ts:12')
    expect(redactHome('open /home/ann and /home/ann/x', '/home/ann')).toBe('open ~ and ~/x')
  })

  it('leaves a longer name that only begins the same way', () => {
    expect(redactHome('/home/anna/x /home/ann-b/y /home/ann.old/z', '/home/ann')).toBe('/home/anna/x /home/ann-b/y /home/ann.old/z')
  })

  it('reads a Windows path with either slash, and ignores case when told to', () => {
    expect(redactHome('C:\\Users\\Ann\\AppData and C:/Users/Ann/x', 'C:\\Users\\Ann')).toBe('~\\AppData and ~/x')
    expect(redactHome('c:\\users\\ann\\x', 'C:\\Users\\Ann', true)).toBe('~\\x')
  })

  it('does nothing for a home that is empty or the root, which would otherwise rewrite every path', () => {
    expect(redactHome('/etc/passwd', '/')).toBe('/etc/passwd')
    expect(redactHome('/etc/passwd', '')).toBe('/etc/passwd')
  })

  it('treats the characters of a path literally', () => {
    expect(redactHome('/home/a.b+c/x', '/home/a.b+c')).toBe('~/x')
    expect(redactHome('/home/aXb+c/x', '/home/a.b+c')).toBe('/home/aXb+c/x')
  })
})

describe('redactDeep', () => {
  it('reaches every string in nested objects and arrays, and leaves other values', () => {
    const input = { a: '/home/ann/x', b: ['/home/ann', 3, null, { c: '/home/ann/y' }], d: true }
    expect(redactDeep(input, '/home/ann')).toEqual({ a: '~/x', b: ['~', 3, null, { c: '~/y' }], d: true })
  })
})
