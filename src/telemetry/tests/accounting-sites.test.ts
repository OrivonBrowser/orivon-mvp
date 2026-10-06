import { describe, expect, it } from 'vitest'
import { fold, pruneSitePeriods, siteSeconds, totalsFor, type TelemetryEvent } from '../accounting.js'

const t0 = Date.UTC(2026, 8, 1, 0, 0, 0)
const SEC = 1000

function browse (extra: TelemetryEvent[]): TelemetryEvent[] {
  return [
    { kind: 'session-start', atMs: t0, app: 'shell' },
    { kind: 'focus', atMs: t0, app: 'shell' },
    { kind: 'interaction', atMs: t0 },
    ...extra
  ]
}

describe('active time by site', () => {
  it('credits the active seconds to the site in front, and none to the site left behind', () => {
    const state = fold(browse([
      { kind: 'site', atMs: t0, site: 'web3:vitalik.eth' },
      { kind: 'interaction', atMs: t0 + 40 * SEC },
      { kind: 'site', atMs: t0 + 60 * SEC, site: 'web2' },
      { kind: 'interaction', atMs: t0 + 100 * SEC },
      { kind: 'checkpoint', atMs: t0 + 120 * SEC }
    ]))
    expect(siteSeconds(state, '2026-09', 'web3:vitalik.eth')).toBe(60)
    expect(siteSeconds(state, '2026-09', 'web2')).toBe(60)
  })

  it('counts time before any tab reports as internal', () => {
    const state = fold(browse([{ kind: 'checkpoint', atMs: t0 + 30 * SEC }]))
    expect(siteSeconds(state, '2026-09', 'internal')).toBe(30)
  })

  it('stops crediting a site when the window loses focus or the person goes idle, as activeSec does', () => {
    const state = fold(browse([
      { kind: 'site', atMs: t0, site: 'web25:app.example.org' },
      { kind: 'blur', atMs: t0 + 20 * SEC },
      { kind: 'checkpoint', atMs: t0 + 200 * SEC }
    ]))
    expect(siteSeconds(state, '2026-09', 'web25:app.example.org')).toBe(20)
    expect(totalsFor(state, 'shell', '2026-09')).toEqual({ activeSec: 20, backgroundSec: 180 })
  })

  it('keeps the site keys of a period adding up to the shell activeSec for any event stream', () => {
    const sites = ['web3:a.eth', 'web25:b.org', 'web2', 'internal', 'web3:']
    let seed = 7
    const next = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
    const events: TelemetryEvent[] = [{ kind: 'session-start', atMs: t0, app: 'shell' }]
    let at = t0
    for (let step = 0; step < 400; step += 1) {
      at += Math.floor(next() * 90 * SEC)
      const pick = next()
      if (pick < 0.25) events.push({ kind: 'site', atMs: at, site: sites[Math.floor(next() * sites.length)] ?? 'web2' })
      else if (pick < 0.45) events.push({ kind: 'interaction', atMs: at })
      else if (pick < 0.6) events.push({ kind: 'focus', atMs: at, app: 'shell' })
      else if (pick < 0.7) events.push({ kind: 'blur', atMs: at })
      else if (pick < 0.75) events.push({ kind: 'suspend', atMs: at })
      else if (pick < 0.8) events.push({ kind: 'resume', atMs: at })
      else events.push({ kind: 'checkpoint', atMs: at })
    }
    events.push({ kind: 'checkpoint', atMs: at + 3600 * SEC })
    const state = fold(events, undefined, 2 * 60 * SEC)
    for (const period of Object.keys(state.perApp['shell'] ?? {})) {
      const bySite = Object.values(state.perSite[period] ?? {}).reduce((sum, seconds) => sum + seconds, 0)
      expect(bySite).toBeCloseTo(totalsFor(state, 'shell', period).activeSec, 6)
    }
    expect(totalsFor(state, 'shell', '2026-09').activeSec).toBeGreaterThan(0)
  })

  it('splits a stretch across a month boundary into each month own site totals', () => {
    const lastMinute = Date.UTC(2026, 8, 30, 23, 59, 0)
    const state = fold([
      { kind: 'session-start', atMs: lastMinute, app: 'shell' },
      { kind: 'focus', atMs: lastMinute, app: 'shell' },
      { kind: 'site', atMs: lastMinute, site: 'web3:a.eth' },
      { kind: 'interaction', atMs: lastMinute },
      { kind: 'checkpoint', atMs: lastMinute + 120 * SEC }
    ])
    expect(siteSeconds(state, '2026-09', 'web3:a.eth')).toBe(60)
    expect(siteSeconds(state, '2026-10', 'web3:a.eth')).toBe(60)
  })
})

describe('pruneSitePeriods', () => {
  it('keeps only the newest periods of the site split', () => {
    const state = { ...fold([]), perSite: { '2026-05': { web2: 1 }, '2026-06': { web2: 2 }, '2026-07': { web2: 3 }, '2026-08': { web2: 4 } } }
    expect(Object.keys(pruneSitePeriods(state, 2).perSite)).toEqual(['2026-07', '2026-08'])
    expect(pruneSitePeriods(state, 9)).toBe(state)
  })
})
