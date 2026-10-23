import { runInThisContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_LEAD_MS, clockJump, clockLead, heliosClockLead, installHeliosClock, measureClockLead, resetHeliosClock, setHeliosClockLead } from '../clock.js'
import type { ClockReading } from '../clock.js'

afterEach(() => { resetHeliosClock() })

/** A server whose clock is `ahead` ms in front of the local one, answered instantly at local time `at`. */
const reading = (ahead: number, at = 1_800_000_000_000): ClockReading => ({ serverMs: Math.floor((at + ahead) / 1000) * 1000, sentAt: at, receivedAt: at })

describe('clockLead', () => {
  it('is the median of several servers, with the half second a Date header drops', () => {
    // 60 s behind: each server's header is truncated to the second, so half a second is added back.
    expect(clockLead([reading(60_000), reading(60_100), reading(59_900)])).toBeGreaterThan(59_000)
    expect(clockLead([reading(60_000), reading(60_100), reading(59_900)])).toBeLessThan(61_000)
  })

  it('is 0 for servers that agree the clock is right, or ahead: measured, and not behind', () => {
    expect(clockLead([reading(0), reading(300), reading(-200)])).toBe(0)
    expect(clockLead([reading(-90_000), reading(-90_000)])).toBe(0)
  })

  it('is nothing from fewer than two servers: one server is not a reference', () => {
    expect(clockLead([])).toBeUndefined()
    expect(clockLead([reading(60_000)])).toBeUndefined()
  })

  it('is nothing when the servers disagree with each other and no majority agrees', () => {
    expect(clockLead([reading(60_000), reading(5 * 60_000)])).toBeUndefined()
    expect(clockLead([reading(60_000), reading(5 * 60_000), reading(20 * 60_000)])).toBeUndefined()
  })

  it('leaves out a server that is off by itself while a majority agrees', () => {
    const lead = clockLead([reading(60_000), reading(60_300), reading(59_800), reading(3 * 3_600_000)])
    expect(lead).toBeGreaterThan(59_000)
    expect(lead).toBeLessThan(61_000)
  })

  it('needs a majority of all the servers, not of the ones that agree: two of four is not enough', () => {
    expect(clockLead([reading(60_000), reading(60_300), reading(5 * 60_000), reading(20 * 60_000)])).toBeUndefined()
  })

  it('counts the majority over the servers asked, not the ones that answered', () => {
    const agreeing = [reading(60_000), reading(60_300)]
    expect(clockLead(agreeing, 4)).toBeUndefined()
    expect(clockLead(agreeing, 3)).toBeGreaterThan(59_000)
    expect(clockLead([...agreeing, reading(59_800)], 4)).toBeGreaterThan(59_000)
  })

  it('is nothing for a lead no mistake in a clock would explain', () => {
    expect(clockLead([reading(MAX_LEAD_MS + 60_000), reading(MAX_LEAD_MS + 60_000)])).toBeUndefined()
    expect(clockLead([reading(14 * 3_600_000), reading(14 * 3_600_000)])).toBeGreaterThan(13 * 3_600_000)
  })

  it('takes the middle of the round trip as the moment the server answered', () => {
    const slow: ClockReading = { serverMs: 1_800_000_060_000, sentAt: 1_800_000_000_000, receivedAt: 1_800_000_004_000 }
    expect(clockLead([slow, slow])).toBe(58_500)
  })
})

describe('measureClockLead', () => {
  const at = Date.now()
  const answering = (ahead: Record<string, number | 'no-header' | 'down'>) => async (url: string): Promise<Response> => {
    const origin = new URL(url).origin
    const how = ahead[origin]
    if (how === 'down' || how === undefined) throw new Error('no route')
    return new Response(null, how === 'no-header' ? {} : { headers: { date: new Date(Math.floor((at + how) / 1000) * 1000).toUTCString() } })
  }

  it('asks each origin once with a HEAD and reads their Date headers', async () => {
    const asked: string[] = []
    const fetch = async (url: string, init?: RequestInit): Promise<Response> => { asked.push(`${init?.method ?? 'GET'} ${url}`); return await answering({ 'https://a.example': 30_000, 'https://b.example': 30_000 })(url) }
    const lead = await measureClockLead(['https://a.example/beacon', 'https://b.example', 'https://b.example/other'], fetch, () => at)
    expect(asked.sort()).toEqual(['HEAD https://a.example/', 'HEAD https://b.example/'])
    expect(lead).toBeGreaterThan(29_000)
  })

  it('ignores a server that is down or sends no Date header, and needs a majority of those asked to answer', async () => {
    const some = answering({ 'https://a.example': 30_000, 'https://b.example': 'no-header', 'https://c.example': 'down', 'https://d.example': 30_000, 'https://e.example': 30_000 })
    expect(await measureClockLead(['https://a.example', 'https://b.example', 'https://d.example', 'https://e.example'], some, () => at)).toBeGreaterThan(29_000)
    expect(await measureClockLead(['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example'], some, () => at)).toBeUndefined()
    expect(await measureClockLead(['https://a.example', 'https://b.example', 'https://c.example'], some, () => at)).toBeUndefined()
    expect(await measureClockLead(['https://a.example', 'https://c.example'], some, () => at)).toBeUndefined()
  })
})

