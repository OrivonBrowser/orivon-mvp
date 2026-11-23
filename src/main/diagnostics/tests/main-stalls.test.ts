import { describe, expect, it } from 'vitest'
import { LOGGED_STALL_MS, LONG_STALL_MS, MAX_STALL_MS, NO_STALLS, StallMonitor, STALL_LINES_PER_MINUTE, STALL_MS, STALL_TICK_MS } from '../main-stalls.js'

function monitor () {
  let clock = 1_000_000
  const lines: string[] = []
  const stalls = new StallMonitor({ now: () => clock, log: (line) => { lines.push(line) } })
  /** The timer's next run, `lateMs` after it was due. */
  const tick = (lateMs: number): void => { clock += STALL_TICK_MS + lateMs; stalls.tick() }
  const pass = (ms: number): void => { clock += ms }
  return { stalls, lines, tick, pass }
}

describe('StallMonitor', () => {
  it('counts nothing while the timer runs on time or a little late', () => {
    const { stalls, tick } = monitor()
    for (const late of [0, 3, 40, STALL_MS - 1]) tick(late)
    expect(stalls.counts()).toEqual(NO_STALLS)
  })

  it('counts a stall of 1 s, but not one of 5 s, in the first count only, and keeps the longest', () => {
    const { stalls, tick } = monitor()
    tick(STALL_MS)
    expect(stalls.counts()).toEqual({ over1s: 1, over5s: 0, longestMs: STALL_MS })
    tick(LONG_STALL_MS - 1)
    expect(stalls.counts()).toEqual({ over1s: 2, over5s: 0, longestMs: LONG_STALL_MS - 1 })
    tick(LONG_STALL_MS)
    expect(stalls.counts()).toEqual({ over1s: 3, over5s: 1, longestMs: LONG_STALL_MS })
    tick(1200)
    expect(stalls.counts()).toEqual({ over1s: 4, over5s: 1, longestMs: LONG_STALL_MS })
  })

  it('reads a stall as the delay beyond the interval and rounds to whole milliseconds', () => {
    const { stalls, pass } = monitor()
    pass(STALL_TICK_MS + 1500.4)
    stalls.tick()
    expect(stalls.counts().longestMs).toBe(1500)
  })

  it('does not count a delay as long as the computer asleep', () => {
    const { stalls, tick } = monitor()
    tick(MAX_STALL_MS)
    tick(MAX_STALL_MS + 3_600_000)
    expect(stalls.counts()).toEqual(NO_STALLS)
    tick(MAX_STALL_MS - 1)
    expect(stalls.counts().over1s).toBe(1)
  })

  it('writes one line for a stall of 2 s or more, with its length and its number, and none for a shorter one', () => {
    const { stalls, lines, tick } = monitor()
    tick(LOGGED_STALL_MS - 1)
    expect(lines).toEqual([])
    tick(LOGGED_STALL_MS)
    tick(7300)
    expect(lines).toEqual([
      '[orivon] The main process did not answer for about 2.0 s (stall 1 of 2 s or more in this run).',
      '[orivon] The main process did not answer for about 7.3 s (stall 2 of 2 s or more in this run).'
    ])
    expect(stalls.counts().over1s).toBe(3)
  })

  it('writes at most a few lines a minute, counts every stall, and writes again in the next minute', () => {
    const { stalls, lines, tick, pass } = monitor()
    for (let n = 0; n < STALL_LINES_PER_MINUTE + 5; n += 1) { tick(LOGGED_STALL_MS); pass(1000) }
    expect(lines).toHaveLength(STALL_LINES_PER_MINUTE)
    expect(stalls.counts().over1s).toBe(STALL_LINES_PER_MINUTE + 5)
    pass(60_000)
    tick(LOGGED_STALL_MS)
    expect(lines).toHaveLength(STALL_LINES_PER_MINUTE + 1)
    expect(lines.at(-1)).toContain(`stall ${String(STALL_LINES_PER_MINUTE + 6)} of 2 s`)
  })
})
