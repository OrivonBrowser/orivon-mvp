import { describe, expect, it } from 'vitest'

const { withIsolationHeaders } = await import('../granted-origin-csp.js')

// An origin granted without installing gets the isolation headers its
// manifest asks for on its documents, through the same handler that appends
// the CSP (granted-origin-csp.test.ts's own "adds the isolation headers..."
// and "keeps the policy and skips isolation..." tests cover that
// composition; this file is just withIsolationHeaders on its own). The
// server's own weaker values are replaced, not kept beside: two COOP values
// do not intersect the way two CSPs do.

describe('withIsolationHeaders', () => {
  it('adds both headers and keeps everything else', () => {
    expect(withIsolationHeaders({ 'Content-Type': ['text/html'] })).toEqual({
      'Content-Type': ['text/html'],
      'cross-origin-opener-policy': ['same-origin'],
      'cross-origin-embedder-policy': ['credentialless']
    })
  })

  it('replaces the server\'s own values, under any spelling', () => {
    expect(withIsolationHeaders({ 'Cross-Origin-Opener-Policy': ['unsafe-none'], 'Cross-Origin-Embedder-Policy': ['unsafe-none'] })).toEqual({
      'cross-origin-opener-policy': ['same-origin'],
      'cross-origin-embedder-policy': ['credentialless']
    })
  })
})
