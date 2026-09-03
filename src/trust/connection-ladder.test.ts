import { describe, expect, it } from 'vitest'
import { connectionLadder } from './connection-ladder.js'
import type { ConnectionLogEntry, ConnectionLogInput, OmittedConnectPattern } from './connection-log.js'

// THE INVARIANT UNDER TEST, throughout: the raw evidence (counts, bytes,
// blocked attempts) is never absent, and the pattern classification never
// appears without it -- that is what keeps this module from being the
// overclaiming trap ADR-0006 was rewritten to prevent. Every test that
// checks `patternHeuristic` also checks `evidence` in the same case, so a
// future edit that starts returning the heuristic alone breaks visibly here.

function entry (overrides: Partial<ConnectionLogEntry> = {}): ConnectionLogEntry {
  return {
    surface: 'tcp.connect',
    grantedPattern: 'api.example.com:443',
    target: 'api.example.com:443',
    resolvedAddress: '93.184.216.34',
    outcome: 'allowed',
    observedAt: 1_700_000_000_000,
    ...overrides
  }
}

function input (entries: readonly ConnectionLogEntry[], omitted: readonly OmittedConnectPattern[] = []): ConnectionLogInput {
  return { entries, omittedConnectPatterns: omitted }
}

describe('connectionLadder -- empty and base cases', () => {
  it('no entries at all: zero evidence, insufficient-data classification, no omissions', () => {
    const result = connectionLadder(input([]))
    expect(result.evidence).toEqual({
      distinctHostsContacted: 0,
      totalAttempts: 0,
      allowedAttempts: 0,
      blockedAddressRangeAttempts: 0,
      blockedPolicyAttempts: 0,
      errorAttempts: 0,
      totalBytesSent: 0,
      totalBytesReceived: 0,
      longestConnectionMs: null,
      allAllowedWereGranted: true
    })
    expect(result.patternHeuristic).toEqual({
      class: 'insufficient-data',
      basis: 'heuristic',
      byteFlowSymmetric: null
    })
    expect(result.omittedConnectPatterns).toEqual([])
  })

  it('fs/id entries with no resolved address are counted but never counted as a "host"', () => {
    const result = connectionLadder(input([
      entry({ surface: 'fs', target: '/downloads/a.txt', resolvedAddress: null, grantedPattern: null }),
      entry({ surface: 'id', target: 'nostr-key-1', resolvedAddress: null, grantedPattern: null })
    ]))
    expect(result.evidence.totalAttempts).toBe(2)
    expect(result.evidence.allowedAttempts).toBe(2)
    expect(result.evidence.distinctHostsContacted).toBe(0)
  })
})

describe('connectionLadder -- raw counts (evidence, always primary)', () => {
  it('counts distinct hosts by resolved address, not by target string', () => {
    const result = connectionLadder(input([
      entry({ target: 'a.example:443', resolvedAddress: '10.0.0.1' }),
      // Same resolved address as above, different requested target -- still one host.
      entry({ target: 'a-alias.example:443', resolvedAddress: '10.0.0.1' }),
      entry({ target: 'b.example:443', resolvedAddress: '10.0.0.2' })
    ]))
    expect(result.evidence.distinctHostsContacted).toBe(2)
  })

  it('classifies every outcome into its own counter', () => {
    const result = connectionLadder(input([
      entry({ outcome: 'allowed' }),
      entry({ outcome: 'allowed' }),
      entry({ outcome: 'blocked-address-range', resolvedAddress: '127.0.0.1' }),
      entry({ outcome: 'blocked-policy' }),
      entry({ outcome: 'error' })
    ]))
    expect(result.evidence.totalAttempts).toBe(5)
    expect(result.evidence.allowedAttempts).toBe(2)
    expect(result.evidence.blockedAddressRangeAttempts).toBe(1)
    expect(result.evidence.blockedPolicyAttempts).toBe(1)
    expect(result.evidence.errorAttempts).toBe(1)
  })

  it('a blocked-address-range attempt is evidence T12 worked, not silently dropped', () => {
    const result = connectionLadder(input([
      entry({ outcome: 'blocked-address-range', resolvedAddress: '169.254.1.1', target: 'evil.example:80' })
    ]))
    expect(result.evidence.blockedAddressRangeAttempts).toBe(1)
    // The blocked attempt still resolved to a host -- but it must not count
    // as a host the app successfully "reached".
    expect(result.evidence.distinctHostsContacted).toBe(0)
  })

  it('sums bytesSent/bytesReceived across entries, treating missing values as zero', () => {
    const result = connectionLadder(input([
      entry({ bytesSent: 100, bytesReceived: 40 }),
      entry({ bytesSent: 50 }), // bytesReceived omitted
      entry() // neither present
    ]))
    expect(result.evidence.totalBytesSent).toBe(150)
    expect(result.evidence.totalBytesReceived).toBe(40)
  })

  it('longestConnectionMs is the max durationMs seen, or null if none were recorded', () => {
    const withDurations = connectionLadder(input([
      entry({ durationMs: 500 }),
      entry({ durationMs: 12_000 }),
      entry({ durationMs: 3_000 })
    ]))
    expect(withDurations.evidence.longestConnectionMs).toBe(12_000)

    const withoutDurations = connectionLadder(input([entry(), entry()]))
    expect(withoutDurations.evidence.longestConnectionMs).toBeNull()
  })

  it('allAllowedWereGranted is false when any ALLOWED attempt has no granted pattern and the surface is a net surface', () => {
    const result = connectionLadder(input([
      entry({ outcome: 'allowed', grantedPattern: 'api.example.com:443' }),
      entry({ outcome: 'allowed', grantedPattern: null, surface: 'tcp.connect' })
    ]))
    expect(result.evidence.allAllowedWereGranted).toBe(false)
  })

  it('allAllowedWereGranted ignores fs/id surfaces, which carry no pattern concept', () => {
    const result = connectionLadder(input([
      entry({ outcome: 'allowed', grantedPattern: 'api.example.com:443' }),
      entry({ outcome: 'allowed', grantedPattern: null, surface: 'fs', target: '/x', resolvedAddress: null }),
      entry({ outcome: 'allowed', grantedPattern: null, surface: 'id', target: 'key-1', resolvedAddress: null })
    ]))
    expect(result.evidence.allAllowedWereGranted).toBe(true)
  })

  it('allAllowedWereGranted ignores non-allowed attempts entirely', () => {
    const result = connectionLadder(input([
      entry({ outcome: 'blocked-policy', grantedPattern: null })
    ]))
    expect(result.evidence.allAllowedWereGranted).toBe(true)
  })
})

