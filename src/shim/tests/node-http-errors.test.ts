import { describe, expect, it } from 'vitest'
import { toNodeError } from '../node-http-errors.js'
import type { OrivonError, OrivonErrorCode } from '../../contracts/errors.js'

function orivonError (code: OrivonErrorCode, message: string, platformCode?: string): OrivonError {
  const error = new Error(message) as Error & { code: OrivonErrorCode, platformCode?: string }
  error.code = code
  if (platformCode !== undefined) error.platformCode = platformCode
  return error
}

describe('toNodeError', () => {
  it('keeps a denial as code "denied", never a fabricated network errno', () => {
    const result = toNodeError(orivonError('denied', 'host not granted'))
    expect(result.code).toBe('denied')
    expect(result.orivonCode).toBe('denied')
    expect(result.message).toContain('host not granted')
  })

  it('prefers platformCode when present, for a code other than denied', () => {
    const result = toNodeError(orivonError('unreachable', 'connect failed', 'ECONNREFUSED'))
    expect(result.code).toBe('ECONNREFUSED')
    expect(result.orivonCode).toBe('unreachable')
  })

  it('falls back to the OrivonErrorCode itself when platformCode is absent', () => {
    const result = toNodeError(orivonError('timeout', 'no response in time'))
    expect(result.code).toBe('timeout')
    expect(result.orivonCode).toBe('timeout')
  })

  it('passes through a TLS-mapped platformCode without assuming what it means', () => {
    // docs/open-questions.md: TLS failures currently arrive as 'unreachable'.
    // This file must not special-case that value -- it only ever forwards
    // platformCode, so a future remapping needs no change here.
    const result = toNodeError(orivonError('unreachable', 'handshake failed', 'CERT_HAS_EXPIRED'))
    expect(result.code).toBe('CERT_HAS_EXPIRED')
    expect(result.orivonCode).toBe('unreachable')
  })

  it('wraps a non-OrivonError value as an internal error rather than throwing', () => {
    const result = toNodeError('a plain string, not an Error')
    expect(result.code).toBe('internal')
    expect(result).toBeInstanceOf(Error)
  })

  it('wraps a bare Error with no .code as an internal error', () => {
    const result = toNodeError(new Error('mystery failure'))
    expect(result.code).toBe('internal')
    expect(result.message).toBe('mystery failure')
  })

  // A152 (docs/open-questions.md): measured live, a real denial that
  // crosses back from the main world (../preload/main-world-socket.ts) is
  // a PLAIN OBJECT in this world -- never `instanceof Error`, despite
  // carrying every field correctly. isOrivonError used to require
  // `instanceof Error` and silently turned every one of these into
  // 'internal'.
  it('recognises a plain-object OrivonError that crossed a world boundary, never an Error instance', () => {
    const crossed = { name: 'OrivonError', message: 'tcp.connect is not granted to this origin', code: 'denied' }
    const result = toNodeError(crossed)
    expect(result.code).toBe('denied')
    expect(result.orivonCode).toBe('denied')
    expect(result).toBeInstanceOf(Error)
  })

  // The closed enum must survive the relaxed, structural check: a value
  // shaped like an OrivonError but carrying a code outside the eleven real
  // ones must still fail closed to 'internal', never be trusted through.
  it('still fails closed to internal when a plain object\'s code is not a real OrivonErrorCode', () => {
    const spoofed = { name: 'OrivonError', message: 'not really one of ours', code: 'not-a-real-code' }
    const result = toNodeError(spoofed)
    expect(result.code).toBe('internal')
    expect(result.orivonCode).toBe('internal')
  })

  it('still fails closed to internal when a plain object is missing .message', () => {
    const malformed = { name: 'OrivonError', code: 'denied' }
    const result = toNodeError(malformed)
    expect(result.code).toBe('internal')
  })
})
