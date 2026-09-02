import { describe, expect, it } from 'vitest'
import { errnoOf, fail, isOrivonErrorLike } from './errors.js'

describe('isOrivonErrorLike', () => {
  it('recognises a value fail() produced', () => {
    const error = fail('denied', 'nope')

    expect(isOrivonErrorLike(error)).toBe(true)
  })

  it('rejects a plain Error with no code', () => {
    expect(isOrivonErrorLike(new Error('boom'))).toBe(false)
  })

  it('rejects an Error whose code is not a real OrivonErrorCode', () => {
    const error = new Error('boom') as Error & { code: string }
    error.code = 'NOT_A_REAL_CODE'

    expect(isOrivonErrorLike(error)).toBe(false)
  })

  it('rejects a non-Error value even if it happens to carry a valid code property', () => {
    expect(isOrivonErrorLike({ code: 'denied', message: 'nope' })).toBe(false)
  })

  it('rejects null and undefined', () => {
    expect(isOrivonErrorLike(null)).toBe(false)
    expect(isOrivonErrorLike(undefined)).toBe(false)
  })
})

// The two copies this consolidates disagreed on the first and third cases
// below, so both are pinned here rather than left to the call sites.
describe('errnoOf', () => {
  it('reads the code off a real Node error', () => {
    const error = new Error('reset') as Error & { code: string }
    error.code = 'ECONNRESET'

    expect(errnoOf(error)).toBe('ECONNRESET')
  })

  it('reads the code off a plain object that is not an Error', () => {
    expect(errnoOf({ code: 'ENOENT' })).toBe('ENOENT')
  })

  it('ignores a code that is not a string', () => {
    expect(errnoOf({ code: 111 })).toBeUndefined()
  })

  it('ignores a code property that is present but undefined', () => {
    expect(errnoOf({ code: undefined })).toBeUndefined()
  })

  it('returns undefined for an error carrying no code at all', () => {
    expect(errnoOf(new Error('boom'))).toBeUndefined()
  })

  it('returns undefined for null and for a primitive', () => {
    expect(errnoOf(null)).toBeUndefined()
    expect(errnoOf('ECONNRESET')).toBeUndefined()
  })
})
