// net.connectSecure's payload validation at the trust boundary: every TLS
// option is type- and size-checked before the policy or the TLS stack sees
// it, and a refusal names the option without echoing its value.

import { describe, expect, it } from 'vitest'
import { parseSecureConnectParams, SECURE_CONNECT_LIMITS } from '../secure-connect-params.js'

const BASE = { host: 'electrum.example', port: 50002 }

function problemOf (payload: unknown): string {
  const parsed = parseSecureConnectParams(payload)
  if (parsed.ok) throw new Error('expected a refusal')
  return parsed.problem
}

describe('accepts every documented option', () => {
  it('passes a full, well-formed payload through as-is', () => {
    const pfx = new Uint8Array([1, 2, 3])
    const payload = {
      ...BASE,
      rejectUnauthorized: false,
      ca: ['-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n'],
      cert: 'CERT',
      key: 'KEY',
      pfx,
      passphrase: 'pw',
      servername: 'Electrum.Example.',
      alpnProtocols: ['h2', 'http/1.1']
    }

    const parsed = parseSecureConnectParams(payload)

    expect(parsed).toEqual({ ok: true, params: payload })
  })

  it('accepts host and port alone, and ca as a single string', () => {
    expect(parseSecureConnectParams(BASE)).toEqual({ ok: true, params: BASE })
    expect(parseSecureConnectParams({ ...BASE, ca: 'PEM' })).toEqual({ ok: true, params: { ...BASE, ca: 'PEM' } })
  })

  it('drops an option explicitly set to undefined rather than forwarding the key', () => {
    const parsed = parseSecureConnectParams({ ...BASE, ca: undefined, servername: undefined })

    expect(parsed).toEqual({ ok: true, params: BASE })
    expect(parsed.ok && 'ca' in parsed.params).toBe(false)
  })

  it('accepts servername "" -- no SNI, as in Node', () => {
    expect(parseSecureConnectParams({ ...BASE, servername: '' })).toEqual({ ok: true, params: { ...BASE, servername: '' } })
  })
})

describe('refuses a bad shape, naming what is wrong', () => {
  it.each([
    ['a non-object payload', null, /object/],
    ['an array payload', [], /object/],
    ['a missing host', { port: 443 }, /host/],
    ['a numeric host', { host: 1, port: 443 }, /host/],
    ['a string port', { host: 'a.example', port: '443' }, /port/],
    ['an unknown option', { ...BASE, checkServerIdentity: 'x' }, /checkServerIdentity/],
    ['rejectUnauthorized as a string', { ...BASE, rejectUnauthorized: 'false' }, /rejectUnauthorized/],
    ['ca as a number', { ...BASE, ca: 1 }, /ca/],
    ['ca holding a non-string', { ...BASE, ca: ['PEM', 1] }, /ca/],
    ['cert as bytes', { ...BASE, cert: new Uint8Array(1) }, /cert/],
    ['key as a number', { ...BASE, key: 5 }, /key/],
    ['pfx as a string', { ...BASE, pfx: 'bundle' }, /pfx/],
    ['passphrase as a number', { ...BASE, passphrase: 1234 }, /passphrase/],
    ['servername as an address literal', { ...BASE, servername: '192.0.2.1' }, /servername/],
    ['servername as an IPv6 literal', { ...BASE, servername: '::1' }, /servername/],
    ['servername with a space', { ...BASE, servername: 'a b.example' }, /servername/],
    ['servername with non-ASCII', { ...BASE, servername: 'exämple.com' }, /servername/],
    ['alpnProtocols as a string', { ...BASE, alpnProtocols: 'h2' }, /alpnProtocols/],
    ['an empty ALPN entry', { ...BASE, alpnProtocols: [''] }, /alpnProtocols/],
    ['an ALPN entry with a control character', { ...BASE, alpnProtocols: ['h2\n'] }, /alpnProtocols/]
  ])('%s', (_label, payload, expected) => {
    expect(problemOf(payload)).toMatch(expected)
  })
})

describe('refuses an oversized option, so one call cannot make the main process parse megabytes', () => {
  const L = SECURE_CONNECT_LIMITS

  it.each([
    ['cert', { ...BASE, cert: 'x'.repeat(L.pemChars + 1) }],
    ['key', { ...BASE, key: 'x'.repeat(L.pemChars + 1) }],
    ['ca (one string)', { ...BASE, ca: 'x'.repeat(L.caTotalChars + 1) }],
    ['ca (too many entries)', { ...BASE, ca: Array.from({ length: L.caEntries + 1 }, () => 'PEM') }],
    ['ca (entries summing past the total)', { ...BASE, ca: Array.from({ length: 4 }, () => 'x'.repeat(Math.ceil(L.caTotalChars / 4) + 1)) }],
    ['pfx', { ...BASE, pfx: new Uint8Array(L.pfxBytes + 1) }],
    ['passphrase', { ...BASE, passphrase: 'x'.repeat(L.passphraseChars + 1) }],
    ['servername', { ...BASE, servername: `${'a'.repeat(250)}.example` }],
    ['alpnProtocols (too many)', { ...BASE, alpnProtocols: Array.from({ length: L.alpnEntries + 1 }, (_, i) => `p${String(i)}`) }],
    ['alpnProtocols (an entry too long)', { ...BASE, alpnProtocols: ['x'.repeat(L.alpnEntryChars + 1)] }]
  ])('%s', (label, payload) => {
    expect(problemOf(payload)).toMatch(new RegExp(label.split(' ')[0] ?? ''))
  })

  it('accepts each option at exactly its limit', () => {
    const payload = {
      ...BASE,
      cert: 'x'.repeat(L.pemChars),
      key: 'x'.repeat(L.pemChars),
      ca: Array.from({ length: L.caEntries }, () => 'x'.repeat(Math.floor(L.caTotalChars / L.caEntries))),
      pfx: new Uint8Array(L.pfxBytes),
      passphrase: 'x'.repeat(L.passphraseChars),
      alpnProtocols: Array.from({ length: L.alpnEntries }, () => 'x'.repeat(L.alpnEntryChars))
    }

    expect(parseSecureConnectParams(payload).ok).toBe(true)
  })

  it('never echoes a refused value, so key material cannot reach a log or the page', () => {
    const secret = 'BEGIN-PRIVATE-KEY-SECRET'

    expect(problemOf({ ...BASE, key: secret.repeat(L.pemChars) })).not.toContain(secret)
    expect(problemOf({ ...BASE, passphrase: secret.repeat(L.passphraseChars) })).not.toContain(secret)
  })
})
