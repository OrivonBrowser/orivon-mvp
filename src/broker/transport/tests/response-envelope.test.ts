import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { fail } from '../../errors.js'
import { toFailureResponse } from '../response-envelope.js'
import type { OrivonErrorCode } from '../../../contracts/index.js'

const ID = 'req-1'
const SECRET_PATH = '/home/someone/.config/orivon/apps/abc123/private.db'

let logged: MockInstance<typeof console.error>

beforeEach(() => {
  logged = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  logged.mockRestore()
})

describe('toFailureResponse -- a broker fault is logged, and the app learns nothing of it', () => {
  it('logs a thrown value that is not an OrivonError once, with the error itself, and tells the app only that something internal failed', () => {
    const fault = new TypeError(`cannot read properties of undefined (reading 'grants') at ${SECRET_PATH}`)

    const response = toFailureResponse(ID, fault)

    expect(response).toStrictEqual({ id: ID, ok: false, code: 'internal', message: 'an internal error occurred' })
    expect(JSON.stringify(response)).not.toContain(SECRET_PATH)
    expect(logged).toHaveBeenCalledTimes(1)
    const [prefix, ...rest] = logged.mock.calls[0]!
    expect(String(prefix)).toMatch(/^\[broker\] /)
    expect(rest).toContain(fault)
  })

  it('logs a thrown value that is not an Error as well, and answers the same', () => {
    const response = toFailureResponse(ID, 'a string nobody wrapped')

    expect(response).toStrictEqual({ id: ID, ok: false, code: 'internal', message: 'an internal error occurred' })
    expect(logged).toHaveBeenCalledTimes(1)
    expect(logged.mock.calls[0]).toContain('a string nobody wrapped')
  })

  it('logs an OrivonError whose code is internal once, and answers with it exactly as before', () => {
    const fault = fail('internal', 'the grant could not be persisted', undefined, 'ENOSPC')

    const response = toFailureResponse(ID, fault)

    expect(response).toStrictEqual({ id: ID, ok: false, code: 'internal', message: 'the grant could not be persisted', platformCode: 'ENOSPC' })
    expect(logged).toHaveBeenCalledTimes(1)
    const [prefix, ...rest] = logged.mock.calls[0]!
    expect(String(prefix)).toMatch(/^\[broker\] /)
    expect(rest).toContain(fault)
  })

  it.each<OrivonErrorCode>(['denied', 'revoked', 'unreachable', 'timeout', 'reset', 'closed', 'limit', 'invalid', 'notFound', 'exists', 'unavailable'])(
    'does not log a %s error, which is an answer to the app and not a fault',
    (code) => {
      const response = toFailureResponse(ID, fail(code, 'a routine answer'))

      expect(response).toStrictEqual({ id: ID, ok: false, code, message: 'a routine answer' })
      expect(logged).not.toHaveBeenCalled()
    }
  )

  it('still carries a platformCode on a routine error and none on a denial, with nothing logged', () => {
    const notFound = fail('notFound', 'the filesystem operation failed', undefined, 'ENOENT')
    const denied = Object.assign(fail('denied', 'denied'), { platformCode: 'EACCES' })

    expect(toFailureResponse(ID, notFound)).toStrictEqual({ id: ID, ok: false, code: 'notFound', message: 'the filesystem operation failed', platformCode: 'ENOENT' })
    expect(toFailureResponse(ID, denied)).toStrictEqual({ id: ID, ok: false, code: 'denied', message: 'denied' })
    expect(logged).not.toHaveBeenCalled()
  })
})
