// The address race behind ./node-adapters.ts's `dialTcp` and ./tls-adapter.ts's
// `createDialTls`: pure scheduling, no Node I/O, so a test drives it with fake
// timers and a fake attempt. See README.md's Design notes for why one deadline
// bounds the whole dial.

import { fail } from '../errors.js'

export interface RaceOptions<T> {
  /** The grant's own abort: withdrawing it ends the race and every attempt. */
  readonly signal: AbortSignal
  /** One bound for the whole race, however many addresses are tried. */
  readonly deadlineMs: number
  /** How long an attempt runs alone before the next address starts beside it. */
  readonly staggerMs: number
  readonly timeoutError: () => Error
  /** A failure the next address would share (a TLS handshake the server answered): it ends the race instead of starting another attempt. */
  readonly isFatal?: (error: unknown) => boolean
  /** Releases an attempt that connected after another had already won. */
  readonly discard: (value: T) => void | Promise<void>
}

/** Alternates address families, the resolver's first family first, so one family that drops packets never holds up the other. */
export function interleaveFamilies (addresses: readonly string[]): string[] {
  const isV6 = (address: string): boolean => address.includes(':')
  const v6 = addresses.filter(isV6)
  const v4 = addresses.filter((address) => !isV6(address))
  const [first, second] = addresses[0] !== undefined && isV6(addresses[0]) ? [v6, v4] : [v4, v6]
  const merged: string[] = []
  for (let i = 0; i < Math.max(first.length, second.length); i++) {
    if (first[i] !== undefined) merged.push(first[i] as string)
    if (second[i] !== undefined) merged.push(second[i] as string)
  }
  return merged
}

/**
 * First attempt to succeed wins and every other is aborted. Each `attempt`
 * must reject once its signal aborts, or its promise is left pending.
 */
export async function raceAddresses<T> (
  addresses: readonly string[],
  attempt: (address: string, signal: AbortSignal) => Promise<T>,
  options: RaceOptions<T>
): Promise<T> {
  const { signal, deadlineMs, staggerMs, timeoutError, isFatal, discard } = options
  const revoked = (): Error => fail('revoked', 'the grant authorising this connection was withdrawn')
  if (signal.aborted) throw revoked()

  const queue = interleaveFamilies(addresses)
  return await new Promise<T>((resolve, reject) => {
    const running = new Set<AbortController>()
    let settled = false
    let lastError: unknown
    let staggerTimer: NodeJS.Timeout | undefined

    const finish = (): void => {
      settled = true
      clearTimeout(deadlineTimer)
      clearTimeout(staggerTimer)
      signal.removeEventListener('abort', onAbort)
      for (const controller of running) controller.abort()
    }
    const abandon = (error: unknown): void => { finish(); reject(error) }
    const onAbort = (): void => { abandon(revoked()) }

    const startNext = (): void => {
      clearTimeout(staggerTimer)
      if (settled) return
      const address = queue.shift()
      if (address === undefined) {
        if (running.size === 0) abandon(lastError ?? fail('unreachable', 'no address to connect to'))
        return
      }
      const controller = new AbortController()
      running.add(controller)
      attempt(address, controller.signal).then(
        (value) => {
          running.delete(controller)
          if (settled) { Promise.resolve(discard(value)).catch(() => {}); return }
          finish()
          resolve(value)
        },
        (error: unknown) => {
          running.delete(controller)
          if (settled) return
          lastError = error
          if (isFatal?.(error) === true) { abandon(error); return }
          startNext()
        }
      )
      if (queue.length > 0) staggerTimer = setTimeout(startNext, staggerMs)
    }

    const deadlineTimer = setTimeout(() => { abandon(timeoutError()) }, deadlineMs)
    deadlineTimer.unref()
    signal.addEventListener('abort', onAbort, { once: true })
    startNext()
  })
}
