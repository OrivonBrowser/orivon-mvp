import { afterEach, describe, expect, it } from 'vitest'
import { provideVerifierAccess } from '../../verifier/verifier-access.js'
import { gatewayEntries, gatewayRedirectFor } from '../eth-gateway-rule.js'

afterEach(() => { provideVerifierAccess({ start: () => {}, ready: async () => {} }) })

describe('gatewayRedirectFor', () => {
  const on = { get: () => true }
  const off = { get: () => false }
  const serves = (): boolean => true

  it('gives the .eth address when the setting is on, the address is a gateway one and the name loads', () => {
    expect(gatewayRedirectFor(on, 'https://vitalik.eth.limo/a?b=1#c', serves)).toBe('https://vitalik.eth/a?b=1#c')
  })

  it('gives nothing without settings, with the setting off, for a non-gateway address, or for a name that does not load', () => {
    expect(gatewayRedirectFor(undefined, 'https://vitalik.eth.limo/', serves)).toBeUndefined()
    expect(gatewayRedirectFor(off, 'https://vitalik.eth.limo/', serves)).toBeUndefined()
    expect(gatewayRedirectFor(on, 'https://example.com/', serves)).toBeUndefined()
    expect(gatewayRedirectFor(on, 'https://www.eth.limo/', serves)).toBeUndefined()
    expect(gatewayRedirectFor(on, 'https://vitalik.eth.limo/', () => false)).toBeUndefined()
  })

  it('asks the verifier by default, which holds no name before it is started', () => {
    expect(gatewayRedirectFor(on, 'https://vitalik.eth.limo/')).toBeUndefined()
  })
})

describe('gatewayEntries', () => {
  const on = { get: () => true }

  it('maps a gateway entry to its .eth address and keeps its other fields and every other entry', () => {
    const entries = [{ url: 'https://example.com/', title: 'A' }, { url: 'https://site.eth.limo/p?q=1#f', title: 'B' }]
    expect(gatewayEntries(on, entries, () => true)).toEqual([entries[0], { url: 'https://site.eth/p?q=1#f', title: 'B' }])
  })

  it('leaves every entry as it is when the setting is off or nothing can load the name', () => {
    const entries = [{ url: 'https://site.eth.limo/', title: '' }]
    expect(gatewayEntries({ get: () => false }, entries, () => true)).toEqual(entries)
    expect(gatewayEntries(on, entries, () => false)).toEqual(entries)
    expect(gatewayEntries(undefined, entries, () => true)).toEqual(entries)
  })
})
