// The DNS message a DNS-over-HTTPS query carries (RFC 8484): what is asked, and what an answer says.

import * as dns from '@dnsquery/dns-packet'
import { describe, expect, it } from 'vitest'
import { dohQuery, MAX_CNAME_LINKS, readDohAnswer } from '../doh-message.js'

const FLAGS = dns.RECURSION_DESIRED | dns.RECURSION_AVAILABLE
const NXDOMAIN = 3
const SERVFAIL = 2
const REFUSED = 5

type Records = Array<{ type: string, name: string, ttl?: number, data: unknown }>

/** A response to `name`, as a DNS server would send it: `flags` carries the response code in its low bits. */
function respond (options: { rcode?: number, flags?: number, answers?: Records, authorities?: Records, name?: string, type?: 'A' | 'AAAA' }): Uint8Array {
  return dns.encode({
    type: 'response',
    id: 0,
    flags: (options.flags ?? FLAGS) | (options.rcode ?? 0),
    questions: [{ type: options.type ?? 'A', name: options.name ?? 'site.test' }],
    answers: (options.answers ?? []) as dns.Answer[],
    authorities: (options.authorities ?? []) as dns.Answer[]
  })
}

const soa = (ttl: number, minimum: number): Records => [{ type: 'SOA', name: 'test', ttl, data: { mname: 'ns.test', rname: 'admin.test', serial: 1, refresh: 1, retry: 1, expire: 1, minimum } }]

describe('the query', () => {
  it('asks one question, with id 0, recursion desired and no client subnet', () => {
    const packet = dns.decode(dohQuery('Site.Test', 4))
    expect(packet.id).toBe(0)
    expect(packet.flag_qr).toBe(false)
    expect(packet.flag_rd).toBe(true)
    expect(packet.questions).toEqual([{ name: 'site.test', type: 'A', class: 'IN' }])
    const opt = (packet.additionals ?? []).filter((record) => record.type === 'OPT') as unknown as Array<{ options: Array<{ type: string }> }>
    expect(opt).toHaveLength(1)
    expect(opt[0]?.options.map((option) => option.type)).toEqual(['PADDING'])
  })

  it('asks for the other family as a query of its own', () => {
    expect(dns.decode(dohQuery('site.test', 6)).questions).toEqual([{ name: 'site.test', type: 'AAAA', class: 'IN' }])
  })

  it('pads the message to a multiple of 128 bytes, whatever the name', () => {
    for (const name of ['a.test', 'site.test', 'a-much-longer-name.under.some.deep.domain.example.test', 'x'.repeat(60) + '.test']) {
      expect(dohQuery(name, 4).length % 128).toBe(0)
    }
  })

  it('writes the name it was given, lowercase and without the root dot', () => {
    expect(dns.decode(dohQuery('Site.TEST.', 4)).questions?.[0]?.name).toBe('site.test')
  })
})

