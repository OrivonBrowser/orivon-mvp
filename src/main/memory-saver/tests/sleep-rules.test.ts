import { describe, expect, it } from 'vitest'
import { BATTERY_SLEEP_MS, canSleep, delayFor, dueToSleep, hostKept, SLEEP_AFTER_MS } from '../sleep-rules.js'
import type { SleepFacts, SleepWhy } from '../sleep-rules.js'

const AWAKE_OK: SleepFacts = {
  active: false, splitPartner: false, pinned: false, audible: false, capturing: false, mediaInUse: false, pendingAsk: false,
  crashed: false, devtools: false, newTab: false, internal: false, app: false, partitioned: false, loading: false,
  unrestorable: false, keepAwakeHost: false, unsaved: false
}

describe('canSleep', () => {
  it('lets an ordinary idle tab sleep', () => {
    expect(canSleep(AWAKE_OK)).toEqual({ ok: true })
  })

  const REFUSALS: ReadonlyArray<[keyof SleepFacts, SleepWhy]> = [
    ['active', 'active'], ['splitPartner', 'split'], ['pinned', 'pinned'], ['audible', 'sound'], ['capturing', 'media'],
    ['mediaInUse', 'media'], ['pendingAsk', 'ask'], ['unsaved', 'unsaved'], ['crashed', 'crashed'], ['devtools', 'devtools'],
    ['newTab', 'new-tab'], ['internal', 'internal'], ['app', 'app'], ['partitioned', 'partition'], ['loading', 'loading'],
    ['unrestorable', 'address'], ['keepAwakeHost', 'kept']
  ]
  it.each(REFUSALS)('keeps a tab awake while %s', (fact, why) => {
    expect(canSleep({ ...AWAKE_OK, [fact]: true })).toEqual({ ok: false, why })
  })

  it('tells the reason the person would most want to hear when several apply', () => {
    expect(canSleep({ ...AWAKE_OK, pinned: true, audible: true, unsaved: true })).toEqual({ ok: false, why: 'pinned' })
    expect(canSleep({ ...AWAKE_OK, audible: true, pendingAsk: true })).toEqual({ ok: false, why: 'sound' })
    expect(canSleep({ ...AWAKE_OK, pendingAsk: true, unsaved: true })).toEqual({ ok: false, why: 'ask' })
    expect(canSleep({ ...AWAKE_OK, app: true, loading: true })).toEqual({ ok: false, why: 'app' })
  })
})

describe('hostKept', () => {
  const list = 'example.com\n  Docs.Test \n\n'
  it('matches a listed site and its subdomains, in any case', () => {
    expect(hostKept('example.com', list)).toBe(true)
    expect(hostKept('mail.example.com', list)).toBe(true)
    expect(hostKept('A.B.EXAMPLE.COM', list)).toBe(true)
    expect(hostKept('docs.test', list)).toBe(true)
  })

  it('does not match a site that only ends the same way', () => {
    expect(hostKept('notexample.com', list)).toBe(false)
    expect(hostKept('example.com.evil.test', list)).toBe(false)
    expect(hostKept('com', list)).toBe(false)
  })

  it('matches nothing for an empty list or an empty host', () => {
    expect(hostKept('example.com', '')).toBe(false)
    expect(hostKept('example.com', '\n \n')).toBe(false)
    expect(hostKept('', '\n')).toBe(false)
  })
})

describe('delayFor', () => {
  const on = { memorySaver: true, sleepAfter: '1h', energySaver: 'off' }

  it('is the chosen wait while the memory saver is on', () => {
    for (const [value, ms] of Object.entries(SLEEP_AFTER_MS)) expect(delayFor({ ...on, sleepAfter: value }, false)).toBe(ms)
    expect(SLEEP_AFTER_MS['15m']).toBe(900_000)
    expect(SLEEP_AFTER_MS['4h']).toBe(14_400_000)
  })

  it('falls back to thirty minutes for a value it does not know', () => {
    expect(delayFor({ ...on, sleepAfter: 'soon' }, false)).toBe(SLEEP_AFTER_MS['30m'])
  })

  it('is nothing while the memory saver is off and the energy saver does not apply', () => {
    expect(delayFor({ ...on, memorySaver: false }, false)).toBeNull()
    expect(delayFor({ ...on, memorySaver: false }, true)).toBeNull()
    expect(delayFor({ ...on, memorySaver: false, energySaver: 'battery' }, false)).toBeNull()
  })

  it('shortens the wait to five minutes on battery with the energy saver on, and never lengthens it', () => {
    expect(delayFor({ ...on, energySaver: 'battery' }, true)).toBe(BATTERY_SLEEP_MS)
    expect(delayFor({ ...on, energySaver: 'battery' }, false)).toBe(SLEEP_AFTER_MS['1h'])
    expect(delayFor({ memorySaver: true, sleepAfter: '15m', energySaver: 'battery' }, true)).toBe(BATTERY_SLEEP_MS)
    expect(delayFor({ ...on, energySaver: 'off' }, true)).toBe(SLEEP_AFTER_MS['1h'])
  })

  it('puts tabs to sleep on battery even when the memory saver is off', () => {
    expect(delayFor({ ...on, memorySaver: false, energySaver: 'battery' }, true)).toBe(BATTERY_SLEEP_MS)
  })
})

describe('dueToSleep', () => {
  it('is due once the wait has passed, to the millisecond', () => {
    expect(dueToSleep(1000, 1000 + 900_000 - 1, 900_000)).toBe(false)
    expect(dueToSleep(1000, 1000 + 900_000, 900_000)).toBe(true)
  })

  it('is not due for a tab never seen in front', () => {
    expect(dueToSleep(undefined, 10 ** 12, 1)).toBe(false)
  })
})
