import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResolutionError } from '../../resolution/records.js'
import { DIRECT_ROUTE } from '../../route-pace.js'
import { FILE_RETRIES, isTransient, readWithRetries } from '../serve/retry.js'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const unavailable = (): ResolutionError => new ResolutionError('unavailable', 'no gateway answered')

describe('a file read again before the page is told it is missing', () => {
  it('returns at once when the first read works', async () => {
    const attempt = vi.fn(async () => 'ok')
    expect(await readWithRetries(attempt, DIRECT_ROUTE, new AbortController().signal)).toBe('ok')
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('reads again after a pause when nothing answered, and returns what the later read brings', async () => {
    const attempt = vi.fn(async (n: number) => { if (n < 2) throw unavailable(); return `read ${String(n)}` })
    const pending = readWithRetries(attempt, DIRECT_ROUTE, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(1_500)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await pending).toBe('read 2')
  })

  it('gives up after the retries are spent and throws the last failure', async () => {
    const attempt = vi.fn(async () => { throw unavailable() })
    const pending = readWithRetries(attempt, DIRECT_ROUTE, new AbortController().signal).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await pending).toBeInstanceOf(ResolutionError)
    expect(attempt).toHaveBeenCalledTimes(FILE_RETRIES + 1)
  })

  it('does not read again once the reads so far have taken the route\'s patience: the layers below were already patient', async () => {
    let clock = 0
    const attempt = vi.fn(async () => { clock += DIRECT_ROUTE.wait(30_000); throw unavailable() })
    await expect(readWithRetries(attempt, DIRECT_ROUTE, new AbortController().signal, FILE_RETRIES, () => clock)).rejects.toBeInstanceOf(ResolutionError)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a path that is not in the site', new ResolutionError('not-found', 'no such file')],
    ['bytes that failed their check', new ResolutionError('unverifiable', 'hash mismatch')],
    ['a format this build cannot read', new ResolutionError('unsupported', 'codec')],
    ['a failure that is not a resolution one', new Error('bug')]
  ])('does not read again for %s, which would only fail the same way', async (_name, error) => {
    const attempt = vi.fn(async () => { throw error })
    await expect(readWithRetries(attempt, DIRECT_ROUTE, new AbortController().signal)).rejects.toBe(error)
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(isTransient(error)).toBe(false)
  })

  it('stops once the page that asked has gone away', async () => {
    const left = new AbortController()
    const attempt = vi.fn(async () => { throw unavailable() })
    const pending = readWithRetries(attempt, DIRECT_ROUTE, left.signal).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10)
    left.abort(new Error('the client went away'))
    await vi.advanceTimersByTimeAsync(10)
    expect(await pending).toBeInstanceOf(ResolutionError)
    expect(attempt).toHaveBeenCalledTimes(1)
  })
})
