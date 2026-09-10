import { describe, expect, it } from 'vitest'
import { isOrivonError, mapIoError, mapTlsError } from '../io-errors.js'
import { fail } from '../errors.js'

describe('isOrivonError', () => {
  it('recognises a value fail() produced', () => {
    expect(isOrivonError(fail('denied', 'nope'))).toBe(true)
  })

  it('rejects a plain Error with no code', () => {
    expect(isOrivonError(new Error('boom'))).toBe(false)
  })

  it('rejects an Error whose code is not a real OrivonErrorCode', () => {
    const error = new Error('boom') as Error & { code: string }
    error.code = 'NOT_A_REAL_CODE'

    expect(isOrivonError(error)).toBe(false)
  })

  it('rejects a non-Error value even if it happens to carry a valid code and the right name', () => {
    expect(isOrivonError({ name: 'OrivonError', code: 'denied', message: 'nope' })).toBe(false)
  })

  it('rejects null and undefined', () => {
    expect(isOrivonError(null)).toBe(false)
    expect(isOrivonError(undefined)).toBe(false)
  })
})

describe('mapIoError', () => {
  it('maps a raw errno to its documented OrivonErrorCode', () => {
    const error = new Error('boom') as Error & { code: string }
    error.code = 'ENOENT'

    const mapped = mapIoError(error, 'fs')

    expect(mapped.code).toBe('notFound')
    expect(mapped.platformCode).toBe('ENOENT')
  })

  it.each([
    ['ECONNREFUSED', 'unreachable'],
    ['EHOSTUNREACH', 'unreachable'],
    ['ENETUNREACH', 'unreachable'],
    ['ENOTFOUND', 'unreachable'],
    ['EAI_AGAIN', 'unreachable'],
    ['ETIMEDOUT', 'timeout'],
    ['ECONNRESET', 'reset'],
    ['EPIPE', 'reset'],
    ['EMFILE', 'limit'],
    ['ENFILE', 'limit'],
    ['ENOSPC', 'limit'],
    ['EDQUOT', 'limit'],
    ['EACCES', 'denied'],
    ['EPERM', 'denied'],
    ['EEXIST', 'exists']
  ] as const)('maps %s to %s', (errno, code) => {
    expect(mapIoError({ code: errno }, 'net').code).toBe(code)
  })

  it('lets an error this broker already produced pass through unchanged', () => {
    const original = fail('revoked', 'the grant was revoked mid-flight')

    expect(mapIoError(original, 'net')).toBe(original)
  })

  it('falls back to \'internal\' for an errno not in the table', () => {
    const mapped = mapIoError({ code: 'EWEIRD' }, 'fs')

    expect(mapped.code).toBe('internal')
    expect(mapped.platformCode).toBe('EWEIRD')
  })

  it('falls back to \'internal\' for a value carrying no errno at all', () => {
    const mapped = mapIoError(new Error('no code here'), 'net')

    expect(mapped.code).toBe('internal')
    expect(mapped.platformCode).toBeUndefined()
  })

  it('writes a fresh message rather than forwarding the raw one, per kind', () => {
    expect(mapIoError({ code: 'ENOENT' }, 'fs').message).toBe('the filesystem operation failed')
    expect(mapIoError({ code: 'ECONNRESET' }, 'net').message).toBe('the network operation failed')
  })
})

describe('mapTlsError', () => {
  // net.connectSecure's own contract (src/contracts/capability-api.ts): a
  // failed handshake or a certificate/hostname mismatch is 'unreachable'
  // with a real platformCode, never 'denied' -- the attempt was one the app
  // was permitted to make.
  it.each([
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ECONNREFUSED'
  ])('maps %s to unreachable, keeping it as platformCode', (code) => {
    const mapped = mapTlsError({ code })

    expect(mapped.code).toBe('unreachable')
    expect(mapped.platformCode).toBe(code)
  })

  it('falls back to \'unreachable\' with no platformCode for a value carrying no code at all', () => {
    const mapped = mapTlsError(new Error('no code here'))

    expect(mapped.code).toBe('unreachable')
    expect(mapped.platformCode).toBeUndefined()
  })

  it('lets an error this broker already produced pass through unchanged -- a revoked grant mid-handshake is not a TLS failure', () => {
    const original = fail('revoked', 'the grant was revoked mid-flight')

    expect(mapTlsError(original)).toBe(original)
  })

  it('writes a fresh message rather than forwarding the raw TLS error text', () => {
    expect(mapTlsError({ code: 'CERT_HAS_EXPIRED', message: 'raw openssl text' }).message)
      .not.toContain('raw openssl text')
  })
})
