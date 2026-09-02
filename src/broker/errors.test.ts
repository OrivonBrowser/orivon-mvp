import { describe, expect, it } from 'vitest'
import { fail, isOrivonErrorLike } from './errors.js'

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
