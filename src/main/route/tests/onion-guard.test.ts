import { describe, expect, it } from 'vitest'
import { createOnionRefusals, onionRefused } from '../onion-guard.js'

describe('which sessions carry an onion address', () => {
  it('is only a session that goes through the person\'s own SOCKS5 tunnel', () => {
    expect(onionRefused('http://abc.onion/', 'socks5')).toBe(false)
    expect(onionRefused('wss://abc.onion/s', 'socks5')).toBe(false)
  })

  it('refuses it in every other session: no tunnel, Nym, and one that is stopped', () => {
    for (const via of [undefined, 'nym', 'held'] as const) {
      expect(onionRefused('http://abc.onion/', via), String(via)).toBe(true)
      expect(onionRefused('https://abc.onion./a', via), String(via)).toBe(true)
      expect(onionRefused('ws://ABC.ONION/s', via), String(via)).toBe(true)
    }
  })

  it('leaves every other address alone, whatever the session', () => {
    for (const via of [undefined, 'nym', 'held', 'socks5'] as const) {
      expect(onionRefused('https://example.com/abc.onion', via), String(via)).toBe(false)
      expect(onionRefused('http://127.0.0.1:3000/', via), String(via)).toBe(false)
    }
  })
})

describe('the onion loads a tab was refused, which the sheet over it explains', () => {
  it('claims the address that was refused in that tab, once', () => {
    const refusals = createOnionRefusals()
    refusals.note(7, 'http://abc.onion/')
    expect(refusals.claims(8, 'http://abc.onion/')).toBe(false)
    expect(refusals.claims(7, 'http://other.onion/')).toBe(false)
    expect(refusals.claims(7, 'http://abc.onion/')).toBe(true)
    expect(refusals.claims(7, 'http://abc.onion/')).toBe(false)
  })

  it('remembers the newest refusal of a tab, and a bounded number of tabs', () => {
    const refusals = createOnionRefusals(2)
    refusals.note(1, 'http://a.onion/')
    refusals.note(1, 'http://b.onion/')
    expect(refusals.claims(1, 'http://a.onion/')).toBe(false)
    expect(refusals.claims(1, 'http://b.onion/')).toBe(true)
    refusals.note(1, 'http://a.onion/')
    refusals.note(2, 'http://a.onion/')
    refusals.note(3, 'http://a.onion/')
    expect(refusals.claims(1, 'http://a.onion/')).toBe(false)
    expect(refusals.claims(3, 'http://a.onion/')).toBe(true)
  })

  it('notes nothing for a request that belongs to no tab', () => {
    const refusals = createOnionRefusals()
    refusals.note(undefined, 'http://abc.onion/')
    expect(refusals.claims(0, 'http://abc.onion/')).toBe(false)
  })
})
