// How long a file is retried for depends on who serves it: a verifier-served name (a `.eth` name, an IPFS address) has gateways, a
// light client and possibly a mixnet behind it, and its faults outlast the pauses of a plain https host.

import { describe, expect, it } from 'vitest'
import { RETRY_BACKOFF_MS, VERIFIER_RETRY_BACKOFF_MS, retryBackoffFor } from '../retry.js'

describe('retryBackoffFor', () => {
  it('gives a verifier-served name the long pauses', () => {
    expect(retryBackoffFor('https://webtorrent.orivonstack.eth')).toBe(VERIFIER_RETRY_BACKOFF_MS)
  })

  it('gives any other origin the short ones', () => {
    expect(retryBackoffFor('https://example.com')).toBe(RETRY_BACKOFF_MS)
  })

  it('keeps what a test passes in', () => {
    expect(retryBackoffFor('https://webtorrent.orivonstack.eth', [1, 1])).toEqual([1, 1])
  })

  it('waits at least as long as a verifier restart or a tunnel replaced', () => {
    expect(VERIFIER_RETRY_BACKOFF_MS.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(40_000)
    expect(VERIFIER_RETRY_BACKOFF_MS.length).toBeGreaterThan(RETRY_BACKOFF_MS.length)
  })
})
