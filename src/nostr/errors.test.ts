import { describe, expect, it } from 'vitest'
import { fail } from './errors.js'

describe('fail', () => {
  it('builds a real Error carrying the given code', () => {
    const error = fail('denied', 'user declined the connect prompt')

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('user declined the connect prompt')
    expect(error.code).toBe('denied')
  })

  it('never sets platformCode -- nothing underneath failed at this layer', () => {
    const error = fail('internal', 'broker returned a malformed event')

    expect(error.platformCode).toBeUndefined()
  })
})
