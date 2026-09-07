// `capabilities.net.concurrentSockets` validation (open-questions.md A80).
// ./manifest.test.ts is at the Rule 2 test-file limit, so this file takes the
// new field rather than growing it past 800 lines.

import { describe, expect, it } from 'vitest'
import { parseManifest } from '../manifest.js'

function manifestWith (net: unknown): unknown {
  return {
    orivonApiVersion: 0,
    id: 'app.test',
    name: 'Test',
    version: '1.0.0',
    entry: 'index.html',
    capabilities: { net }
  }
}

function parsed (net: unknown): { concurrentSockets?: number } {
  const result = parseManifest(JSON.stringify(manifestWith(net)))
  if (!result.ok) throw new Error(`expected the manifest to parse, and it was rejected: ${result.reason}`)
  return result.manifest.capabilities.net ?? {}
}

function rejection (net: unknown): string {
  const result = parseManifest(JSON.stringify(manifestWith(net)))
  if (result.ok) throw new Error('expected the manifest to be rejected, and it parsed instead')
  return result.reason
}

describe('capabilities.net.concurrentSockets', () => {
  it('is accepted as a positive integer', () => {
    expect(parsed({ concurrentSockets: 200 }).concurrentSockets).toBe(200)
  })

  it('is optional -- omitting it is not an error', () => {
    expect(parsed({}).concurrentSockets).toBeUndefined()
  })

  it('sits alongside tcp and udp rather than replacing them', () => {
    const outcome = parseManifest(JSON.stringify(manifestWith({ concurrentSockets: 12, tcp: { connect: ['*:*'] } })))
    if (!outcome.ok) throw new Error(outcome.reason)
    expect(outcome.manifest.capabilities.net?.concurrentSockets).toBe(12)
    expect(outcome.manifest.capabilities.net?.tcp?.connect).toEqual(['*:*'])
  })

  it('rejects a non-number', () => {
    expect(rejection({ concurrentSockets: '200' })).toContain('concurrentSockets')
  })

  it('rejects a fraction', () => {
    expect(rejection({ concurrentSockets: 1.5 })).toContain('integer')
  })

  it('rejects zero and negatives -- absence is how you say "none"', () => {
    expect(rejection({ concurrentSockets: 0 })).toContain('positive')
    expect(rejection({ concurrentSockets: -5 })).toContain('positive')
  })

  it('rejects Infinity and NaN', () => {
    expect(rejection({ concurrentSockets: Number.POSITIVE_INFINITY })).toContain('finite')
    expect(rejection({ concurrentSockets: Number.NaN })).toContain('finite')
  })

  it('ACCEPTS a number above the platform ceiling -- the broker clamps it', () => {
    // Deliberate, and the reason is in contracts/manifest.ts: rejecting here
    // would turn a later change to LIMITS.concurrentSockets into a breaking
    // change for every manifest that had declared the old ceiling.
    expect(parsed({ concurrentSockets: 100_000 }).concurrentSockets).toBe(100_000)
  })

  it('still rejects an unrecognised sibling field, so the new key did not widen the object', () => {
    expect(rejection({ concurrentSockets: 12, wat: 1 })).toContain('unrecognised')
  })
})
