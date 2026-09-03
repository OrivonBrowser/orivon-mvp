import { describe, expect, it } from 'vitest'
import { scoreOperations } from './operation-scoring.js'
import type { ConnectionLogEntry } from './connection-log.js'

// THE INVARIANT UNDER TEST: this module counts and classifies -- it never
// returns a single number, and it never pre-computes a narrative claim
// ("fully trustless operation") on the caller's behalf. That judgement is
// the click-through UI's job (scope item 5); this only has to make the
// counts a UI needs to say it itself.

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

describe('scoreOperations -- empty input', () => {
  it('no entries: empty breakdown, zero total', () => {
    const result = scoreOperations([])
    expect(result.bySurface).toEqual([])
    expect(result.totalOperations).toBe(0)
  })
})

describe('scoreOperations -- per-surface counts', () => {
  it('groups by surface and counts each outcome independently', () => {
    const result = scoreOperations([
      entry({ surface: 'fs', outcome: 'allowed', grantedPattern: null, target: '/a', resolvedAddress: null }),
      entry({ surface: 'fs', outcome: 'allowed', grantedPattern: null, target: '/b', resolvedAddress: null }),
      entry({ surface: 'fs', outcome: 'blocked-policy', grantedPattern: null, target: '/c', resolvedAddress: null }),
      entry({ surface: 'id', outcome: 'allowed', grantedPattern: null, target: 'key-1', resolvedAddress: null }),
      entry({ surface: 'tcp.connect', outcome: 'error' })
    ])

    const fs = result.bySurface.find((s) => s.surface === 'fs')
    expect(fs).toEqual({ surface: 'fs', allowed: 2, blockedAddressRange: 0, blockedPolicy: 1, error: 0 })

    const id = result.bySurface.find((s) => s.surface === 'id')
    expect(id).toEqual({ surface: 'id', allowed: 1, blockedAddressRange: 0, blockedPolicy: 0, error: 0 })

    const tcp = result.bySurface.find((s) => s.surface === 'tcp.connect')
    expect(tcp).toEqual({ surface: 'tcp.connect', allowed: 0, blockedAddressRange: 0, blockedPolicy: 0, error: 1 })

    expect(result.totalOperations).toBe(5)
  })

  it('a surface that never appears in the entries is absent from bySurface, not present with zero counts', () => {
    const result = scoreOperations([entry({ surface: 'fs', grantedPattern: null, resolvedAddress: null })])
    expect(result.bySurface.map((s) => s.surface)).toEqual(['fs'])
    expect(result.bySurface.some((s) => s.surface === 'id')).toBe(false)
  })

  it('blocked-address-range is counted separately from blocked-policy, per surface', () => {
    const result = scoreOperations([
      entry({ surface: 'tcp.connect', outcome: 'blocked-address-range', resolvedAddress: '127.0.0.1' }),
      entry({ surface: 'tcp.connect', outcome: 'blocked-policy' })
    ])
    const tcp = result.bySurface.find((s) => s.surface === 'tcp.connect')
    expect(tcp).toEqual({ surface: 'tcp.connect', allowed: 0, blockedAddressRange: 1, blockedPolicy: 1, error: 0 })
  })

  it('totalOperations counts every entry across every surface', () => {
    const result = scoreOperations([
      entry({ surface: 'fs', grantedPattern: null, resolvedAddress: null }),
      entry({ surface: 'id', grantedPattern: null, resolvedAddress: null }),
      entry({ surface: 'tcp.connect' }),
      entry({ surface: 'udp.send' })
    ])
    expect(result.totalOperations).toBe(4)
  })
})
