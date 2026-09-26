import { describe, expect, it, vi } from 'vitest'
import type { ConnectSecureDecision } from '../../../broker/policy/connect-secure.js'
import { fetchThirdParty } from '../serve.js'
import type { AuthoriseReach, ReachDial } from '../serve.js'
import { createReachSlotPool } from '../../reach/slots.js'
import { createRedirectChains, MAX_REACH_REDIRECTS } from '../../reach/redirects.js'

const APP = 'https://app.example'
const allowAll: AuthoriseReach = async (host) => ({ allowed: true, host })
const DENIED: ConnectSecureDecision = { allowed: false, code: 'denied', reason: 'no-pattern-match' }

function countingSlots (): { reserve: () => boolean, release: () => void, inUse: () => number } {
  let inUse = 0
  return { reserve: () => { inUse += 1; return true }, release: () => { inUse -= 1 }, inUse: () => inUse }
}

describe('fetchThirdParty -- a redirect from a granted host', () => {
  it('is handed back bodiless with its Location, frees the slot at once, and cancels the upstream body', async () => {
    const cancel = vi.fn()
    const upstream = new Response(new ReadableStream({ cancel }), { status: 302, headers: { location: 'https://cdn.example/final' } })
    const slots = countingSlots()
    const response = await fetchThirdParty(
      new Request('https://granted.example/start'), allowAll, async () => upstream, undefined, slots.reserve, slots.release
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://cdn.example/final')
    expect(response.body).toBeNull()
    expect(slots.inUse()).toBe(0)
    expect(cancel).toHaveBeenCalled()
  })

  it('caps a chain at MAX_REACH_REDIRECTS: the next hop is a network error and is never dialled', async () => {
    const redirects = createRedirectChains()
    const reachDial: ReachDial = vi.fn(async (request) => {
      const n = Number(new URL(request.url).searchParams.get('n'))
      return new Response(null, { status: 302, headers: { location: `/loop?n=${String(n + 1)}` } })
    })

    for (let n = 0; n <= MAX_REACH_REDIRECTS; n++) {
      const hop = await fetchThirdParty(new Request(`https://granted.example/loop?n=${String(n)}`), allowAll, reachDial, undefined, undefined, undefined, { redirects })
      expect([n, hop.status]).toEqual([n, 302])
    }
    const beyond = await fetchThirdParty(
      new Request(`https://granted.example/loop?n=${String(MAX_REACH_REDIRECTS + 1)}`), allowAll, reachDial, undefined, undefined, undefined, { redirects }
    )
    expect(beyond.type).toBe('error')
    expect(reachDial).toHaveBeenCalledTimes(MAX_REACH_REDIRECTS + 1)
  })

  it('re-authorises every hop: a redirect to an ungranted host is refused when the loader follows it', async () => {
    const authoriseReach: AuthoriseReach = async (host) => (host === 'granted.example' ? { allowed: true, host } : DENIED)
    const reachDial: ReachDial = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/x' } }))
    const redirects = createRedirectChains()

    const first = await fetchThirdParty(new Request('https://granted.example/x'), authoriseReach, reachDial, undefined, undefined, undefined, { redirects })
    expect(first.status).toBe(302)
    const followed = await fetchThirdParty(new Request('https://elsewhere.example/x'), authoriseReach, reachDial, undefined, undefined, undefined, { redirects })
    expect(followed.status).toBe(404)
    expect(reachDial).toHaveBeenCalledTimes(1)
  })
})

describe('fetchThirdParty -- CORS for the app origin', () => {
  it('a granted response is readable by the app origin; a refused one carries no CORS header', async () => {
    const granted = await fetchThirdParty(
      new Request('https://granted.example/data.json'), allowAll, async () => new Response('{}', { headers: { 'x-total': '3' } }),
      undefined, undefined, undefined, { appOrigin: APP }
    )
    expect(granted.headers.get('access-control-allow-origin')).toBe(APP)
    expect(granted.headers.get('access-control-expose-headers')).toContain('x-total')
    expect(await granted.text()).toBe('{}')

    const refused = await fetchThirdParty(
      new Request('https://other.example/x'), async () => DENIED, async () => new Response('never'), undefined, undefined, undefined, { appOrigin: APP }
    )
    expect(refused.status).toBe(404)
    expect(refused.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('answers a preflight to a granted host without dialling or taking a slot; an ungranted host\'s preflight is refused', async () => {
    const reachDial: ReachDial = vi.fn(async () => new Response('never'))
    const slots = countingSlots()
    const preflight = (url: string): Request => new Request(url, { method: 'OPTIONS', headers: { 'access-control-request-method': 'PUT' } })

    const granted = await fetchThirdParty(preflight('https://granted.example/x'), allowAll, reachDial, undefined, slots.reserve, slots.release, { appOrigin: APP })
    expect(granted.status).toBe(204)
    expect(granted.headers.get('access-control-allow-methods')).toBe('PUT')

    const refused = await fetchThirdParty(preflight('https://other.example/x'), async () => DENIED, reachDial, undefined, slots.reserve, slots.release, { appOrigin: APP })
    expect(refused.status).toBe(404)
    expect(reachDial).not.toHaveBeenCalled()
    expect(slots.inUse()).toBe(0)
  })

  it('an app\'s own OPTIONS request (no Access-Control-Request-Method) still reaches the host', async () => {
    const reachDial: ReachDial = vi.fn(async () => new Response(null, { status: 200, headers: { allow: 'GET, PROPFIND' } }))
    const response = await fetchThirdParty(new Request('https://dav.example/x', { method: 'OPTIONS' }), allowAll, reachDial, undefined, undefined, undefined, { appOrigin: APP })
    expect(response.headers.get('allow')).toBe('GET, PROPFIND')
    expect(reachDial).toHaveBeenCalledTimes(1)
  })
})

describe('fetchThirdParty -- the queued slot', () => {
  it('a grant revoked while the request waited in the queue is refused, and its slot handed back', async () => {
    const pool = createReachSlotPool(() => 1)
    let allowed = true
    const authoriseReach: AuthoriseReach = async (host) => (allowed ? { allowed: true, host } : DENIED)
    const controllers: Array<ReadableStreamDefaultController<Uint8Array>> = []
    const reachDial: ReachDial = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start (c) { controllers.push(c) } })))

    const first = await fetchThirdParty(new Request('https://granted.example/a'), authoriseReach, reachDial, undefined, pool.reserve, pool.release)
    const queued = fetchThirdParty(new Request('https://granted.example/b'), authoriseReach, reachDial, undefined, pool.reserve, pool.release)
    allowed = false
    controllers[0]?.close()
    await first.text()

    expect((await queued).status).toBe(404)
    expect(reachDial).toHaveBeenCalledTimes(1)
    expect(pool.reserve()).toBe(true)
  })
})
