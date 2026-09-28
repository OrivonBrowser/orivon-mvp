import { describe, expect, it } from 'vitest'
import { dohAddressResolver, dohTxtResolver, txtStrings } from '../doh.js'

const signal = new AbortController().signal
const answer = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/dns-json' } })

describe('txtStrings', () => {
  it('reads quoted strings, several to a record, with escapes', () => {
    expect(txtStrings('"dnslink=/ipfs/" "bafy"')).toEqual(['dnslink=/ipfs/', 'bafy'])
    expect(txtStrings('"a \\"b\\""')).toEqual(['a "b"'])
  })

  it('reads bare text as one string', () => {
    expect(txtStrings('dnslink=/ipfs/bafy')).toEqual(['dnslink=/ipfs/bafy'])
  })
})

describe('dohTxtResolver', () => {
  it('asks for the TXT records of the name, and returns each as its strings', async () => {
    const asked: string[] = []
    const resolve = dohTxtResolver(['https://dns.example/dns-query'], async (url) => {
      asked.push(url)
      return answer({ Status: 0, Answer: [{ type: 5, data: 'cname.example.' }, { type: 16, data: '"dnslink=/ipfs/bafy"' }] })
    })
    expect(await resolve('_dnslink.app.example', signal)).toEqual([['dnslink=/ipfs/bafy']])
    expect(asked[0]).toBe('https://dns.example/dns-query?name=_dnslink.app.example&type=TXT')
  })

  it('returns nothing for a name that does not exist', async () => {
    expect(await dohTxtResolver(['https://dns.example/q'], async () => answer({ Status: 3 }))('_dnslink.x.example', signal)).toEqual([])
  })

  it('falls through to the next resolver, and fails naming every one', async () => {
    const second = dohTxtResolver(['https://a.example/q', 'https://b.example/q'], async (url) => url.startsWith('https://a.') ? new Response('', { status: 500 }) : answer({ Status: 0, Answer: [{ type: 16, data: 'dnslink=/ipfs/x' }] }))
    expect(await second('_dnslink.x.example', signal)).toEqual([['dnslink=/ipfs/x']])
    const none = dohTxtResolver(['https://a.example/q'], async () => answer({ Status: 2 }))
    await expect(none('_dnslink.x.example', signal)).rejects.toThrow(/DNS status 2/)
  })
})

describe('dohAddressResolver', () => {
  it('merges public A and AAAA answers', async () => {
    const resolve = dohAddressResolver(['https://dns.example/q'], async (url) => {
      const type = new URL(url).searchParams.get('type')
      return type === 'A'
        ? answer({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] })
        : answer({ Status: 0, Answer: [{ type: 28, data: '2606:2800:220:1:248:1893:25c8:1946' }] })
    })
    expect(await resolve('example.com', signal)).toEqual(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'])
  })

  it('drops a private or loopback answer rather than trusting it', async () => {
    const resolve = dohAddressResolver(['https://dns.example/q'], async (url) => {
      const type = new URL(url).searchParams.get('type')
      return type === 'A'
        ? answer({ Status: 0, Answer: [{ type: 1, data: '127.0.0.1' }, { type: 1, data: '93.184.216.34' }] })
        : answer({ Status: 0, Answer: [] })
    })
    expect(await resolve('example.com', signal)).toEqual(['93.184.216.34'])
  })

  it('succeeds on one family alone when the other genuinely has none (NXDOMAIN-shaped empty answer)', async () => {
    const resolve = dohAddressResolver(['https://dns.example/q'], async (url) => {
      const type = new URL(url).searchParams.get('type')
      return type === 'A' ? answer({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] }) : answer({ Status: 0, Answer: [] })
    })
    expect(await resolve('example.com', signal)).toEqual(['93.184.216.34'])
  })

  it('throws only once BOTH families fail to answer at all', async () => {
    const resolve = dohAddressResolver(['https://dns.example/q'], async () => new Response('', { status: 500 }))
    await expect(resolve('example.com', signal)).rejects.toThrow(/no DNS-over-HTTPS resolver answered/)
  })

  it('returns an empty list, not a throw, when both families answer with nothing', async () => {
    const resolve = dohAddressResolver(['https://dns.example/q'], async () => answer({ Status: 0, Answer: [] }))
    expect(await resolve('example.com', signal)).toEqual([])
  })
})
