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
  it('is the tunnel itself whatever the default says, so a pick lives in its tunnel\'s profile and never follows a later default', () => {
    for (const everywhere of [false, true]) {
      expect(entryFor('nym', everywhere), `nym ${String(everywhere)}`).toBe('nym')
      expect(entryFor('socks5', everywhere), `socks5 ${String(everywhere)}`).toBe('socks5')
    }
  })

  it('is none for going through no tunnel while the whole browser is not on one, so the website goes back to the default session', () => {
    expect(entryFor('off', false)).toBeUndefined()
  })

  it('is off for going through no tunnel while the whole browser is on one', () => {
    expect(entryFor('off', true)).toBe('off')
  })
})

describe('the tunnels', () => {
  it('are nym and socks5, and nothing else', () => {
    expect(['nym', 'socks5'].every(isTunnelKind)).toBe(true)
    for (const other of ['off', 'on', 'tor', '', undefined, null, 1]) expect(isTunnelKind(other), String(other)).toBe(false)
  })
})
