import { describe, expect, it } from 'vitest'
import { tunnelLookFor, tunnelMarkFor } from '../tunnel-mark.js'

describe('what the tunnel button says about the page', () => {
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

describe('what the tunnel button says about the tunnel the page goes through', () => {
  it('names the tunnel of the page\'s own origin', () => {
    expect(tunnelLookFor({ state: 'ok', temporary: false, own: 'socks5', session: 'socks5' })).toEqual({ mark: 'on', via: 'socks5' })
    expect(tunnelLookFor({ state: 'down', temporary: false, own: 'nym', session: 'nym' })).toEqual({ mark: 'down', via: 'nym' })
    expect(tunnelLookFor({ state: 'off', temporary: false, own: undefined, session: undefined })).toEqual({ mark: null, via: null })
  })

  it('names the tunnel of the session when it is not the origin\'s: a popup adopted into an app\'s session goes where the app does', () => {
    expect(tunnelLookFor({ state: 'off', temporary: false, own: undefined, session: 'nym' })).toEqual({ mark: 'on', via: 'nym' })
    expect(tunnelLookFor({ state: 'no-proxy', temporary: false, own: 'socks5', session: 'nym' }), 'the origin\'s own state says nothing about a session it does not run in').toEqual({ mark: 'on', via: 'nym' })
  })

  it('names the tunnel of a temporary session', () => {
    expect(tunnelLookFor({ state: 'off', temporary: true, own: undefined, session: 'socks5' })).toEqual({ mark: 'on', via: 'socks5' })
  })

  it('says down, not on, for a page of a tunnelled origin whose session is not pointed at any tunnel: it is not on the tunnel yet', () => {
    expect(tunnelLookFor({ state: 'idle', temporary: false, own: 'nym', session: undefined })).toEqual({ mark: 'down', via: 'nym' })
    expect(tunnelLookFor({ state: 'ok', temporary: false, own: 'socks5', session: undefined })).toEqual({ mark: 'down', via: 'socks5' })
    expect(tunnelLookFor({ state: 'off', temporary: false, own: undefined, session: undefined }), 'an origin with no tunnel has nothing to wait for').toEqual({ mark: null, via: null })
  })

  it('leaves a session held shut out of it: the origin\'s own tunnel and state are what is said', () => {
    expect(tunnelLookFor({ state: 'ok', temporary: false, own: 'nym', session: 'held' })).toEqual({ mark: 'on', via: 'nym' })
  })
})
