import { describe, expect, it } from 'vitest'
import { abortError, codedError, systemError, toNodeError } from '../node-errors.js'
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

  it('synthesises the Node errno for a timeout when platformCode is absent', () => {
    const result = toNodeError(orivonError('timeout', 'no response in time'))
    expect(result.code).toBe('ETIMEDOUT')
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

describe('toNodeError -- Node errno fidelity', () => {
  it('never overwrites a string code a non-Orivon error already carries', () => {
    const argError = Object.assign(new TypeError('bad arg'), { code: 'ERR_INVALID_ARG_TYPE' })
    const result = toNodeError(argError)
    expect(result.code).toBe('ERR_INVALID_ARG_TYPE')
    expect(result.orivonCode).toBe('internal')
    expect(result).toBe(argError)
  })

  it('returns an already-mapped error unchanged instead of mapping it twice', () => {
    const once = toNodeError(orivonError('denied', 'host not granted'))
    const twice = toNodeError(once)
    expect(twice).toBe(once)
    expect(twice.message).toBe(once.message)
  })

  it.each([
    ['timeout', 'connect', 'ETIMEDOUT', -110],
    ['reset', 'read', 'ECONNRESET', -104],
    ['unreachable', 'connect', 'ECONNREFUSED', -111],
    ['unreachable', 'getaddrinfo', 'ENOTFOUND', -3008],
    ['closed', 'write', 'EPIPE', -32]
  ] as const)('synthesises a Node errno for %s during %s when no platformCode arrived', (orivonCode, syscall, code, errno) => {
    const result = toNodeError(orivonError(orivonCode, 'x'), { syscall })
    expect(result.code).toBe(code)
    expect(result.errno).toBe(errno)
    expect(result.syscall).toBe(syscall)
    expect(result.orivonCode).toBe(orivonCode)
  })

  it('keeps the Orivon code when nothing Node-shaped fits (a close outside a write, a limit)', () => {
    expect(toNodeError(orivonError('closed', 'x'), { syscall: 'read' }).code).toBe('closed')
    expect(toNodeError(orivonError('limit', 'x'), { syscall: 'connect' }).code).toBe('limit')
  })

  it('a real platformCode wins over synthesis, and still gets its errno', () => {
    const result = toNodeError(orivonError('unreachable', 'no route', 'EHOSTUNREACH'), { syscall: 'connect' })
    expect(result.code).toBe('EHOSTUNREACH')
    expect(result.errno).toBe(-113)
  })

  it('records syscall, address, port and hostname from the context', () => {
    const result = toNodeError(orivonError('unreachable', 'refused', 'ECONNREFUSED'), { syscall: 'connect', address: '10.0.0.1', port: 50002 })
    expect(result).toMatchObject({ syscall: 'connect', address: '10.0.0.1', port: 50002 })
    const lookup = toNodeError(orivonError('unreachable', 'no records'), { syscall: 'getaddrinfo', hostname: 'nowhere.example' })
    expect(lookup).toMatchObject({ code: 'ENOTFOUND', hostname: 'nowhere.example' })
  })

  it('leaves errno absent for a code that is not a system errno', () => {
    expect(toNodeError(orivonError('denied', 'x'), { syscall: 'connect' }).errno).toBeUndefined()
  })
})

describe('Node-shaped error builders', () => {
  it('codedError carries the code and the constructor Node uses', () => {
    const error = codedError(RangeError, 'ERR_SOCKET_BAD_PORT', 'Port should be >= 0 and < 65536.')
    expect(error).toBeInstanceOf(RangeError)
    expect(error.code).toBe('ERR_SOCKET_BAD_PORT')
  })

  it('systemError reads like Node\'s own: "<syscall> <code> <address>:<port>" with errno', () => {
    const error = systemError('EMSGSIZE', 'send', { address: '1.2.3.4', port: 6881 })
    expect(error.message).toBe('send EMSGSIZE 1.2.3.4:6881')
    expect(error).toMatchObject({ code: 'EMSGSIZE', errno: -90, syscall: 'send', address: '1.2.3.4', port: 6881 })
  })

  it('abortError matches Node\'s AbortError shape and keeps the reason as cause', () => {
    const reason = new Error('user cancelled')
    const error = abortError(reason)
    expect(error.name).toBe('AbortError')
    expect(error.code).toBe('ABORT_ERR')
    expect(error.cause).toBe(reason)
  })
})
