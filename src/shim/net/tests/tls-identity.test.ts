// The shim's tls.checkServerIdentity against real Node's, vector for vector:
// vitest runs in Node, so `node:tls` is the oracle. A ported app's custom
// identity check usually calls this first, so any divergence is a
// certificate one app accepts in Electron and refuses here, or the reverse.

import { checkServerIdentity as nodeCheck } from 'node:tls'
import type { PeerCertificate } from 'node:tls'
import { describe, expect, it } from 'vitest'
import { checkServerIdentity } from '../tls-identity.js'

type Vector = readonly [host: string, subjectaltname: string | undefined, cn: string | string[] | undefined]

const VECTORS: readonly Vector[] = [
  ['a.example.com', 'DNS:*.example.com', undefined],
  ['example.com', 'DNS:*.example.com', undefined],
  ['a.b.example.com', 'DNS:*.example.com', undefined],
  ['foo.example.com', 'DNS:f*.example.com', undefined],
  ['bar.example.com', 'DNS:f*.example.com', undefined],
  ['x.example.com', 'DNS:*.*.example.com', undefined],
  ['a.com', 'DNS:*.com', undefined],
  ['xn--a.example.com', 'DNS:*.example.com', undefined],
  ['a.example.com', 'DNS:xn--*.example.com', undefined],
  ['LOCALHOST', 'DNS:localhost', undefined],
  ['localhost.', 'DNS:localhost', undefined],
  ['a.example', 'DNS:a.example, DNS:b.example', undefined],
  ['b.example', 'DNS:a.example, DNS:b.example', undefined],
  ['c.example', 'DNS:a.example, DNS:b.example', undefined],
  ['x.com', 'DNS:"x.com"', undefined],
  ['x.com', 'DNS:"x.com, y", DNS:x.com', undefined],
  ['127.0.0.1', 'IP Address:127.0.0.1', undefined],
  ['127.0.0.1', 'DNS:localhost', undefined],
  ['::1', 'IP Address:0:0:0:0:0:0:0:1', undefined],
  ['0:0::1', 'IP Address:::1', undefined],
  ['2001:db8::1', 'IP Address:2001:DB8:0:0:0:0:0:1', undefined],
  ['::ffff:1.2.3.4', 'IP Address:::FFFF:102:304', undefined],
  ['10.0.0.1', 'IP Address:10.0.0.2', undefined],
  ['a.example', undefined, 'a.example'],
  ['a.example', undefined, ['b.example', 'a.example']],
  ['a.example', undefined, '*.example'],
  ['a.example', 'URI:https://a.example', 'a.example'],
  ['a.example', undefined, undefined],
  ['a.example', 'DNS:a..example', undefined],
  ['a.example', 'DNS:a.exämple', undefined]
]

function certFor (san: string | undefined, cn: string | string[] | undefined): PeerCertificate {
  return { subject: cn === undefined ? {} : { CN: cn }, ...(san === undefined ? {} : { subjectaltname: san }) } as unknown as PeerCertificate
}

describe('checkServerIdentity matches Node exactly', () => {
  it.each(VECTORS)('%s against %s / CN %s', (host, san, cn) => {
    const cert = certFor(san, cn)
    const expected = nodeCheck(host, cert)
    const actual = checkServerIdentity(host, cert as never)

    if (expected === undefined) {
      expect(actual).toBeUndefined()
    } else {
      expect(actual).toMatchObject({ code: (expected as Error & { code?: string }).code, message: expected.message, reason: (expected as { reason?: string }).reason, host: (expected as { host?: string }).host })
    }
  })
})
