import { describe, expect, it, vi } from 'vitest'
import { engineSuggestions, fetchSuggestions, isAllowedEndpoint, MAX_RESPONSE_BYTES, mayRequest, suggestionRows } from '../suggest-fetch.js'
import type { FetchImpl, SuggestDeps } from '../suggest-fetch.js'
import type { SuggestContext } from '../suggest-sources.js'

const ENDPOINT = 'https://engine.example/ac?q=%s&type=list'
const json = (body: unknown): Response => new Response(typeof body === 'string' ? body : JSON.stringify(body))
const answering = (body: unknown = ['ca', ['cats', 'cat food']]): ReturnType<typeof vi.fn<FetchImpl>> => vi.fn<FetchImpl>(async () => json(body))

function deps (more: Partial<SuggestDeps> = {}): SuggestDeps {
  return {
    enabled: true,
    isPrivate: false,
    endpoint: ENDPOINT,
    isPlainSearch: (text) => !text.includes('.') && !text.startsWith('fx '),
    searchUrl: (query) => `https://engine.example/?q=${encodeURIComponent(query)}`,
    fetch: answering(),
    debounceMs: 0,
    timeoutMs: 200,
    ...more
  }
}
const context = (suggest: SuggestDeps | undefined): SuggestContext => ({
  now: 0, isPrivate: false, history: { suggest: () => [] }, bookmarks: () => [], tabs: () => [], ...(suggest === undefined ? {} : { suggest })
})
const ask = async (text: string, suggest: SuggestDeps | undefined, signal = new AbortController().signal): ReturnType<typeof engineSuggestions> => await engineSuggestions(text, context(suggest), signal)

describe('mayRequest', () => {
  it('is yes only for plain search text of two to 200 characters, with the setting on, outside a private session', () => {
    expect(mayRequest('ca', deps())).toBe(true)
    expect(mayRequest('  ca  ', deps())).toBe(true)
  })

  it.each([
    ['the setting off', 'cats', { enabled: false }],
    ['a private session', 'cats', { isPrivate: true }],
    ['an engine with no endpoint', 'cats', { endpoint: null }],
    ['one character', 'c', {}],
    ['a blank', '   ', {}],
    ['an address', 'example.com', {}],
    ['a keyword search', 'fx hello', {}],
    ['text past 200 characters', 'c'.repeat(201), {}],
    ['an endpoint that is http on another host', 'cats', { endpoint: 'http://engine.example/?q=%s' }],
    ['an endpoint with no place for the text', 'cats', { endpoint: 'https://engine.example/' }]
  ] as const)('is no for %s', (_name, text, more) => {
    expect(mayRequest(text, deps(more))).toBe(false)
  })

  it('is no with no deps at all', () => {
    expect(mayRequest('cats', undefined)).toBe(false)
  })
})

describe('isAllowedEndpoint', () => {
  it.each([[ENDPOINT, true], ['http://127.0.0.1:1/s?q=%s', true], ['http://localhost/s?q=%s', true], ['http://engine.example/?q=%s', false], ['ftp://x/%s', false], ['nonsense %s', false], ['https://x.example/', false]])('%s is %j', (url, ok) => {
    expect(isAllowedEndpoint(url)).toBe(ok)
  })
})

describe('fetchSuggestions', () => {
  it('asks the endpoint with the text in place, and sends no cookie, no referrer and no redirect', async () => {
    const fetchImpl = answering()
    const found = await fetchSuggestions(ENDPOINT, ' cats & dogs ', fetchImpl, new AbortController().signal)
    expect(found).toEqual(['cats', 'cat food'])
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://engine.example/ac?q=cats%20%26%20dogs&type=list')
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', referrer: '', headers: { accept: 'application/json' } })
  })

  it.each([
    ['a failed request', async () => { throw new Error('offline') }],
    ['a redirect, which the request refuses', async () => { throw new TypeError('redirect') }],
    ['an error status', async () => new Response('nope', { status: 503 })],
    ['a body that is not JSON', async () => json('<html>')]
  ])('gives nothing for %s', async (_name, impl) => {
    expect(await fetchSuggestions(ENDPOINT, 'cats', vi.fn(impl), new AbortController().signal)).toEqual([])
  })

  it('gives nothing when the answer is over 64 KB, declared or streamed', async () => {
    const declared = new Response('["q",["a"]]', { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } })
    expect(await fetchSuggestions(ENDPOINT, 'q', vi.fn(async () => declared), new AbortController().signal)).toEqual([])
    const big = JSON.stringify(['q', ['a'.repeat(MAX_RESPONSE_BYTES)]])
    expect(await fetchSuggestions(ENDPOINT, 'q', vi.fn(async () => json(big)), new AbortController().signal)).toEqual([])
    const justUnder = JSON.stringify(['q', ['ok']]) + ' '.repeat(1000)
    expect(await fetchSuggestions(ENDPOINT, 'q', vi.fn(async () => json(justUnder)), new AbortController().signal)).toEqual(['ok'])
  })

  it('gives up after the timeout', async () => {
    const hang: FetchImpl = async (_url, init) => await new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => { reject(new Error('aborted')) }) })
    const started = Date.now()
    expect(await fetchSuggestions(ENDPOINT, 'cats', hang, new AbortController().signal, 40)).toEqual([])
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('stops when the caller aborts', async () => {
    const controller = new AbortController()
    const hang: FetchImpl = async (_url, init) => await new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => { reject(new Error('aborted')) }) })
    const pending = fetchSuggestions(ENDPOINT, 'cats', hang, controller.signal)
    controller.abort()
    expect(await pending).toEqual([])
  })
})

describe('the engine suggestions source', () => {
  it('turns the answer into search rows with the typed part marked', async () => {
    const rows = await ask('ca', deps())
    expect(rows).toEqual([
      { kind: 'search', title: 'cats', address: '', url: 'https://engine.example/?q=cats', favicon: null, match: [[0, 2]] },
      { kind: 'search', title: 'cat food', address: '', url: 'https://engine.example/?q=cat%20food', favicon: null, match: [[0, 2]] }
    ])
  })

  it('asks nothing for any guard that fails', async () => {
    const fetchImpl = answering()
    for (const more of [{ enabled: false }, { isPrivate: true }, { endpoint: null }]) expect(await ask('cats', deps({ ...more, fetch: fetchImpl }))).toEqual([])
    expect(await ask('c', deps({ fetch: fetchImpl }))).toEqual([])
    expect(await ask('example.com', deps({ fetch: fetchImpl }))).toEqual([])
    expect(await ask('fx hello', deps({ fetch: fetchImpl }))).toEqual([])
    expect(await ask('cats', undefined)).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('waits for the typing to stop, and asks nothing when a newer text replaces it first', async () => {
    const fetchImpl = answering()
    const controller = new AbortController()
    const pending = ask('cats', deps({ fetch: fetchImpl, debounceMs: 60 }), controller.signal)
    controller.abort()
    expect(await pending).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('gives nothing when it is aborted while the request is out', async () => {
    const controller = new AbortController()
    const slow: FetchImpl = async () => { controller.abort(); return json(['q', ['late']]) }
    expect(await ask('cats', deps({ fetch: slow }), controller.signal)).toEqual([])
  })
})

describe('suggestionRows', () => {
  it('marks a suggestion that does not begin with the text by where its words are', () => {
    expect(suggestionRows('cat', ['the cat'], (q) => q)[0]?.match).toEqual([[4, 7]])
  })
})
