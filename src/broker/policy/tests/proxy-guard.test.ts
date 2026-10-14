// proxyProbeUrl/GENERIC_PROXY_PROBE_URL -- the URL-building half of T20's
// fail-closed check (security-model.md, docs/open-questions.md A263). The
// probe itself is exercised against a real caching wrapper in
// ../../transport/tests/proxy-probe.test.ts, and end to end (per net
// capability, denying and allowing) in ../../tests/net-proxy-guard.test.ts.

import { describe, expect, it } from 'vitest'
import { GENERIC_PROXY_PROBE_URL, proxyProbeUrl } from '../proxy-guard.js'

describe('proxyProbeUrl', () => {
  it('names host and port as an ordinary https authority', () => {
    expect(proxyProbeUrl('api.example.com', 443)).toBe('https://api.example.com:443/')
  })
  it('brackets an IPv6 host, the way a URL authority requires', () => {
    expect(proxyProbeUrl('2606:4700::1111', 443)).toBe('https://[2606:4700::1111]:443/')
  })
  it('omits the port for a lookup, which names no port at all', () => {
    expect(proxyProbeUrl('api.example.com')).toBe('https://api.example.com/')
  })
  it('accepts the longest DNS name and answers null for one byte more', () => {
    const longest = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`
    expect(longest).toHaveLength(253)
    expect(proxyProbeUrl(longest, 443)).toBe(`https://${longest}:443/`)
    expect(proxyProbeUrl(`${longest}e`, 443)).toBeNull()
  })
  it('answers null for a host the URL would have to escape or that carries more than an address', () => {
    for (const host of ['', 'a/b', 'a b', 'a@b', 'a?b', 'a#b', 'a:443/x', 'caf\u00e9.example', 'a'.repeat(128 * 1024)]) {
      expect(proxyProbeUrl(host, 443), host.slice(0, 20)).toBeNull()
    }
    expect(proxyProbeUrl(42 as unknown as string, 443)).toBeNull()
  })
  it('answers null for a port that is not a port number', () => {
    for (const port of [-1, 65536, 1.5, Number.NaN, '443' as unknown as number]) {
      expect(proxyProbeUrl('api.example.com', port)).toBeNull()
    }
  })
})

describe('GENERIC_PROXY_PROBE_URL', () => {
  it('is a plain https URL over a reserved, never-dialled domain', () => {
    expect(GENERIC_PROXY_PROBE_URL).toBe('https://example.com/')
  })
})
