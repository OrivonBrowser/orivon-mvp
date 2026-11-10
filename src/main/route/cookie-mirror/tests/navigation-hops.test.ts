import { describe, expect, it } from 'vitest'
import { createNavigationHops } from '../navigation-hops.js'
import type { MainFrameRequest } from '../navigation-hops.js'

const request = (over: Partial<MainFrameRequest> = {}): MainFrameRequest => ({ id: 1, webContentsId: 7, referrer: '', ...over })

describe('telling the first request of a navigation from the hops after it, and a person from a page', () => {
  it('calls the first request of a navigation the browser started (no page issued it, no referrer) the person\'s', () => {
    const hops = createNavigationHops()
    expect(hops.classify(request())).toBe('browser')
  })

  it('calls the later requests of the same navigation redirect hops, whoever started it', () => {
    const hops = createNavigationHops()
    expect(hops.classify(request({ id: 5 }))).toBe('browser')
    expect(hops.classify(request({ id: 5 }))).toBe('redirect')
    expect(hops.classify(request({ id: 5 }))).toBe('redirect')
    expect(hops.classify(request({ id: 6 }))).toBe('browser')
    expect(hops.classify(request({ id: 7, initiatorOrigin: 'https://a.test' }))).toBe('page')
    expect(hops.classify(request({ id: 7, initiatorOrigin: 'https://a.test' }))).toBe('redirect')
  })

  it('calls a navigation a page started the page\'s: a script, a link, a form, a popup it opened with a referrer', () => {
    const hops = createNavigationHops()
    expect(hops.classify(request({ id: 1, initiatorOrigin: 'https://shop.example' }))).toBe('page')
    expect(hops.classify(request({ id: 2, initiatorOrigin: 'null' })), 'an opaque origin is a page\'s too').toBe('page')
    expect(hops.classify(request({ id: 3, referrer: 'https://shop.example/' })), 'a tab a page opened carries the page as its referrer').toBe('page')
  })

  it('keeps the tabs apart, and forgets a tab that closes', () => {
    const hops = createNavigationHops()
    expect(hops.classify(request({ id: 1, webContentsId: 1 }))).toBe('browser')
    expect(hops.classify(request({ id: 1, webContentsId: 2 })), 'the same id in another tab is another navigation').toBe('browser')
    expect(hops.classify(request({ id: 1, webContentsId: 1 }))).toBe('redirect')
    hops.forget(1)
    expect(hops.classify(request({ id: 1, webContentsId: 1 }))).toBe('browser')
  })

  it('takes a request it cannot place in a tab for a page\'s', () => {
    const hops = createNavigationHops()
    expect(hops.classify({ id: 1, referrer: '' })).toBe('page')
  })
})
