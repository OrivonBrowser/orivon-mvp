import { describe, expect, it } from 'vitest'
import type { Session } from 'electron'
import type { AppRequestHandler } from '../../serve/serve.js'
import { onServingChange, registerAppOrigin, retireAppOrigin, servedOrigins, servingHandlerFor } from '../app-partitions.js'
import { carryPageUrl } from '../carry-page.js'

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

/** What the handler registered for `origin` answers a page of the app with. */
async function answerFor (origin: string): Promise<string | undefined> {
  const handler = servingHandlerFor(origin)
  return handler === undefined ? undefined : await (await handler(new Request(`${new URL(origin).origin}/index.html`))).text()
}

describe('the handler each served origin is answered with', () => {
  it('is found by the origin once registered, whichever way the origin is spelled', async () => {
    registerAppOrigin(fakeSession(), 'https://kept.example', answering('first'))
    expect(await answerFor('https://kept.example')).toBe('first')
    expect(await answerFor('https://KEPT.example')).toBe('first')
    expect(await answerFor('https://kept.example:443')).toBe('first')
    expect(servedOrigins()).toContain('https://kept.example')
    expect(servingHandlerFor('https://other.example')).toBeUndefined()
    expect(servingHandlerFor('not an origin')).toBeUndefined()
  })

  it('is replaced in place when the origin registers again, as the partition\'s own handler is', async () => {
    registerAppOrigin(fakeSession(), 'https://replaced.example', answering('from the verifier'), 'verifier')
    const pinned = answering('from the pin')
    registerAppOrigin(fakeSession(), 'https://replaced.example', pinned)
    expect(await answerFor('https://replaced.example')).toBe('from the pin')
    expect(servedOrigins().filter((origin) => origin === 'https://replaced.example')).toHaveLength(1)
  })

  it('is gone when the origin is retired, and back when it is registered anew', async () => {
    const session = fakeSession()
    registerAppOrigin(session, 'https://ending.example', answering('the app'), 'verifier')
    retireAppOrigin(session, 'https://ending.example')
    expect(servingHandlerFor('https://ending.example')).toBeUndefined()
    expect(servedOrigins()).not.toContain('https://ending.example')
    registerAppOrigin(session, 'https://ending.example', answering('again'), 'verifier')
    expect(await answerFor('https://ending.example')).toBe('again')
  })

  it('answers the shell\'s empty document for itself and hands every other path to the app\'s handler', async () => {
    registerAppOrigin(fakeSession(), 'https://carried.example', answering('the app'), 'verifier')
    const handler = servingHandlerFor('https://carried.example')!
    const empty = await handler(new Request(carryPageUrl('https://carried.example')))
    expect(empty.status).toBe(200)
    expect(empty.headers.get('content-type')).toContain('text/html')
    expect(await empty.text()).not.toContain('the app')
    expect(await (await handler(new Request('https://carried.example/.well-known/orivon/storage-carry-guessed'))).text()).toBe('the app')
    expect(await (await handler(new Request(carryPageUrl('https://carried.example'), { method: 'POST', body: 'x' }))).text()).toBe('the app')
  })
})

describe('hearing of the origins served changing', () => {
  it('calls the listener when an origin is added or removed, and not when its handler is only replaced', async () => {
    const session = fakeSession()
    let heard = 0
    const stop = onServingChange(() => { heard += 1 })
    registerAppOrigin(session, 'https://heard.example', answering('one'), 'verifier')
    expect(heard).toBe(1)
    registerAppOrigin(session, 'https://heard.example', answering('two'))
    expect(heard).toBe(1)
    retireAppOrigin(session, 'https://heard.example')
    expect(heard).toBe(2)
    stop()
    registerAppOrigin(session, 'https://heard.example', answering('three'))
    expect(heard).toBe(2)
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
