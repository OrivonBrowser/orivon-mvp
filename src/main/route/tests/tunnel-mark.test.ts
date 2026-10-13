import { describe, expect, it } from 'vitest'
import { tunnelMarkFor } from '../tunnel-mark.js'

describe('what the key says about the page and the tunnel', () => {
  it('says nothing for a page that is not on the tunnel', () => {
    expect(tunnelMarkFor({ state: 'off', temporary: false })).toBeNull()
  })

  it('says on for a page whose traffic goes through the tunnel, whether or not it has used it yet, a Web3 name included', () => {
    expect(tunnelMarkFor({ state: 'ok', temporary: false })).toBe('on')
    expect(tunnelMarkFor({ state: 'idle', temporary: false })).toBe('on')
  })

  it('says down when the page is on the tunnel and the tunnel does not carry it', () => {
    expect(tunnelMarkFor({ state: 'down', temporary: false })).toBe('down')
    expect(tunnelMarkFor({ state: 'no-proxy', temporary: false })).toBe('down')
  })

  it('says on for a page in a temporary session opened through the tunnel', () => {
    expect(tunnelMarkFor({ state: 'off', temporary: true })).toBe('on')
  })
})
