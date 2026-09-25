import { describe, expect, it } from 'vitest'
import { EgressRefused, allowlisted, guardedCcipRequest } from '../egress.js'
import type { CcipDeps, WebFetch } from '../egress.js'

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

function deps (fetch: WebFetch, dns: Record<string, string[]> = { 'gateway.example': ['93.184.216.34'] }): CcipDeps {
  return { fetch, resolveHost: async (host) => dns[host] ?? [] }
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
    const fetch = recording(() => json({ data: '0xfeed' }))
    const result = await guardedCcipRequest({ data: DATA, sender: SENDER, urls: ['https://gateway.example/{sender}/{data}.json'] }, deps(fetch))
    expect(result).toBe('0xfeed')
    expect(fetch.calls[0]?.url).toBe(`https://gateway.example/${SENDER.toLowerCase()}/${DATA}.json`)
    expect(fetch.calls[0]?.init?.method).toBe('GET')
  })

  it('POSTs the data and sender to a URL without {data}', async () => {
    const fetch = recording(() => json({ data: '0xfeed' }))
    await guardedCcipRequest({ data: DATA, sender: SENDER, urls: ['https://gateway.example/lookup'] }, deps(fetch))
    expect(fetch.calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(fetch.calls[0]?.init?.body))).toEqual({ data: DATA, sender: SENDER })
  })

  it('refuses http, loopback, private ranges and a name that resolves to one, without requesting', async () => {
    const fetch = recording(() => json({ data: '0xfeed' }))
    const dns = { 'rebind.example': ['93.184.216.34', '127.0.0.1'], 'lan.example': ['192.168.1.10'] }
    for (const url of ['http://gateway.example/{data}', 'https://127.0.0.1/{data}', 'https://[::1]/{data}', 'https://10.0.0.1/{data}', 'https://169.254.169.254/{data}', 'https://rebind.example/{data}', 'https://lan.example/{data}', 'https://localhost/{data}', 'https://other.eth/{data}', 'https://user:pw@gateway.example/{data}']) {
      await expect(guardedCcipRequest({ data: DATA, sender: SENDER, urls: [url] }, deps(fetch, dns))).rejects.toThrow(/no offchain gateway answered/)
    }
    expect(fetch.calls).toEqual([])
  })

  it('follows a redirect within the same origin, and refuses one to another', async () => {
    const same = recording((url) => url.endsWith('/a') ? new Response(null, { status: 302, headers: { location: '/b' } }) : json({ data: '0xbeef' }))
    expect(await guardedCcipRequest({ data: DATA, sender: SENDER, urls: ['https://gateway.example/a'] }, deps(same))).toBe('0xbeef')
    const away = recording(() => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/x' } }))
    await expect(guardedCcipRequest({ data: DATA, sender: SENDER, urls: ['https://gateway.example/a'] }, deps(away))).rejects.toThrow(/another origin/)
    expect(away.calls).toHaveLength(1)
  })

  it('refuses an answer that is not hex, or too large, and tries the next URL', async () => {
    const fetch = recording((url) => url.includes('first') ? new Response('<html>') : json({ data: '0xabcd' }))
    expect(await guardedCcipRequest({ data: DATA, sender: SENDER, urls: ['https://gateway.example/first', 'https://gateway.example/second'] }, deps(fetch))).toBe('0xabcd')
    const big = recording(() => new Response('0x' + 'ab'.repeat(1024)))
    await expect(guardedCcipRequest({ data: DATA, sender: SENDER, urls: ['https://gateway.example/x'] }, deps(big), { maxResponseBytes: 100, timeoutMs: 1000 })).rejects.toThrow(/no offchain gateway answered/)
  })

  it('reports every URL that failed', async () => {
    const fetch = recording(() => new Response('down', { status: 503 }))
    await expect(guardedCcipRequest({ data: DATA, sender: SENDER, urls: ['https://gateway.example/a', 'http://gateway.example/b'] }, deps(fetch))).rejects.toThrow(/503.*only https/)
  })
})
