import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasOwnProxy } from '../../own-proxy.js'
import { createPacFetch, MOST_SCRIPT_BYTES, PacFetchFailed, SCRIPT_FETCH_MS } from '../pac-fetch.js'
import type { PacFetchFailure, PacFetchSession } from '../pac-fetch.js'

const ADDRESS = 'http://127.0.0.1:8080/proxy.pac'
const SCRIPT = 'function FindProxyForURL() { return "DIRECT" }'

interface Fake {
  readonly session: PacFetchSession
  readonly made: () => number
  readonly calls: Array<{ url: string, init: RequestInit | undefined }>
  readonly proxies: unknown[]
  readonly order: string[]
}

/** A session that answers every fetch with what `answer` makes of the call. */
function fake (answer: (url: string, init: RequestInit | undefined) => Promise<Response> | Response, setProxy: () => Promise<void> = async () => {}): Fake {
  const calls: Fake['calls'] = []
  const proxies: unknown[] = []
  const order: string[] = []
  let made = 0
  const session = {
    setProxy: async (config: unknown) => { order.push('setProxy'); proxies.push(config); await setProxy() },
    fetch: async (url: string, init?: RequestInit) => { order.push('fetch'); calls.push({ url, init }); return await answer(url, init) }
  } as unknown as PacFetchSession
  return { session, made: () => made, calls, proxies, order, ...{ bump: () => { made += 1 } } } as Fake
}

const fetcher = (state: Fake): ReturnType<typeof createPacFetch> => createPacFetch(() => state.session)

const reply = (body: BodyInit | null, init: ResponseInit = {}): Response => new Response(body, { status: 200, ...init })

/** What the fetch rejected with, as its one word. */
async function failure (run: () => Promise<unknown>): Promise<PacFetchFailure | 'not a PacFetchFailed'> {
  try {
    await run()
  } catch (error) {
    return error instanceof PacFetchFailed ? error.failure : 'not a PacFetchFailed'
  }
  throw new Error('the fetch did not fail')
}

afterEach(() => { vi.useRealTimers() })

