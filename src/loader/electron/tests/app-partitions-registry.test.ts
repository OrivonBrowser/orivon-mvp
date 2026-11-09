import { describe, expect, it } from 'vitest'
import type { Session } from 'electron'
import type { AppRequestHandler } from '../../serve/serve.js'
import { onAppOriginRetired, onServingChange, registerAppOrigin, retireAppOrigin, servedOrigins, servingHandlerFor } from '../app-partitions.js'

// The handler each origin is answered with, kept beside the partition sets: the verifier's server hands a request of
// the shared session for such an origin to it.

function fakeSession (): Session {
  const handled = new Set<string>()
  return {
    protocol: {
      isProtocolHandled: (scheme: string) => handled.has(scheme),
      unhandle: (scheme: string) => { handled.delete(scheme) },
      handle: (scheme: string) => { handled.add(scheme) }
    }
  } as unknown as Session
}

const answering = (text: string): AppRequestHandler => async () => new Response(text)

describe('the handler each served origin is answered with', () => {
  it('is found by the origin once registered, whichever way the origin is spelled', async () => {
    const handler = answering('first')
    registerAppOrigin(fakeSession(), 'https://kept.example', handler)
    expect(servingHandlerFor('https://kept.example')).toBe(handler)
    expect(servingHandlerFor('https://KEPT.example')).toBe(handler)
    expect(servingHandlerFor('https://kept.example:443')).toBe(handler)
    expect(servedOrigins()).toContain('https://kept.example')
    expect(servingHandlerFor('https://other.example')).toBeUndefined()
    expect(servingHandlerFor('not an origin')).toBeUndefined()
  })

  it('is replaced in place when the origin registers again, as the partition\'s own handler is', async () => {
    registerAppOrigin(fakeSession(), 'https://replaced.example', answering('from the verifier'), 'verifier')
    const pinned = answering('from the pin')
    registerAppOrigin(fakeSession(), 'https://replaced.example', pinned)
    expect(servingHandlerFor('https://replaced.example')).toBe(pinned)
    expect(servedOrigins().filter((origin) => origin === 'https://replaced.example')).toHaveLength(1)
  })

  it('is gone when the origin is retired, and back when it is registered anew', async () => {
    const session = fakeSession()
    registerAppOrigin(session, 'https://ending.example', answering('the app'), 'verifier')
    retireAppOrigin(session, 'https://ending.example')
    expect(servingHandlerFor('https://ending.example')).toBeUndefined()
    expect(servedOrigins()).not.toContain('https://ending.example')
    const again = answering('again')
    registerAppOrigin(session, 'https://ending.example', again, 'verifier')
    expect(servingHandlerFor('https://ending.example')).toBe(again)
  })
})

describe('hearing of the origins served changing', () => {
  it('calls the listener when an origin is added or removed, and not when its handler is only replaced', async () => {
    const session = fakeSession()
    let heard = 0
    const stop = onServingChange(() => { heard += 1 })
    registerAppOrigin(session, 'https://heard.example', answering('one'), 'verifier')
    expect(heard).toBe(1)
    registerAppOrigin(session, 'https://heard.example', answering('two'), 'verifier')
    expect(heard).toBe(1)
    registerAppOrigin(session, 'https://heard.example', answering('pinned'))
    registerAppOrigin(session, 'https://heard.example', answering('pinned again'))
    retireAppOrigin(session, 'https://heard.example')
    expect(heard).toBe(3)
    stop()
    registerAppOrigin(session, 'https://heard.example', answering('three'))
    expect(heard).toBe(3)
  })

  it('calls the listener when an origin read live is served from its pin, and when a pinned one is read live again, since the host asks which', async () => {
    const session = fakeSession()
    let heard = 0
    const stop = onServingChange(() => { heard += 1 })
    registerAppOrigin(session, 'https://switching.example', answering('live'), 'verifier')
    expect(heard).toBe(1)
    registerAppOrigin(session, 'https://switching.example', answering('pinned'))
    expect(heard).toBe(2)
    registerAppOrigin(session, 'https://switching.example', answering('live again'), 'verifier')
    expect(heard).toBe(3)
    stop()
    retireAppOrigin(session, 'https://switching.example')
  })

  it('has the set already changed when the listener is called', async () => {
    const session = fakeSession()
    const seen: string[][] = []
    const stop = onServingChange(() => { seen.push([...servedOrigins()].filter((origin) => origin.endsWith('seen.example'))) })
    registerAppOrigin(session, 'https://a.seen.example', answering('a'))
    retireAppOrigin(session, 'https://a.seen.example')
    stop()
    expect(seen).toEqual([['https://a.seen.example'], []])
  })

  it('does not let one listener that throws stop the others', async () => {
    const session = fakeSession()
    const heard: string[] = []
    const stopThrowing = onServingChange(() => { throw new Error('a listener that fails') })
    const stopHearing = onServingChange(() => { heard.push('heard') })
    registerAppOrigin(session, 'https://throwing.example', answering('x'))
    stopThrowing()
    stopHearing()
    expect(heard).toEqual(['heard'])
  })
})

describe('hearing of an app being retired', () => {
  it('calls the listener with the origin of each retired app, and not after the listener is stopped', async () => {
    const session = fakeSession()
    const retired: string[] = []
    const stop = onAppOriginRetired((origin) => { retired.push(origin) })
    registerAppOrigin(session, 'https://one.retired.example', answering('1'), 'verifier')
    retireAppOrigin(session, 'https://one.retired.example')
    stop()
    registerAppOrigin(session, 'https://two.retired.example', answering('2'), 'verifier')
    retireAppOrigin(session, 'https://two.retired.example')
    expect(retired).toEqual(['https://one.retired.example'])
  })
})
