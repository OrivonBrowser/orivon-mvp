// Redirects on the routed path, per the Fetch spec's HTTP-redirect fetch:
// every hop re-dials (and so re-checks the grant), the method and body
// change where the spec says they do, credentials the app set stay with
// the origin they were set for, and `redirect: 'manual' | 'error'` hold.
import { describe, expect, it } from 'vitest'
import { ROUTED_MAX_REDIRECTS } from '../core.js'
import { bytes, fakeSocket, fakeTarget, installRouted, OK_RESPONSE, refusal } from './routed.test-helpers.js'
import type { FakeSocket } from './routed.test-helpers.js'
import type { FetchRouteTarget } from '../types.js'

function redirect (status: number, location: string): Uint8Array {
  return bytes(`HTTP/1.1 ${status} Moved\r\nLocation: ${location}\r\nContent-Length: 0\r\n\r\n`)
}

/** Dials answer in turn from `answers`, keyed by host; every socket is recorded with the host it reached. */
function routedTarget (answers: Record<string, Uint8Array[]>, denied: string[] = []): { target: FetchRouteTarget, dials: Array<{ host: string, socket: FakeSocket }> } {
  const dials: Array<{ host: string, socket: FakeSocket }> = []
  const dialFor = async ({ host }: { host: string }): Promise<FakeSocket> => {
    if (denied.includes(host)) throw refusal('denied')
    const socket = fakeSocket([answers[host]?.shift() ?? OK_RESPONSE])
    dials.push({ host, socket })
    return socket
  }
  const target = fakeTarget({ connect: dialFor, connectSecure: dialFor, nativeFetch: async () => new Response('native') })
  installRouted(target)
  return { target, dials }
}

describe('routed fetch -- following redirects', () => {
  it('follows a redirect to another granted host, and says so on the response', async () => {
    const { target, dials } = routedTarget({ 'a.example': [redirect(302, 'https://b.example/next#frag')] })
    const response = await target.fetch!('https://a.example/start')
    expect(await response.text()).toBe('hello')
    expect(response.redirected).toBe(true)
    expect(response.url).toBe('https://b.example/next')
    expect(dials.map((d) => d.host)).toEqual(['a.example', 'b.example'])
    expect(dials[1]!.socket.sent).toMatch(/^GET \/next HTTP\/1\.1\r\nHost: b\.example\r\n/)
  })

  it('reports an unredirected response as not redirected', async () => {
    const { target } = routedTarget({})
    const response = await target.fetch!('https://a.example/x#frag')
    expect(response.redirected).toBe(false)
    expect(response.url).toBe('https://a.example/x')
  })

  it('fails -- and never falls back to native mid-chain -- when a hop leads to a host the app was not granted', async () => {
    const { target } = routedTarget({ 'a.example': [redirect(301, 'https://evil.example/')] }, ['evil.example'])
    await expect(target.fetch!('https://a.example/')).rejects.toMatchObject({ name: 'TypeError', message: 'Failed to fetch' })
  })

  it('turns a POST into a body-less GET on 303, and on 301/302', async () => {
    for (const status of [301, 302, 303]) {
      const { target, dials } = routedTarget({ 'a.example': [redirect(status, '/after')] })
      await target.fetch!('https://a.example/form', { method: 'POST', body: 'x=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
      const second = dials[1]!.socket.sent
      expect(second).toMatch(/^GET \/after /)
      expect(second.toLowerCase()).not.toContain('content-type')
      expect(second.endsWith('\r\n\r\n')).toBe(true)
    }
  })

  it('keeps the method and re-sends the body on 307 and 308', async () => {
    for (const status of [307, 308]) {
      const { target, dials } = routedTarget({ 'a.example': [redirect(status, '/again')] })
      await target.fetch!('https://a.example/put', { method: 'PUT', body: 'payload' })
      expect(dials[1]!.socket.sent).toMatch(/^PUT \/again /)
      expect(dials[1]!.socket.sent.endsWith('\r\n\r\npayload')).toBe(true)
    }
  })

  it('drops the app\'s Authorization and Cookie when the origin changes, and keeps them when it does not', async () => {
    const headers = { Authorization: 'Bearer secret', Cookie: 'sid=1', 'X-Keep': 'yes' }
    const same = routedTarget({ 'a.example': [redirect(302, '/same')] })
    await same.target.fetch!('https://a.example/', { headers })
    expect(same.dials[1]!.socket.sent).toContain('Authorization: Bearer secret')

    const cross = routedTarget({ 'a.example': [redirect(302, 'https://b.example/')] })
    await cross.target.fetch!('https://a.example/', { headers })
    const sent = cross.dials[1]!.socket.sent
    expect(sent).not.toContain('Authorization')
    expect(sent).not.toContain('Cookie')
    expect(sent).toContain('X-Keep: yes')
  })

  it(`gives up after ${ROUTED_MAX_REDIRECTS} redirects`, async () => {
    const loop = Array.from({ length: ROUTED_MAX_REDIRECTS + 1 }, (_, i) => redirect(302, `/hop${i}`))
    const { target, dials } = routedTarget({ 'a.example': loop })
    await expect(target.fetch!('https://a.example/')).rejects.toMatchObject({ message: 'Failed to fetch' })
    expect(dials).toHaveLength(ROUTED_MAX_REDIRECTS + 1)
  })

  it('follows exactly the limit', async () => {
    const hops = Array.from({ length: ROUTED_MAX_REDIRECTS }, (_, i) => redirect(302, `/hop${i}`))
    const { target } = routedTarget({ 'a.example': hops })
    expect(await (await target.fetch!('https://a.example/')).text()).toBe('hello')
  })

  it('returns a redirect with no Location as the response itself', async () => {
    const { target } = routedTarget({ 'a.example': [bytes('HTTP/1.1 302 Found\r\nContent-Length: 2\r\n\r\nno')] })
    const response = await target.fetch!('https://a.example/')
    expect(response.status).toBe(302)
    expect(await response.text()).toBe('no')
  })
})

describe('routed fetch -- redirect modes', () => {
  it('answers redirect: \'manual\' with an opaque redirect, as a browser does', async () => {
    const { target, dials } = routedTarget({ 'a.example': [redirect(302, 'https://b.example/')] })
    const response = await target.fetch!('https://a.example/start', { redirect: 'manual' })
    expect(response.type).toBe('opaqueredirect')
    expect(response.status).toBe(0)
    expect(response.url).toBe('https://a.example/start')
    expect(dials).toHaveLength(1)
  })

  it('fails redirect: \'error\' on any redirect', async () => {
    const { target } = routedTarget({ 'a.example': [redirect(301, '/elsewhere')] })
    await expect(target.fetch!('https://a.example/', { redirect: 'error' })).rejects.toMatchObject({ message: 'Failed to fetch' })
  })
})