describe('the fetch of the system\'s proxy script', () => {
  it('returns the text of the answer', async () => {
    const state = fake(() => reply(SCRIPT, { headers: { 'content-type': 'application/x-ns-proxy-autoconfig' } }))
    expect(await fetcher(state)(ADDRESS)).toBe(SCRIPT)
  })

  it('asks for the address with no credentials, no cache and a signal that ends it', async () => {
    const state = fake(() => reply(SCRIPT))
    await fetcher(state)(ADDRESS)
    expect(state.calls).toHaveLength(1)
    expect(state.calls[0]?.url).toBe(ADDRESS)
    expect(state.calls[0]?.init).toMatchObject({ credentials: 'omit', cache: 'no-store', redirect: 'follow' })
    expect(state.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('goes out of a session of its own that is on direct before the first request and is marked as setting its own proxy', async () => {
    const state = fake(() => reply(SCRIPT))
    const fetch = createPacFetch(() => state.session)
    await fetch(ADDRESS)
    await fetch(ADDRESS)
    expect(state.proxies).toEqual([{ mode: 'direct' }])
    expect(state.order).toEqual(['setProxy', 'fetch', 'fetch'])
    expect(hasOwnProxy(state.session)).toBe(true)
  })

  it('makes no session until a script is asked for, and one only', async () => {
    let made = 0
    const state = fake(() => reply(SCRIPT))
    const fetch = createPacFetch(() => { made += 1; return state.session })
    expect(made).toBe(0)
    await fetch(ADDRESS)
    await fetch(`${ADDRESS}?second`)
    expect(made).toBe(1)
  })

  it('tries to put the session on direct again after a failure, and sends nothing meanwhile', async () => {
    let attempts = 0
    const state = fake(() => reply(SCRIPT), async () => { attempts += 1; if (attempts === 1) throw new Error('could not') })
    const fetch = createPacFetch(() => state.session)
    expect(await failure(async () => await fetch(ADDRESS))).toBe('network')
    expect(state.calls).toHaveLength(0)
    expect(await fetch(ADDRESS)).toBe(SCRIPT)
    expect(attempts).toBe(2)
  })

  describe('refuses an address that is not http or https, or that carries a user name or password, before any request', () => {
    it.each([
      ['file:///etc/proxy.pac', 'scheme'],
      ['/etc/proxy.pac', 'scheme'],
      ['data:application/x-ns-proxy-autoconfig;base64,AAAA', 'scheme'],
      ['ftp://127.0.0.1/proxy.pac', 'scheme'],
      ['javascript:alert(1)', 'scheme'],
      ['wpad', 'scheme'],
      ['', 'scheme'],
      ['http://user@127.0.0.1/proxy.pac', 'credentials'],
      ['https://user:secret@127.0.0.1/proxy.pac', 'credentials'],
      ['http://:secret@127.0.0.1/proxy.pac', 'credentials']
    ] as const)('%s', async (url, expected) => {
      const state = fake(() => reply(SCRIPT))
      expect(await failure(async () => await fetcher(state)(url))).toBe(expected)
      expect(state.calls).toHaveLength(0)
      expect(state.order).toEqual([])
    })
  })

  describe('fails for a status that is not 200, as Chromium does', () => {
    it.each([201, 204, 301, 304, 401, 403, 404, 500, 503])('%d', async (status) => {
      const state = fake(() => new Response(status === 204 || status === 304 ? null : SCRIPT, { status }))
      expect(await failure(async () => await fetcher(state)(ADDRESS))).toBe('status')
    })
  })

  describe('reads at most a megabyte', () => {
    it('and takes exactly that many bytes', async () => {
      const state = fake(() => reply('a'.repeat(MOST_SCRIPT_BYTES)))
      expect((await fetcher(state)(ADDRESS)).length).toBe(MOST_SCRIPT_BYTES)
    })

    it('and fails for one byte more, whatever the answer says about its length', async () => {
      const state = fake(() => reply('a'.repeat(MOST_SCRIPT_BYTES + 1), { headers: { 'content-length': '10' } }))
      expect(await failure(async () => await fetcher(state)(ADDRESS))).toBe('size')
    })

    it('and fails at once for a length the answer declares past it, without reading the body', async () => {
      let pulled = false
      const body = new ReadableStream<Uint8Array>({ pull () { pulled = true } }, { highWaterMark: 0 })
      const state = fake(() => reply(body, { headers: { 'content-length': String(MOST_SCRIPT_BYTES + 1) } }))
      expect(await failure(async () => await fetcher(state)(ADDRESS))).toBe('size')
      expect(pulled).toBe(false)
    })

    it('and stops reading a body that never ends', async () => {
      let pulls = 0
      let cancelled = false
      const chunk = new Uint8Array(65_536).fill(97)
      const body = new ReadableStream<Uint8Array>({ pull (controller) { pulls += 1; controller.enqueue(chunk) }, cancel () { cancelled = true } })
      const state = fake(() => reply(body))
      expect(await failure(async () => await fetcher(state)(ADDRESS))).toBe('size')
      expect(cancelled).toBe(true)
      expect(pulls).toBeLessThan(40)
    })
  })

  describe('decodes the text as Chromium does', () => {
    const bytes = (...values: number[]): Uint8Array<ArrayBuffer> => new Uint8Array(values)

    it('by the charset the answer names', async () => {
      const state = fake(() => reply(bytes(0x2f, 0x2f, 0xc3, 0xa9), { headers: { 'content-type': 'application/x-ns-proxy-autoconfig; charset=UTF-8' } }))
      expect(await fetcher(state)(ADDRESS)).toBe('//é')
    })

    it('as Latin-1 when it names none', async () => {
      const state = fake(() => reply(bytes(0x2f, 0x2f, 0xc3, 0xa9, 0x80, 0xff)))
      expect(await fetcher(state)(ADDRESS)).toBe('//Ã©\u0080ÿ')
    })

    it('as Latin-1 when it names Latin-1', async () => {
      const state = fake(() => reply(bytes(0xe9, 0x80), { headers: { 'content-type': 'text/plain;charset="ISO-8859-1"' } }))
      expect(await fetcher(state)(ADDRESS)).toBe('é\u0080')
    })

    it('as Latin-1 byte for byte whatever the platform\'s decoder makes of the label', async () => {
      vi.stubGlobal('TextDecoder', class { decode (): string { throw new Error('the decoder must not be asked for Latin-1') } })
      try {
        const state = fake(() => reply(bytes(0x80, 0x9f), { headers: { 'content-type': 'text/plain; charset=latin1' } }))
        expect(await fetcher(state)(ADDRESS)).toBe('\u0080\u009f')
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it('by a byte-order mark when it names no charset, and without the mark', async () => {
      const utf8 = fake(() => reply(bytes(0xef, 0xbb, 0xbf, 0xc3, 0xa9)))
      expect(await fetcher(utf8)(ADDRESS)).toBe('é')
      const little = fake(() => reply(bytes(0xff, 0xfe, 0xe9, 0x00, 0x41, 0x00)))
      expect(await fetcher(little)(ADDRESS)).toBe('éA')
      const big = fake(() => reply(bytes(0xfe, 0xff, 0x00, 0xe9, 0x00, 0x41)))
      expect(await fetcher(big)(ADDRESS)).toBe('éA')
    })

    it('and fails for a charset nothing here decodes', async () => {
      const state = fake(() => reply(SCRIPT, { headers: { 'content-type': 'text/plain; charset=x-no-such-charset' } }))
      expect(await failure(async () => await fetcher(state)(ADDRESS))).toBe('charset')
    })
  })

  describe('fails in one word for what goes wrong on the way', () => {
    it('a network error', async () => {
      const state = fake(() => { throw new TypeError('fetch failed') })
      expect(await failure(async () => await fetcher(state)(ADDRESS))).toBe('network')
    })

    it('an answer that comes from a final address that is not http or https', async () => {
      const state = fake(() => { const response = reply(SCRIPT); Object.defineProperty(response, 'url', { value: 'ftp://127.0.0.1/proxy.pac' }); return response })
      expect(await failure(async () => await fetcher(state)(ADDRESS))).toBe('scheme')
    })

    it('an answer that takes longer than thirty seconds, and the request is aborted', async () => {
      vi.useFakeTimers()
      let signal: AbortSignal | null | undefined
      const state = fake(async (_url, init) => { signal = init?.signal; return await new Promise<Response>(() => {}) })
      const result = failure(async () => await fetcher(state)(ADDRESS))
      await vi.advanceTimersByTimeAsync(SCRIPT_FETCH_MS - 1)
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(500)
      expect(signal?.aborted).toBe(true)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await result).toBe('time')
    })

    it('a body that stalls past thirty seconds', async () => {
      vi.useFakeTimers()
      const body = new ReadableStream<Uint8Array>({ pull: async () => await new Promise<void>(() => {}) })
      const state = fake(() => reply(body))
      const result = failure(async () => await fetcher(state)(ADDRESS))
      await vi.advanceTimersByTimeAsync(SCRIPT_FETCH_MS + 2_000)
      expect(await result).toBe('time')
    })
  })

  it('carries neither the address nor the text in any failure', async () => {
    const address = 'https://secret-host.test/secret-path.pac'
    const cases: Array<() => Fake> = [
      () => fake(() => { throw new TypeError(`fetch failed ${address}`) }),
      () => fake(() => new Response('secret-script-text', { status: 404 })),
      () => fake(() => reply('secret-script-text', { headers: { 'content-type': 'text/plain; charset=x-no-such-charset' } })),
      () => fake(() => reply('s'.repeat(MOST_SCRIPT_BYTES + 1)))
    ]
    for (const make of cases) {
      try {
        await fetcher(make())(address)
        throw new Error('the fetch did not fail')
      } catch (error) {
        const text = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ''}`
        expect(text).not.toContain('secret')
        expect(text).not.toContain('example')
      }
    }
    for (const bad of ['https://user:secret@secret-host.test/p.pac', 'file:///secret-path.pac']) {
      try {
        await fetcher(fake(() => reply(SCRIPT)))(bad)
        throw new Error('the fetch did not fail')
      } catch (error) {
        expect(`${String(error)} ${(error as Error).stack ?? ''}`).not.toContain('secret')
      }
    }
  })
})
