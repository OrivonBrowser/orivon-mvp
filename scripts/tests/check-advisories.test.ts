import { describe, expect, it } from 'vitest'
import { gateAdvisories } from '../check-advisories.mjs'

const advisory = (id: string, name: string, severity: string): Record<string, unknown> =>
  ({ source: 1, name, title: `${name} issue`, url: `https://github.com/advisories/${id}`, severity })

/** An `npm audit --json` report: one package carrying the advisory, one more reaching it through that package. */
const report = (vias: Array<Record<string, unknown>>, counts: Record<string, number>): unknown => ({
  vulnerabilities: {
    'http-cache-semantics': { name: 'http-cache-semantics', severity: 'high', via: vias },
    'cacheable-request': { name: 'cacheable-request', severity: 'high', via: ['http-cache-semantics'] }
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...counts } }
})

const accepted = new Map([['GHSA-aaaa-bbbb-cccc', 'reason']])

/** The ids of a list the gate returned; an error result has none. */
const ids = (list: ReadonlyArray<{ id: string }> | undefined): string[] => (list ?? []).map((finding) => finding.id)

describe('gateAdvisories', () => {
  it('lets an accepted advisory through, and the packages it arrives through with it', () => {
    const gate = gateAdvisories(report([advisory('GHSA-aaaa-bbbb-cccc', 'http-cache-semantics', 'high')], { high: 2 }), accepted)
    expect(gate.error).toBeUndefined()
    expect(ids(gate.blocking)).toEqual([])
    expect(ids(gate.accepted)).toEqual(['GHSA-aaaa-bbbb-cccc'])
  })

  it('still blocks another high advisory in the same package', () => {
    const gate = gateAdvisories(report([
      advisory('GHSA-aaaa-bbbb-cccc', 'http-cache-semantics', 'high'),
      advisory('GHSA-dddd-eeee-ffff', 'http-cache-semantics', 'critical')
    ], { high: 2, critical: 1 }), accepted)
    expect(ids(gate.blocking)).toEqual(['GHSA-dddd-eeee-ffff'])
  })

  it('never blocks below high', () => {
    const gate = gateAdvisories(report([advisory('GHSA-1111-2222-3333', 'elliptic', 'low')], { low: 1 }), new Map())
    expect(gate.error).toBeUndefined()
    expect(ids(gate.blocking)).toEqual([])
  })

  it('fails closed on a report with no counts, or counts that list no advisory', () => {
    expect(gateAdvisories({}).error).toMatch(/no vulnerability counts/)
    expect(gateAdvisories({ metadata: { vulnerabilities: { high: 3 } } }).error).toMatch(/listed none/)
  })
})
