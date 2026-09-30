import { describe, expect, it } from 'vitest'
import { ANY_ADDRESS, LOOPBACK_ADDRESS, bindAddressFor, bindCapabilitiesFor, chooseBindGrant, isBindScope } from '../bind-scope.js'
import type { BindScope } from '../../../contracts/index.js'

describe('isBindScope', () => {
  it('accepts exactly local and network', () => {
    expect(isBindScope('local')).toBe(true)
    expect(isBindScope('network')).toBe(true)
  })

  it.each([undefined, null, '', 'Local', 'NETWORK', 'lan', ' local', 0, true, {}, ['local'], { toString: () => 'local' }])(
    'refuses %j',
    (value) => { expect(isBindScope(value)).toBe(false) }
  )
})

describe('bindAddressFor', () => {
  it('binds loopback for local and every interface for network', () => {
    expect(bindAddressFor('local')).toBe(LOOPBACK_ADDRESS)
    expect(LOOPBACK_ADDRESS).toBe('127.0.0.1')
    expect(bindAddressFor('network')).toBe(ANY_ADDRESS)
    expect(ANY_ADDRESS).toBe('0.0.0.0')
  })

  it('narrows, never widens, on a value that is neither scope', () => {
    for (const wrong of [undefined, null, 'lan', 'NETWORK', 1, {}]) {
      expect(bindAddressFor(wrong as unknown as BindScope)).toBe('127.0.0.1')
    }
  })
})

describe('bindCapabilitiesFor', () => {
  it('lets a local bind ride either grant, the narrower first', () => {
    expect(bindCapabilitiesFor('tcp.listen', 'local')).toEqual(['tcp.listen.local', 'tcp.listen.network'])
    expect(bindCapabilitiesFor('udp.bind', 'local')).toEqual(['udp.bind.local', 'udp.bind.network'])
  })

  it('lets a network bind ride the network grant alone', () => {
    expect(bindCapabilitiesFor('tcp.listen', 'network')).toEqual(['tcp.listen.network'])
    expect(bindCapabilitiesFor('udp.bind', 'network')).toEqual(['udp.bind.network'])
  })
})

describe('chooseBindGrant', () => {
  const local = { id: 'local', patterns: ['30000-30010'] }
  const network = { id: 'network', patterns: ['30005-30020'] }

  it('prefers the first grant whose ports cover the port', () => {
    expect(chooseBindGrant([local, network], 30006)?.grant).toBe(local)
  })

  it('falls to a later grant only for a port the earlier one does not cover', () => {
    const chosen = chooseBindGrant([local, network], 30015)
    expect(chosen?.grant).toBe(network)
    expect(chosen?.ranges).toEqual([{ lo: 30015, hi: 30015 }])
  })

  it('answers undefined when no grant covers the port, or there is none', () => {
    expect(chooseBindGrant([local, network], 40000)).toBeUndefined()
    expect(chooseBindGrant([], 30000)).toBeUndefined()
  })

  it('port 0 lands in the FIRST usable grant\'s ranges only, never the union', () => {
    const chosen = chooseBindGrant([local, network], 0)
    expect(chosen?.grant).toBe(local)
    expect(chosen?.ranges).toEqual([{ lo: 30000, hi: 30010 }])
  })

  it('skips a grant checkBind refuses outright (privileged range, wildcard) and uses the next', () => {
    const privileged = { id: 'p', patterns: ['80'] }
    expect(chooseBindGrant([privileged, network], 30006)?.grant).toBe(network)
  })
})
