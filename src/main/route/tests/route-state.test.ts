import { describe, expect, it } from 'vitest'
import { entryFor, isTunnelKind, tunnelStateOf } from '../route-state.js'

describe('the tunnel state of an origin', () => {
  it('follows the default when the origin has no entry: off, or the default tunnel while the whole browser is on one', () => {
    expect(tunnelStateOf(undefined, false, 'nym')).toBe('off')
    expect(tunnelStateOf(undefined, false, 'socks5')).toBe('off')
    expect(tunnelStateOf(undefined, true, 'nym')).toBe('nym')
    expect(tunnelStateOf(undefined, true, 'socks5')).toBe('socks5')
  })

  it('takes its own entry over the default, either way, and over the default tunnel', () => {
    expect(tunnelStateOf('nym', false, 'socks5')).toBe('nym')
    expect(tunnelStateOf('off', true, 'nym')).toBe('off')
    expect(tunnelStateOf('socks5', true, 'nym')).toBe('socks5')
    expect(tunnelStateOf('off', false, 'nym')).toBe('off')
  })
})

describe('the entry that makes a website go through a tunnel or off', () => {
  it('is none when the default already says so, so the website goes back to the default session', () => {
    expect(entryFor('off', false, 'nym')).toBeUndefined()
    expect(entryFor('nym', true, 'nym')).toBeUndefined()
    expect(entryFor('socks5', true, 'socks5')).toBeUndefined()
  })

  it('is the state itself when it differs from the default, the other tunnel included', () => {
    expect(entryFor('nym', false, 'nym')).toBe('nym')
    expect(entryFor('socks5', false, 'nym')).toBe('socks5')
    expect(entryFor('off', true, 'nym')).toBe('off')
    expect(entryFor('socks5', true, 'nym')).toBe('socks5')
    expect(entryFor('nym', true, 'socks5')).toBe('nym')
  })
})

describe('the tunnels', () => {
  it('are nym and socks5, and nothing else', () => {
    expect(['nym', 'socks5'].every(isTunnelKind)).toBe(true)
    for (const other of ['off', 'on', 'tor', '', undefined, null, 1]) expect(isTunnelKind(other), String(other)).toBe(false)
  })
})
