import { beforeEach, describe, expect, it, vi } from 'vitest'

const onResponseStarted = vi.fn()
const served = vi.fn((_origin: string): boolean => false)
vi.mock('electron', () => ({}))
vi.mock('../../sessions/web-request-owner.js', () => ({ webRequestOwnerFor: () => ({ onResponseStarted }) }))
vi.mock('../../sessions/website-sessions.js', () => ({ forEachWebsiteSession: (install: (target: object) => void) => { install({}) } }))
vi.mock('../../../loader/electron/serve.js', () => ({ isOriginServedFromCacheSync: served }))

const { noteDocumentResponse, referrerPolicyHeaderOf, installReferrerPolicyWatch } = await import('../page-referrer-policy.js')

const tab = (): never => ({} as never)

beforeEach(() => { served.mockReset().mockReturnValue(false) })

describe('referrerPolicyHeaderOf', () => {
  it('is the header the document was served with, found in any casing and joined when repeated', () => {
    const wc = tab()
    noteDocumentResponse(wc, 'https://a.example/one', { 'Referrer-Policy': ['no-referrer'] })
    noteDocumentResponse(wc, 'https://a.example/two', { 'referrer-policy': ['origin', 'same-origin'] })
    expect(referrerPolicyHeaderOf(wc, 'https://a.example/one')).toBe('no-referrer')
    expect(referrerPolicyHeaderOf(wc, 'https://a.example/two')).toBe('origin,same-origin')
  })

  it('is empty for a response that had none, which is different from a response never seen', () => {
    const wc = tab()
    noteDocumentResponse(wc, 'https://a.example/', { 'content-type': ['text/html'] })
    noteDocumentResponse(wc, 'https://b.example/', undefined)
    expect(referrerPolicyHeaderOf(wc, 'https://a.example/')).toBe('')
    expect(referrerPolicyHeaderOf(wc, 'https://b.example/')).toBe('')
    expect(referrerPolicyHeaderOf(wc, 'https://c.example/')).toBeUndefined()
  })

  it('keys a document without its fragment, and keeps each tab apart', () => {
    const first = tab()
    const second = tab()
    noteDocumentResponse(first, 'https://a.example/page', { 'referrer-policy': ['origin'] })
    expect(referrerPolicyHeaderOf(first, 'https://a.example/page#section')).toBe('origin')
    expect(referrerPolicyHeaderOf(second, 'https://a.example/page')).toBeUndefined()
  })

  it('takes the latest response for an address loaded twice', () => {
    const wc = tab()
    noteDocumentResponse(wc, 'https://a.example/', { 'referrer-policy': ['origin'] })
    noteDocumentResponse(wc, 'https://a.example/', {})
    expect(referrerPolicyHeaderOf(wc, 'https://a.example/')).toBe('')
  })

  it('forgets the oldest documents of a tab past a bound, not the recent ones', () => {
    const wc = tab()
    for (let index = 0; index < 40; index++) noteDocumentResponse(wc, `https://a.example/${String(index)}`, { 'referrer-policy': ['origin'] })
    expect(referrerPolicyHeaderOf(wc, 'https://a.example/0')).toBeUndefined()
    expect(referrerPolicyHeaderOf(wc, 'https://a.example/39')).toBe('origin')
  })

  it('is empty for a document Orivon answers itself, since that response carries none, and unknown for any other unseen one', () => {
    served.mockImplementation((origin) => origin === 'https://installed.eth')
    expect(referrerPolicyHeaderOf(tab(), 'https://installed.eth/page')).toBe('')
    expect(referrerPolicyHeaderOf(tab(), 'https://other.eth/page')).toBeUndefined()
    expect(referrerPolicyHeaderOf(tab(), 'not an address')).toBeUndefined()
  })
})

describe('installReferrerPolicyWatch', () => {
  it('watches the main-frame responses of every website session and records them under their tab', () => {
    onResponseStarted.mockClear()
    installReferrerPolicyWatch.install({} as never, {} as never, {} as never, {} as never)
    expect(onResponseStarted).toHaveBeenCalledTimes(1)
    const [filter, matches, run] = onResponseStarted.mock.calls[0] as [{ urls: string[], types: string[] }, (url: string) => boolean, (details: unknown) => void]
    expect(filter.types).toEqual(['mainFrame'])
    expect(matches('https://a.example/')).toBe(true)
    expect(matches('orivon-shell://x/')).toBe(false)

    const wc = tab()
    run({ resourceType: 'mainFrame', url: 'https://a.example/', webContents: wc, responseHeaders: { 'referrer-policy': ['same-origin'] } })
    expect(referrerPolicyHeaderOf(wc, 'https://a.example/')).toBe('same-origin')
  })

  it('records nothing for a subframe, or a request no tab made', () => {
    onResponseStarted.mockClear()
    installReferrerPolicyWatch.install({} as never, {} as never, {} as never, {} as never)
    const run = onResponseStarted.mock.calls[0]?.[2] as (details: unknown) => void
    const wc = tab()
    run({ resourceType: 'subFrame', url: 'https://a.example/frame', webContents: wc, responseHeaders: {} })
    run({ resourceType: 'mainFrame', url: 'https://a.example/background', webContents: undefined, responseHeaders: {} })
    expect(referrerPolicyHeaderOf(wc, 'https://a.example/frame')).toBeUndefined()
  })
})