describe('connectionLadder -- omitted connect patterns (A43)', () => {
  it('passes omittedConnectPatterns through unchanged -- never silently dropped', () => {
    const omitted: OmittedConnectPattern[] = [
      { pattern: '*:*', reason: 'unenumerable-hosts' },
      { pattern: null, reason: 'other' }
    ]
    const result = connectionLadder(input([], omitted))
    expect(result.omittedConnectPatterns).toEqual(omitted)
  })

  it('a non-empty omission list does not by itself change the pattern classification', () => {
    // Omission is a fact about what COULD NOT be observed, not a fact about
    // what WAS observed -- it must not silently read as "nothing happened".
    const withOmission = connectionLadder(input([], [{ pattern: '*:*', reason: 'unenumerable-hosts' }]))
    const withoutOmission = connectionLadder(input([]))
    expect(withOmission.patternHeuristic).toEqual(withoutOmission.patternHeuristic)
    expect(withOmission.omittedConnectPatterns).not.toEqual(withoutOmission.omittedConnectPatterns)
  })
})

describe('connectionLadder -- pattern heuristic classification', () => {
  it('few distinct hosts classifies as single-server', () => {
    const result = connectionLadder(input([
      entry({ resolvedAddress: '10.0.0.1' }),
      entry({ resolvedAddress: '10.0.0.1' }),
      entry({ resolvedAddress: '10.0.0.1' })
    ]))
    expect(result.patternHeuristic.class).toBe('single-server')
  })

  it('many distinct hosts with symmetric byte flow classifies as swarm', () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry({ resolvedAddress: `10.0.0.${i}`, bytesSent: 1000, bytesReceived: 900 }))
    const result = connectionLadder(input(entries))
    expect(result.patternHeuristic.class).toBe('swarm')
    expect(result.patternHeuristic.byteFlowSymmetric).toBe(true)
  })

  it('many distinct hosts with asymmetric byte flow (exfiltration shape) is never labelled swarm', () => {
    // The exact case ADR-0006's amendment names: many short connections to
    // many distinct hosts, but sending far more than is received back.
    const entries = Array.from({ length: 10 }, (_, i) =>
      entry({ resolvedAddress: `10.0.0.${i}`, bytesSent: 100_000, bytesReceived: 10 }))
    const result = connectionLadder(input(entries))
    expect(result.patternHeuristic.class).not.toBe('swarm')
    expect(result.patternHeuristic.byteFlowSymmetric).toBe(false)
  })

  it('many distinct hosts with no byte data at all is "mixed", not "swarm" -- absence of data is not evidence of symmetry', () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry({ resolvedAddress: `10.0.0.${i}` }))
    const result = connectionLadder(input(entries))
    expect(result.patternHeuristic.class).not.toBe('swarm')
    expect(result.patternHeuristic.byteFlowSymmetric).toBeNull()
  })

  it('zero allowed attempts (all blocked) is insufficient-data, never single-server', () => {
    const result = connectionLadder(input([
      entry({ outcome: 'blocked-policy' }),
      entry({ outcome: 'blocked-address-range', resolvedAddress: '127.0.0.1' })
    ]))
    expect(result.patternHeuristic.class).toBe('insufficient-data')
  })

  it('the heuristic never ships without the evidence it was computed from, on every branch above', () => {
    for (const entries of [
      [],
      [entry()],
      Array.from({ length: 10 }, (_, i) => entry({ resolvedAddress: `10.0.0.${i}` }))
    ]) {
      const result = connectionLadder(input(entries))
      expect(result.evidence).toBeDefined()
      expect(result.patternHeuristic.basis).toBe('heuristic')
    }
  })
})