describe('the clock lent to Helios', () => {
  /** A function that reads the time from a file path inside the Helios package, as its WebAssembly glue does. */
  const fromHelios = runInThisContext('(function __wbg_now () { return Date.now() })', { filename: '/app/node_modules/@a16z/helios/dist/lib.mjs' }) as () => number
  const fromElsewhere = runInThisContext('(function certificateValidFrom () { return Date.now() })', { filename: '/app/out/main/verifier-host.js' }) as () => number

  it('is read by Helios and by nothing else in the process', () => {
    installHeliosClock()
    setHeliosClockLead(120_000)
    const before = Date.now()
    expect(fromHelios() - before).toBeGreaterThan(119_000)
    expect(fromHelios() - before).toBeLessThan(121_000)
    expect(Math.abs(fromElsewhere() - before)).toBeLessThan(1_000)
    expect(Math.abs(Date.now() - before)).toBeLessThan(1_000)
  })

  it('is read by Helios on Windows, where the path of its frame has backslashes', () => {
    const onWindows = runInThisContext('(function __wbg_now () { return Date.now() })', { filename: 'C:\\Users\\a\\AppData\\Local\\Programs\\Orivon\\resources\\app.asar\\node_modules\\@a16z\\helios\\dist\\lib.mjs' }) as () => number
    installHeliosClock()
    setHeliosClockLead(120_000)
    expect(onWindows() - Date.now()).toBeGreaterThan(119_000)
  })

  it('changes nothing while no lead is set', () => {
    installHeliosClock()
    expect(Math.abs(fromHelios() - Date.now())).toBeLessThan(1_000)
  })

  it('is installed once, and again if something replaced Date.now', () => {
    installHeliosClock()
    const first = Date.now
    installHeliosClock()
    expect(Date.now).toBe(first)
    const realNow = Date.now
    const replaced = (): number => 5
    Date.now = replaced
    try {
      installHeliosClock()
      expect(Date.now).not.toBe(replaced)
      setHeliosClockLead(1_000_000)
      expect(fromHelios()).toBe(5 + 1_000_000)
      expect(fromElsewhere()).toBe(5)
    } finally {
      resetHeliosClock()
      Date.now = realNow
    }
  })

  it('is put back by the reset', () => {
    const real = Date.now
    installHeliosClock()
    resetHeliosClock()
    expect(Date.now).toBe(real)
  })

  it('refuses a lead that is not a positive number, and caps one that is too large', () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY, 0]) { setHeliosClockLead(bad); expect(heliosClockLead()).toBe(0) }
    setHeliosClockLead(MAX_LEAD_MS * 3)
    expect(heliosClockLead()).toBe(MAX_LEAD_MS)
  })
})

describe('clockJump', () => {
  it('is 0 on the first call and while the clocks move together', () => {
    expect(clockJump()).toBe(0)
    expect(clockJump()).toBe(0)
  })

  it('is positive when the system clock is set forward by more than a few seconds, once', () => {
    installHeliosClock()
    expect(clockJump()).toBe(0)
    const real = Date.now
    try {
      Date.now = () => real() + 60_000
      installHeliosClock()
      expect(clockJump()).toBeGreaterThan(55_000)
      expect(clockJump()).toBe(0)
    } finally {
      resetHeliosClock()
      Date.now = real
    }
  })

  it('is negative when the system clock is set back', () => {
    installHeliosClock()
    expect(clockJump()).toBe(0)
    const real = Date.now
    try {
      Date.now = () => real() - 60_000
      installHeliosClock()
      expect(clockJump()).toBeLessThan(-55_000)
      expect(clockJump()).toBe(0)
    } finally {
      resetHeliosClock()
      Date.now = real
    }
  })
})
