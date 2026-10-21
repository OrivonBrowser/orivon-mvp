// checkRoutedConnect: the grant check for a connection through a route. A name
// is matched as a name and never resolved here; an address literal keeps every
// address-class rule checkConnect applies to it.

import { describe, expect, it } from 'vitest'
import { checkRoutedConnect } from '../connect-routed.js'

describe('checkRoutedConnect', () => {
  it('allows a name a pattern names, handing back the canonical name', async () => {
    const decision = await checkRoutedConnect(['API.Example.com:443'], 'Api.Example.com.', 443)

    expect(decision).toEqual({ allowed: true, host: 'api.example.com' })
  })

  it('allows any public name under a wildcard, without resolving it', async () => {
    const decision = await checkRoutedConnect(['*:*'], 'anything.example', 443)

    expect(decision).toEqual({ allowed: true, host: 'anything.example' })
  })

  it('denies a name no pattern names, and the wrong port', async () => {
    expect((await checkRoutedConnect(['api.example.com:443'], 'other.example', 443)).allowed).toBe(false)
    expect((await checkRoutedConnect(['api.example.com:443'], 'api.example.com', 80)).allowed).toBe(false)
  })

  it('denies a loopback name under a wildcard', async () => {
    expect((await checkRoutedConnect(['*:*'], 'localhost', 443)).allowed).toBe(false)
  })

  it('allows an address literal a pattern names', async () => {
    expect(await checkRoutedConnect(['93.184.216.34:443'], '93.184.216.34', 443)).toEqual({ allowed: true, host: '93.184.216.34' })
  })

  it('denies a private or loopback literal under a wildcard, the T12 rule', async () => {
    for (const host of ['10.0.0.5', '192.168.1.1', '127.0.0.1', '169.254.169.254', '::1']) {
      expect((await checkRoutedConnect(['*:*'], host, 443)).allowed, host).toBe(false)
    }
  })

  it('denies a literal spelled in a non-canonical form', async () => {
    expect((await checkRoutedConnect(['*:*'], '0177.0.0.1', 443)).allowed).toBe(false)
  })

  it('denies an empty grant, and a bad port', async () => {
    expect((await checkRoutedConnect([], 'api.example.com', 443)).allowed).toBe(false)
    expect((await checkRoutedConnect(['*:*'], 'api.example.com', 0)).allowed).toBe(false)
  })

  it('keeps the reserved-port rule: a wildcard does not reach port 25', async () => {
    expect((await checkRoutedConnect(['*:*'], 'mail.example', 25)).allowed).toBe(false)
    expect((await checkRoutedConnect(['mail.example:25'], 'mail.example', 25)).allowed).toBe(true)
  })
})
