import { describe, expect, it } from 'vitest'
import { fold, type TelemetryEvent } from '../accounting.js'
import {
  MAX_REPORTED_SITES, PAYLOAD_SCHEMA, buildErasePayload, buildSitesPayload, buildUsagePayload, hasSites, initialConsentState, mayTransmit
} from '../disclosure.js'

const t0 = Date.UTC(2026, 8, 1, 0, 0, 0)
const SEC = 1000
const meta = { installId: 'ab'.repeat(16), stream: 'cd'.repeat(16), country: 'IT' as const, version: '0.1.0', period: '2026-09' }

function browsing (): ReturnType<typeof fold> {
  const events: TelemetryEvent[] = [
    { kind: 'session-start', atMs: t0, app: 'shell' },
    { kind: 'focus', atMs: t0, app: 'shell' },
    { kind: 'site', atMs: t0, site: 'web3:vitalik.eth' },
    { kind: 'interaction', atMs: t0 },
    { kind: 'interaction', atMs: t0 + 50 * SEC },
    { kind: 'site', atMs: t0 + 100 * SEC, site: 'web25:app.example.org' },
    { kind: 'interaction', atMs: t0 + 150 * SEC },
    { kind: 'site', atMs: t0 + 200 * SEC, site: 'web2' },
    { kind: 'interaction', atMs: t0 + 250 * SEC },
    { kind: 'site', atMs: t0 + 300 * SEC, site: 'web3:' },
    { kind: 'interaction', atMs: t0 + 310 * SEC },
    { kind: 'blur', atMs: t0 + 320 * SEC },
    { kind: 'checkpoint', atMs: t0 + 400 * SEC }
  ]
  return fold(events)
}

describe('buildUsagePayload', () => {
  it('is the schema 4 usage report: the shell totals, the class split, no site names', () => {
    const payload = buildUsagePayload(browsing(), meta)
    expect(payload).toEqual({
      schema: PAYLOAD_SCHEMA, installId: meta.installId, stream: meta.stream, country: 'IT', version: '0.1.0', period: '2026-09',
      activeSec: 320, backgroundSec: 80, classes: { web3: 120, web25: 100, web2: 100 }
    })
    expect(PAYLOAD_SCHEMA).toBe(4)
  })

  it('carries no site name: those travel in the sites report, sent under the same install ID', () => {
    expect('sites' in buildUsagePayload(browsing(), meta)).toBe(false)
  })

  it('counts the browser own pages in activeSec and in no class', () => {
    const state = fold([
      { kind: 'session-start', atMs: t0, app: 'shell' }, { kind: 'focus', atMs: t0, app: 'shell' }, { kind: 'interaction', atMs: t0 },
      { kind: 'checkpoint', atMs: t0 + 60 * SEC }
    ])
    expect(buildUsagePayload(state, meta)).toMatchObject({ activeSec: 60, classes: { web3: 0, web25: 0, web2: 0 } })
  })

  it('rounds fractional seconds to whole seconds and is all zeros for a profile with nothing counted', () => {
    const state = fold([
      { kind: 'session-start', atMs: t0, app: 'shell' }, { kind: 'focus', atMs: t0, app: 'shell' }, { kind: 'interaction', atMs: t0 },
      { kind: 'checkpoint', atMs: t0 + 1600 }
    ])
    expect(buildUsagePayload(state, meta).activeSec).toBe(2)
    expect(buildUsagePayload(fold([]), meta)).toMatchObject({ activeSec: 0, backgroundSec: 0, classes: { web3: 0, web25: 0, web2: 0 } })
  })
})

describe('buildSitesPayload', () => {
  it('names only Web3 and Web2.5 sites, with an empty name reading (unlisted), under the install ID and stream', () => {
    const payload = buildSitesPayload(browsing(), { installId: meta.installId, stream: meta.stream, version: '0.1.0', period: '2026-09' })
    expect(payload).toEqual({
      schema: PAYLOAD_SCHEMA, installId: meta.installId, stream: meta.stream, version: '0.1.0', period: '2026-09',
      sites: { 'web3:vitalik.eth': 100, 'web25:app.example.org': 100, 'web3:(unlisted)': 20 }
    })
    expect(Object.keys(payload)).toEqual(['schema', 'installId', 'stream', 'version', 'period', 'sites'])
  })

  it('has no sites for a period with none, and says so', () => {
    expect(hasSites(buildSitesPayload(fold([]), { installId: 'x', stream: 'y', version: '1', period: '2026-09' }))).toBe(false)
    expect(hasSites(buildSitesPayload(browsing(), { installId: 'x', stream: 'y', version: '1', period: '2026-09' }))).toBe(true)
  })

  it('folds the smallest names into (unlisted) rather than send more than the cap', () => {
    const perSite: Record<string, number> = {}
    for (let i = 0; i < MAX_REPORTED_SITES + 40; i += 1) perSite[`web3:site${String(i)}.eth`] = 1000 - i
    const state = { ...fold([]), perSite: { '2026-09': perSite } }
    const sites = buildSitesPayload(state, { installId: 'x', stream: 'y', version: '1', period: '2026-09' }).sites
    expect(Object.keys(sites).length).toBeLessThanOrEqual(MAX_REPORTED_SITES)
    expect(sites['web3:site0.eth']).toBe(1000)
    expect(sites['web3:site399.eth']).toBeUndefined()
    const total = Object.values(sites).reduce((sum, seconds) => sum + seconds, 0)
    expect(total).toBe(Object.values(perSite).reduce((sum, seconds) => sum + seconds, 0))
  })
})

describe('buildErasePayload', () => {
  it('carries the schema and the install ID, nothing else', () => {
    expect(buildErasePayload('ab'.repeat(16))).toEqual({ schema: PAYLOAD_SCHEMA, installId: 'ab'.repeat(16) })
  })
})

describe('mayTransmit: nothing before the choice', () => {
  it('is true only once the person accepted; undecided is a state of its own', () => {
    expect(initialConsentState).toBe('undecided')
    expect(mayTransmit('undecided')).toBe(false)
    expect(mayTransmit('declined')).toBe(false)
    expect(mayTransmit('accepted')).toBe(true)
  })
})
