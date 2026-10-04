import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { interleaveFamilies, raceAddresses, type RaceOptions } from '../staggered-dial.js'
import { fail } from '../../errors.js'

/** One fake dial attempt: settles only when the test says so, and records whether the race aborted it. */
interface Attempt {
  readonly address: string
  readonly signal: AbortSignal
  resolve: (value: string) => void
  reject: (error: unknown) => void
}

function harness (overrides: Partial<RaceOptions<string>> = {}): {
  attempts: Attempt[]
  controller: AbortController
  discarded: string[]
  race: (addresses: readonly string[]) => Promise<string>
} {
  const attempts: Attempt[] = []
  const controller = new AbortController()
  const discarded: string[] = []
  const race = async (addresses: readonly string[]): Promise<string> => await raceAddresses(
    addresses,
    async (address, signal) => await new Promise<string>((resolve, reject) => {
      attempts.push({ address, signal, resolve, reject })
    }),
    {
      signal: controller.signal,
      deadlineMs: 30_000,
      staggerMs: 250,
      timeoutError: () => fail('timeout', 'connecting to port 6667 exceeded 30000ms'),
      discard: (value) => { discarded.push(value) },
      ...overrides
    }
  )
  return { attempts, controller, discarded, race }
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('interleaveFamilies', () => {
  it('alternates families, keeping the resolver\'s first family first', () => {
    expect(interleaveFamilies(['::1', '::2', '10.0.0.1', '10.0.0.2'])).toEqual(['::1', '10.0.0.1', '::2', '10.0.0.2'])
    expect(interleaveFamilies(['10.0.0.1', '10.0.0.2', '::1'])).toEqual(['10.0.0.1', '::1', '10.0.0.2'])
  })

  it('leaves a single-family list in its own order', () => {
    expect(interleaveFamilies(['10.0.0.3', '10.0.0.1'])).toEqual(['10.0.0.3', '10.0.0.1'])
  })
})

describe('raceAddresses', () => {
  it('gives up after ONE overall deadline, not one deadline per address, and aborts every attempt', async () => {
    const { attempts, race } = harness()
    const outcome = race(['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4']).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await outcome).toMatchObject({ code: 'timeout', message: 'connecting to port 6667 exceeded 30000ms' })
    expect(attempts).toHaveLength(4)
    expect(attempts.every((attempt) => attempt.signal.aborted)).toBe(true)
  })

  it('starts the next address after the stagger and lets a faster later one win', async () => {
    const { attempts, race } = harness()
    const outcome = race(['1.1.1.1', '1.1.1.2'])
    expect(attempts.map((attempt) => attempt.address)).toEqual(['1.1.1.1'])
    await vi.advanceTimersByTimeAsync(249)
    expect(attempts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(attempts.map((attempt) => attempt.address)).toEqual(['1.1.1.1', '1.1.1.2'])
    attempts[1]?.resolve('second')
    expect(await outcome).toBe('second')
    expect(attempts[0]?.signal.aborted).toBe(true)
  })

  it('starts the next address at once when one fails fast', async () => {
    const { attempts, race } = harness()
    const outcome = race(['1.1.1.1', '1.1.1.2'])
    attempts[0]?.reject(fail('unreachable', 'refused'))
    await vi.advanceTimersByTimeAsync(0)
    expect(attempts).toHaveLength(2)
    attempts[1]?.resolve('second')
    expect(await outcome).toBe('second')
  })

  it('rejects with the last error when every address fails before the deadline', async () => {
    const { attempts, race } = harness()
    const outcome = race(['1.1.1.1', '1.1.1.2']).catch((error: unknown) => error)
    attempts[0]?.reject(fail('unreachable', 'first'))
    await vi.advanceTimersByTimeAsync(0)
    attempts[1]?.reject(fail('unreachable', 'second'))
    expect(await outcome).toMatchObject({ code: 'unreachable', message: 'second' })
  })

  it('discards a loser that connects after the race was won', async () => {
    const { attempts, discarded, race } = harness()
    const outcome = race(['1.1.1.1', '1.1.1.2'])
    await vi.advanceTimersByTimeAsync(250)
    attempts[1]?.resolve('winner')
    expect(await outcome).toBe('winner')
    attempts[0]?.resolve('loser')
    await vi.advanceTimersByTimeAsync(0)
    expect(discarded).toEqual(['loser'])
  })

  it('stops at a fatal error and tries no further address', async () => {
    const handshake = fail('unreachable', 'handshake failed')
    const { attempts, race } = harness({ isFatal: (error) => error === handshake })
    const outcome = race(['1.1.1.1', '1.1.1.2']).catch((error: unknown) => error)
    attempts[0]?.reject(handshake)
    expect(await outcome).toBe(handshake)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(attempts).toHaveLength(1)
  })

  it('rejects revoked and aborts every attempt when the signal aborts mid-race', async () => {
    const { attempts, controller, race } = harness()
    const outcome = race(['1.1.1.1', '1.1.1.2']).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(250)
    controller.abort()
    expect(await outcome).toMatchObject({ code: 'revoked' })
    expect(attempts.every((attempt) => attempt.signal.aborted)).toBe(true)
  })

  it('rejects revoked without starting an attempt when the signal is already aborted', async () => {
    const { attempts, controller, race } = harness()
    controller.abort()
    await expect(race(['1.1.1.1'])).rejects.toMatchObject({ code: 'revoked' })
    expect(attempts).toHaveLength(0)
  })

  it('rejects unreachable for an empty address list', async () => {
    const { race } = harness()
    await expect(race([])).rejects.toMatchObject({ code: 'unreachable' })
  })
})
