import { describe, expect, it } from 'vitest'
import { EgressRefused, allowlisted, guardedCcipRequest } from '../egress.js'
import type { CcipDeps, WebFetch } from '../egress.js'
import type { DirectFetch } from '../direct-fetch.js'

const SENDER = '0xABCDEF0000000000000000000000000000000001'
const DATA = '0x1234'

function recording (answer: (url: string, init: RequestInit | undefined) => Response): WebFetch & { calls: Array<{ url: string, init: RequestInit | undefined }> } {
  const calls: Array<{ url: string, init: RequestInit | undefined }> = []
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    return answer(url, init)
  }
  return Object.assign(fetch, { calls })
}

/** A `DirectFetch` stand-in: records the address(es) it was pinned to
 * dialling, alongside the url and init `recording` above captures, so a
 * test can check the CCIP path never hands a bare hostname past the check. */
function recordingDirect (answer: (url: string, init: RequestInit | undefined) => Response): DirectFetch & { calls: Array<{ url: string, init: RequestInit | undefined, addresses: readonly string[] }> } {
  const calls: Array<{ url: string, init: RequestInit | undefined, addresses: readonly string[] }> = []
  const fetch = async (url: string, init: RequestInit | undefined, addresses: readonly string[]): Promise<Response> => {
    calls.push({ url, init, addresses })
    return answer(url, init)
  }
  return Object.assign(fetch, { calls })
}

function deps (directFetch: DirectFetch, dns: Record<string, string[]> = { 'gateway.example': ['93.184.216.34'] }): CcipDeps {
  return { directFetch, resolveHost: async (host) => dns[host] ?? [] }
}

const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

describe('allowlisted', () => {
  it('reaches a listed origin, refusing redirects', async () => {
    const inner = recording(() => new Response('ok'))
    await allowlisted(['https://rpc.example/'], inner, 'the light client')('https://rpc.example/v1', { method: 'POST' })
    expect(inner.calls[0]?.init).toMatchObject({ method: 'POST', redirect: 'error' })
  })

  it('throws for any other origin, before any request', async () => {
    const inner = recording(() => new Response('ok'))
    const fetch = allowlisted(['https://rpc.example'], inner, 'the light client')
    await expect(fetch('https://raw.githubusercontent.com/ethpandaops/x')).rejects.toBeInstanceOf(EgressRefused)
    await expect(fetch('http://rpc.example/')).rejects.toBeInstanceOf(EgressRefused)
    await expect(fetch('https://rpc.example:8443/')).rejects.toBeInstanceOf(EgressRefused)
    expect(inner.calls).toEqual([])
  })
})

describe('guardedCcipRequest', () => {
  it('GETs a URL template carrying {data}, with the sender lowercased', async () => {
    const fetch = recordingDirect(() => json({ data: '0xfeed' }))
    const result = await guardedCcipRequest({ data: DATA, sender: SENDER, urls: ['https://gateway.example/{sender}/{data}.json'] }, deps(fetch))
    expect(result).toBe('0xfeed')
    expect(fetch.calls[0]?.url).toBe(`https://gateway.example/${SENDER.toLowerCase()}/${DATA}.json`)
    expect(fetch.calls[0]?.init?.method).toBe('GET')
  })

  it('POSTs the data and sender to a URL without {data}', async () => {
    const fetch = recordingDirect(() => json({ data: '0xfeed' }))
    await guardedCcipRequest({ data: DATA, sender: SENDER, urls: ['https://gateway.example/lookup'] }, deps(fetch))
    expect(fetch.calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(fetch.calls[0]?.init?.body))).toEqual({ data: DATA, sender: SENDER })
  })

  it('dials the address it already resolved, never a bare hostname a second lookup could rebind', async () => {
    const dns = { 'gateway.example': ['93.184.216.34'] }
    const fetch = recordingDirect(() => json({ data: '0xfeed' }))
    await guardedCcipRequest({ data: DATA, sender: SENDER, urls: ['https://gateway.example/{data}'] }, deps(fetch, dns))
    // Whatever a SECOND lookup of gateway.example might answer (a rebinding
    // resolver, say, with loopback on its second reply) is irrelevant: the
    // dial is pinned to what resolveHost already checked, once.
    expect(fetch.calls[0]?.addresses).toEqual(['93.184.216.34'])
  })

  it('refuses http, loopback, private ranges and a name that resolves to one, without requesting', async () => {
    const fetch = recordingDirect(() => json({ data: '0xfeed' }))
    const dns = { 'rebind.example': ['93.184.216.34', '127.0.0.1'], 'lan.example': ['192.168.1.10'] }
    for (const url of ['http://gateway.example/{data}', 'https://127.0.0.1/{data}', 'https://[::1]/{data}', 'https://10.0.0.1/{data}', 'https://169.254.169.254/{data}', 'https://rebind.example/{data}', 'https://lan.example/{data}', 'https://localhost/{data}', 'https://other.eth/{data}', 'https://user:pw@gateway.example/{data}']) {
      await expect(guardedCcipRequest({ data: DATA, sender: SENDER, urls: [url] }, deps(fetch, dns))).rejects.toThrow(/no offchain gateway answered/)
    }
    expect(fetch.calls).toEqual([])
  })

  it('refuses any port but 443, before resolving or requesting', async () => {
    const fetch = recordingDirect(() => json({ data: '0xfeed' }))
    await expect(guardedCcipRequest({ data: DATA, sender: SENDER, urls: ['https://93.184.216.34:6379/{data}'] }, deps(fetch))).rejects.toThrow(/no offchain gateway answered/)
    expect(fetch.calls).toEqual([])
  })

  it('follows a redirect within the same origin, and refuses one to another', async () => {
    const same = recordingDirect((url) => url.endsWith('/a') ? new Response(null, { status: 302, headers: { location: '/b' } }) : json({ data: '0xbeef' }))
    expect(await guardedCcipRequest({ data: DATA, sender: SENDER, urls: ['https://gateway.example/a'] }, deps(same))).toBe('0xbeef')
    const away = recordingDirect(() => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/x' } }))
    await expect(guardedCcipRequest({ data: DATA, sender: SENDER, urls: ['https://gateway.example/a'] }, deps(away))).rejects.toThrow(/another origin/)
    expect(away.calls).toHaveLength(1)
  })

  it('refuses an answer that is not hex, or too large, and tries the next URL', async () => {
    const fetch = recordingDirect((url) => url.includes('first') ? new Response('<html>') : json({ data: '0xabcd' }))
    expect(await guardedCcipRequest({ data: DATA, sender: SENDER, urls: ['https://gateway.example/first', 'https://gateway.example/second'] }, deps(fetch))).toBe('0xabcd')
    const big = recordingDirect(() => new Response('0x' + 'ab'.repeat(1024)))
    await expect(guardedCcipRequest({ data: DATA, sender: SENDER, urls: ['https://gateway.example/x'] }, deps(big), { maxResponseBytes: 100, timeoutMs: 1000 })).rejects.toThrow(/no offchain gateway answered/)
  })

  it('reports every URL that failed', async () => {
    const fetch = recordingDirect(() => new Response('down', { status: 503 }))
    await expect(guardedCcipRequest({ data: DATA, sender: SENDER, urls: ['https://gateway.example/a', 'http://gateway.example/b'] }, deps(fetch))).rejects.toThrow(/503.*only https/)
  })
})
