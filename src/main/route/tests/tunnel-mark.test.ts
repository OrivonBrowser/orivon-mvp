import { describe, expect, it } from 'vitest'
import { tunnelMarkFor } from '../tunnel-mark.js'

describe('what the key says about the page and the tunnel', () => {
  it('says nothing for a page that is not on the tunnel', () => {
    expect(tunnelMarkFor({ state: 'off', temporary: false, web3: false })).toBeNull()
    expect(tunnelMarkFor({ state: 'off', temporary: false, web3: true })).toBeNull()
  })

  it('says on for a page whose traffic goes through the tunnel, whether or not it has used it yet', () => {
    expect(tunnelMarkFor({ state: 'ok', temporary: false, web3: false })).toBe('on')
    expect(tunnelMarkFor({ state: 'idle', temporary: false, web3: false })).toBe('on')
  })

  it('says partial, never on, for a Web3 name, whose own files Orivon fetches outside the tunnel', () => {
    expect(tunnelMarkFor({ state: 'ok', temporary: false, web3: true })).toBe('partial')
    expect(tunnelMarkFor({ state: 'idle', temporary: false, web3: true })).toBe('partial')
  })

  it('says down when the page is on the tunnel and the tunnel does not carry it, Web3 or not', () => {
    for (const web3 of [false, true]) {
      expect(tunnelMarkFor({ state: 'down', temporary: false, web3 })).toBe('down')
      expect(tunnelMarkFor({ state: 'no-proxy', temporary: false, web3 })).toBe('down')
    }
  })

  it('says on for a page in a temporary session opened through the tunnel', () => {
    expect(tunnelMarkFor({ state: 'off', temporary: true, web3: false })).toBe('on')
  })
})