describe('an answer with addresses', () => {
  it('reads the addresses of the family asked and the smallest TTL among them', () => {
    const answer = readDohAnswer(respond({ answers: [{ type: 'A', name: 'site.test', ttl: 300, data: '192.0.2.1' }, { type: 'A', name: 'site.test', ttl: 120, data: '192.0.2.2' }] }), 'site.test', 4)
    expect(answer).toEqual({ kind: 'addresses', addresses: ['192.0.2.1', '192.0.2.2'], ttl: 120 })
  })

  it('reads an IPv6 answer to an AAAA question', () => {
    const answer = readDohAnswer(respond({ type: 'AAAA', answers: [{ type: 'AAAA', name: 'site.test', ttl: 60, data: '2001:db8::1' }] }), 'site.test', 6)
    expect(answer).toEqual({ kind: 'addresses', addresses: ['2001:db8::1'], ttl: 60 })
  })

  it('follows the CNAME chain from the asked name, with the smallest TTL along it', () => {
    const answer = readDohAnswer(respond({
      answers: [
        { type: 'CNAME', name: 'site.test', ttl: 30, data: 'edge.cdn.test' },
        { type: 'CNAME', name: 'edge.cdn.test', ttl: 900, data: 'node.cdn.test' },
        { type: 'A', name: 'node.cdn.test', ttl: 20, data: '192.0.2.9' },
        { type: 'A', name: 'node.cdn.test', ttl: 25, data: '192.0.2.10' }
      ]
    }), 'site.test', 4)
    expect(answer).toEqual({ kind: 'addresses', addresses: ['192.0.2.9', '192.0.2.10'], ttl: 20 })
  })

  it('takes only the records the chain leads to, not another name\'s', () => {
    const answer = readDohAnswer(respond({
      answers: [
        { type: 'A', name: 'unrelated.test', ttl: 5, data: '203.0.113.5' },
        { type: 'CNAME', name: 'site.test', ttl: 30, data: 'edge.test' },
        { type: 'A', name: 'edge.test', ttl: 40, data: '192.0.2.3' }
      ]
    }), 'site.test', 4)
    expect(answer).toEqual({ kind: 'addresses', addresses: ['192.0.2.3'], ttl: 30 })
  })

  it('follows at most eight links, and a longer chain is no answer', () => {
    const chain = (links: number): Records => {
      const records: Records = []
      for (let index = 0; index < links; index += 1) records.push({ type: 'CNAME', name: index === 0 ? 'site.test' : `link${String(index)}.test`, ttl: 60, data: `link${String(index + 1)}.test` })
      records.push({ type: 'A', name: `link${String(links)}.test`, ttl: 60, data: '192.0.2.4' })
      return records
    }
    expect(MAX_CNAME_LINKS).toBe(8)
    expect(readDohAnswer(respond({ answers: chain(8) }), 'site.test', 4)).toMatchObject({ kind: 'addresses', addresses: ['192.0.2.4'] })
    expect(readDohAnswer(respond({ answers: chain(9) }), 'site.test', 4)).toEqual({ kind: 'failed' })
  })

  it('ends a CNAME loop instead of following it for ever', () => {
    const answer = readDohAnswer(respond({ answers: [{ type: 'CNAME', name: 'site.test', ttl: 5, data: 'other.test' }, { type: 'CNAME', name: 'other.test', ttl: 5, data: 'site.test' }] }), 'site.test', 4)
    expect(answer).toEqual({ kind: 'failed' })
  })

  it('matches names without regard to case or a root dot', () => {
    const answer = readDohAnswer(respond({ name: 'SITE.test', answers: [{ type: 'A', name: 'SITE.Test', ttl: 7, data: '192.0.2.5' }] }), 'Site.TEST.', 4)
    expect(answer).toEqual({ kind: 'addresses', addresses: ['192.0.2.5'], ttl: 7 })
  })
})

describe('an answer without addresses', () => {
  it('says the name does not exist for NXDOMAIN, with the negative TTL the SOA gives (the smaller of its TTL and minimum)', () => {
    expect(readDohAnswer(respond({ rcode: NXDOMAIN, authorities: soa(1739, 300) }), 'site.test', 4)).toEqual({ kind: 'empty', nxdomain: true, ttl: 300 })
    expect(readDohAnswer(respond({ rcode: NXDOMAIN, authorities: soa(40, 900) }), 'site.test', 4)).toEqual({ kind: 'empty', nxdomain: true, ttl: 40 })
  })

  it('says the family has none for NODATA: no error, no record of the type', () => {
    expect(readDohAnswer(respond({ authorities: soa(500, 200) }), 'site.test', 6)).toEqual({ kind: 'empty', nxdomain: false, ttl: 200 })
  })

  it('says the same for a chain that ends in no address', () => {
    const answer = readDohAnswer(respond({ answers: [{ type: 'CNAME', name: 'site.test', ttl: 10, data: 'gone.test' }], authorities: soa(100, 50) }), 'site.test', 4)
    expect(answer).toEqual({ kind: 'empty', nxdomain: false, ttl: 50 })
  })

  it('has a TTL of 0 when no SOA says how long to remember it', () => {
    expect(readDohAnswer(respond({ rcode: NXDOMAIN }), 'site.test', 4)).toEqual({ kind: 'empty', nxdomain: true, ttl: 0 })
  })
})

describe('an answer that is no answer', () => {
  it('fails for SERVFAIL and REFUSED', () => {
    expect(readDohAnswer(respond({ rcode: SERVFAIL }), 'site.test', 4)).toEqual({ kind: 'failed' })
    expect(readDohAnswer(respond({ rcode: REFUSED }), 'site.test', 4)).toEqual({ kind: 'failed' })
  })

  it('fails for a truncated message, whatever it holds', () => {
    const answers: Records = [{ type: 'A', name: 'site.test', ttl: 60, data: '192.0.2.1' }]
    expect(readDohAnswer(respond({ flags: FLAGS | dns.TRUNCATED_RESPONSE, answers }), 'site.test', 4)).toEqual({ kind: 'failed' })
  })

  it('fails for bytes that do not decode, and for a query sent back', () => {
    expect(readDohAnswer(new Uint8Array([1, 2, 3]), 'site.test', 4)).toEqual({ kind: 'failed' })
    expect(readDohAnswer(new Uint8Array(0), 'site.test', 4)).toEqual({ kind: 'failed' })
    expect(readDohAnswer(dohQuery('site.test', 4), 'site.test', 4)).toEqual({ kind: 'failed' })
  })
})
