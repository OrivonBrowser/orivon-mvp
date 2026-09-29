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
})

describe('GENERIC_PROXY_PROBE_URL', () => {
  it('is a plain https URL over a reserved, never-dialled domain', () => {
    expect(GENERIC_PROXY_PROBE_URL).toBe('https://example.com/')
  })
})
