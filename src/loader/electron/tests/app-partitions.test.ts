import { describe, expect, it } from 'vitest'
import type { Session } from 'electron'
import type { AppRequestHandler } from '../../serve/serve.js'

// An origin whose partition answers from the verifier before its pin: a partition of its own, not yet served from
// a pin, replaced in place when the pin lands, and retired when it turns out bad.

function fakeSession (): Session & { calls: { unhandle: string[], handle: string[] }, handlers: Map<string, AppRequestHandler> } {
  const handled = new Set<string>()
  const calls = { unhandle: [] as string[], handle: [] as string[] }
  const handlers = new Map<string, AppRequestHandler>()
  return {
    protocol: {
      isProtocolHandled: (scheme: string) => handled.has(scheme),
      unhandle: (scheme: string) => { handled.delete(scheme); calls.unhandle.push(scheme) },
      handle: (scheme: string, handler: AppRequestHandler) => { handled.add(scheme); calls.handle.push(scheme); handlers.set(scheme, handler) }
    },
    calls,
    handlers
  } as unknown as Session & { calls: { unhandle: string[], handle: string[] }, handlers: Map<string, AppRequestHandler> }
}

describe('an origin served from the verifier before its pin', () => {
  it('has a partition of its own as soon as its handler is registered, yet is not served from a pin', async () => {
    const { registerAppOrigin, isOriginServedFromCacheSync, isOriginPinnedSync } = await import('../serve.js')
    const session = fakeSession()
    registerAppOrigin(session, 'https://live.example', async () => new Response(null), 'verifier')
    expect(isOriginServedFromCacheSync('https://live.example')).toBe(true)
    expect(isOriginPinnedSync('https://live.example')).toBe(false)
  })

  it('is served from a pin once the pin\'s handler replaces it in place', async () => {
    const { registerAppOrigin, isOriginPinnedSync } = await import('../serve.js')
    const session = fakeSession()
    registerAppOrigin(session, 'https://pinning.example', async () => new Response(null), 'verifier')
    registerAppOrigin(session, 'https://pinning.example', async () => new Response(null))
    expect(session.calls.unhandle).toEqual(['https'])
    expect(isOriginPinnedSync('https://pinning.example')).toBe(true)
  })

  it('leaves the shared session to a retired origin, and answers nothing from its partition', async () => {
    const { registerAppOrigin, retireAppOrigin, isOriginServedFromCacheSync } = await import('../serve.js')
    const session = fakeSession()
    registerAppOrigin(session, 'https://ended.example', async () => new Response('the app'), 'verifier')
    retireAppOrigin(session, 'https://ended.example')
    expect(isOriginServedFromCacheSync('https://ended.example')).toBe(false)
    // A page or worker still alive in that partition is answered with a refusal, never with the network.
    expect(session.calls.unhandle).toEqual(['https'])
    expect(session.calls.handle).toEqual(['https', 'https'])
    const answer = await session.handlers.get('https')!(new Request('https://ended.example/app.js'))
    expect(answer.status).toBe(404)
    expect(await answer.text()).not.toContain('the app')
  })

  it('is served again, in place of the refusal, when the origin is consented anew', async () => {
    const { registerAppOrigin, retireAppOrigin, isOriginServedFromCacheSync } = await import('../serve.js')
    const session = fakeSession()
    registerAppOrigin(session, 'https://again.example', async () => new Response('first'), 'verifier')
    retireAppOrigin(session, 'https://again.example')
    registerAppOrigin(session, 'https://again.example', async () => new Response('second'), 'verifier')
    expect(isOriginServedFromCacheSync('https://again.example')).toBe(true)
    expect(await (await session.handlers.get('https')!(new Request('https://again.example/'))).text()).toBe('second')
  })
})
