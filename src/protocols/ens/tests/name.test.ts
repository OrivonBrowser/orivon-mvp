import { describe, expect, it } from 'vitest'
import { ensNameFromHost } from '../name.js'

describe('ensNameFromHost', () => {
  it('accepts a normalised .eth host, with or without a trailing dot', () => {
    expect(ensNameFromHost('vitalik.eth')).toBe('vitalik.eth')
    expect(ensNameFromHost('app.ens.eth')).toBe('app.ens.eth')
    expect(ensNameFromHost('vitalik.eth.')).toBe('vitalik.eth')
  })

  it('refuses a host that is not a .eth name', () => {
    for (const host of ['example.com', 'eth', '.eth', 'vitalik.eth.com']) {
      expect(() => ensNameFromHost(host)).toThrow(expect.objectContaining({ failure: 'invalid-name' }))
    }
  })

  it('refuses a host ENSIP-15 would change, so one origin is one name', () => {
    expect(() => ensNameFromHost('Vitalik.eth')).toThrow(expect.objectContaining({ failure: 'invalid-name' }))
  })

  it('refuses a name ENSIP-15 rejects outright', () => {
    for (const host of ['a..eth', 'ab_c.eth', 'a​b.eth']) {
      expect(() => ensNameFromHost(host)).toThrow(expect.objectContaining({ failure: 'invalid-name' }))
    }
  })

  it('refuses an internationalised host in punycode form', () => {
    expect(() => ensNameFromHost('xn--vitlik-6qa.eth')).toThrow(expect.objectContaining({ failure: 'invalid-name' }))
  })
})
