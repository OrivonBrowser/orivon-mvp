// The test seam that names the DNS-over-HTTPS server: present in a test build, absent in an ordinary one.

import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function load (enabled: boolean) {
  if (enabled) vi.stubGlobal('__ORIVON_DEV_GRANT_ENABLED__', true)
  vi.resetModules()
  return await import('../name-relay-test-seam.js')
}

describe('the DNS-over-HTTPS address a test names', () => {
  it('is read in a test build, when it is an https address', async () => {
    const { dohUrlOverride } = await load(true)
    expect(dohUrlOverride({ ORIVON_TEST_NAME_RELAY_DOH_URL: 'https://fake-doh.test/dns-query' })).toBe('https://fake-doh.test/dns-query')
    expect(dohUrlOverride({})).toBeUndefined()
    expect(dohUrlOverride({ ORIVON_TEST_NAME_RELAY_DOH_URL: 'http://fake-doh.test/dns-query' })).toBeUndefined()
    expect(dohUrlOverride({ ORIVON_TEST_NAME_RELAY_DOH_URL: 'not an address' })).toBeUndefined()
  })

  it('is never read in an ordinary build', async () => {
    const { dohUrlOverride } = await load(false)
    expect(dohUrlOverride({ ORIVON_TEST_NAME_RELAY_DOH_URL: 'https://fake-doh.test/dns-query' })).toBeUndefined()
  })
})
