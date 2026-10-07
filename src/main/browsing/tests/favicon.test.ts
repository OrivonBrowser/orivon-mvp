import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FaviconTarget } from '../favicon.js'

// fetchFaviconDataUrlCached dynamically imports 'electron' for net.request (see
// favicon-fetch.ts's file header for why net.request, not net.fetch) -- mocked
// here so every network-touching test below can hand it a scripted
// response without a real network call. That mock is also why every symbol
// below arrives through a dynamic import rather than a static one: it has
// to be registered before favicon.js is evaluated.
vi.mock('electron', () => ({
  net: { request: vi.fn() }
}))

const { net } = await import('electron')
const { MAX_FAVICON_CANDIDATES, captureFaviconInto, faviconCandidates, faviconOnCommit, shouldClearFavicon } = await import('../favicon.js')
const { mockRequestOnce, PNG_BYTES, PUBLIC_PAGE, respondOk } = await import('./favicon.test-helpers.js')

// net.request is one shared mock across the whole file (the module-level
// `const { net }` above), so a call recorded in one test would otherwise
// still be there for the next -- every test that asserts on it starts clean.
beforeEach(() => {
  vi.mocked(net.request).mockReset()
})

describe('faviconCandidates', () => {
  it('returns an empty list for an empty list', () => {
    expect(faviconCandidates([])).toEqual([])
  })

  it('keeps http(s) candidates, in order', () => {
    expect(faviconCandidates(['https://a.example/icon.png', 'http://b.example/icon.png']))
      .toEqual(['https://a.example/icon.png', 'http://b.example/icon.png'])
  })

  it('keeps a data: candidate too', () => {
    expect(faviconCandidates(['data:image/png;base64,AAA=', 'https://a.example/icon.png']))
      .toEqual(['data:image/png;base64,AAA=', 'https://a.example/icon.png'])
  })

  it('drops anything that is not http(s) or data:', () => {
    expect(faviconCandidates(['javascript:alert(1)', 'https://a.example/icon.png']))
      .toEqual(['https://a.example/icon.png'])
  })

  it('returns an empty list when nothing qualifies', () => {
    expect(faviconCandidates(['javascript:alert(1)', 'blob:whatever'])).toEqual([])
  })

  it('caps at MAX_FAVICON_CANDIDATES', () => {
    const many = Array.from({ length: MAX_FAVICON_CANDIDATES + 5 }, (_, i) => `https://a.example/${String(i)}.png`)
    expect(faviconCandidates(many)).toHaveLength(MAX_FAVICON_CANDIDATES)
  })
})

describe('shouldClearFavicon', () => {
  it('does nothing when nothing has been captured yet', () => {
    expect(shouldClearFavicon(null, 'https://a.example/page2')).toBe(false)
  })

  it('does not clear on a same-origin navigation', () => {
    expect(shouldClearFavicon('https://a.example', 'https://a.example/page2')).toBe(false)
  })

  it('clears on a cross-origin navigation', () => {
    expect(shouldClearFavicon('https://a.example', 'https://b.example/')).toBe(true)
  })

  // Different scheme or port is a different origin even with the same
  // hostname -- URL.origin already encodes this, exercised here so a
  // future refactor away from URL.origin doesn't silently drop it.
  it('treats a different scheme or port as a different origin', () => {
    expect(shouldClearFavicon('https://a.example', 'http://a.example/')).toBe(true)
    expect(shouldClearFavicon('https://a.example:443', 'https://a.example:8443/')).toBe(true)
  })

  // about:blank does not throw -- URL('about:blank').origin is the
  // literal string "null", which simply compares unequal below.
  it('clears when navigating to about:blank', () => {
    expect(shouldClearFavicon('https://a.example', 'about:blank')).toBe(true)
  })

  it('clears for a string that is not a parseable URL at all', () => {
    expect(shouldClearFavicon('https://a.example', 'not a url')).toBe(true)
  })
})

describe('captureFaviconInto', () => {
  function makeTarget (): FaviconTarget {
    return { favicon: null, faviconOrigin: null, pendingFaviconUrl: null }
  }

  it('decodes a data: candidate locally, with no network reach at all', async () => {
    const svg = '<svg></svg>'
    const dataUrl = `data:image/svg+xml,${encodeURIComponent(svg)}`
    const target = makeTarget()
    let updated = false

    await captureFaviconInto(target, [dataUrl], () => PUBLIC_PAGE, () => true, () => { updated = true })

    expect(net.request).not.toHaveBeenCalled()
    expect(target.favicon).toBe(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    expect(updated).toBe(true)
  })

  it('falls through to the next candidate once the first fails to decode', async () => {
    mockRequestOnce((request) => { request.emit('error', new Error('refused')) })
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    const target = makeTarget()

    await captureFaviconInto(
      target,
      ['https://93.184.216.34/bad.ico', 'https://93.184.216.34/good.png'],
      () => PUBLIC_PAGE,
      () => true,
      () => {}
    )

    expect(target.favicon).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`)
  })

  it('signals no change when every candidate fails and no icon was shown', async () => {
    mockRequestOnce((request) => { request.emit('error', new Error('refused')) })
    const target = makeTarget()
    let updated = false

    await captureFaviconInto(target, ['https://93.184.216.34/bad.ico'], () => PUBLIC_PAGE, () => true, () => { updated = true })

    expect(target.favicon).toBeNull()
    expect(updated).toBe(false)
  })

  it('shows the globe once every candidate a page announced has failed, over an icon the tab remembered for the site', async () => {
    mockRequestOnce((request) => { request.emit('response', respondOk(404, [])) })
    const target: FaviconTarget = { favicon: 'data:image/png;base64,Qw==', faviconOrigin: 'https://example.com', pendingFaviconUrl: null }
    let updated = false

    await captureFaviconInto(target, ['https://93.184.216.34/favicon.ico'], () => PUBLIC_PAGE, () => true, () => { updated = true })

    expect(target.favicon).toBeNull()
    expect(target.faviconOrigin).toBe('https://example.com')
    expect(updated).toBe(true)
  })

  it('keeps the globe on a same-site page that announces nothing after one whose icons all failed', async () => {
    mockRequestOnce((request) => { request.emit('response', respondOk(404, [])) })
    const target: FaviconTarget = { favicon: 'data:image/png;base64,Qw==', faviconOrigin: 'https://example.com', pendingFaviconUrl: null }

    await captureFaviconInto(target, ['https://93.184.216.34/favicon.ico'], () => PUBLIC_PAGE, () => true, () => {})
    faviconOnCommit(target, 'https://example.com/other', () => 'data:image/png;base64,Qw==')

    expect(target.favicon).toBeNull()
  })

  it('brings back the globe, not the site\'s earlier icon, on returning after a blank page to a site whose last page had none', async () => {
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    mockRequestOnce((request) => { request.emit('response', respondOk(404, [])) })
    const target: FaviconTarget = { favicon: null, faviconOrigin: null, pendingFaviconUrl: null }

    await captureFaviconInto(target, ['https://93.184.216.34/icon.png'], () => 'https://example.com/icon', () => true, () => {})
    expect(target.favicon).not.toBeNull()
    await captureFaviconInto(target, ['https://93.184.216.34/favicon.ico'], () => 'https://example.com/plain', () => true, () => {})
    faviconOnCommit(target, 'about:blank')
    faviconOnCommit(target, 'https://example.com/plain', () => 'data:image/png;base64,Qw==')

    expect(target.favicon).toBeNull()
  })

  // The bug this fixes: favicon.ts used to record the ICON's own origin
  // (here, a CDN host different from the page), which shouldClearFavicon
  // then compared against the PAGE's origin on every navigation -- so an
  // icon hosted off-origin was cleared on the very next same-origin
  // navigation and never came back (page-favicon-updated does not refire
  // for an unchanged icon set).
  it('records the DECLARING PAGE\'s origin, not the icon resource\'s own origin', async () => {
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    const target = makeTarget()
    const page = 'https://a.example/page'

    // A public literal address, not a.example's own hostname -- a real CDN
    // icon, and a literal needs no DNS resolver mock to clear T12.
    await captureFaviconInto(target, ['https://93.184.216.34/icon.png'], () => page, () => true, () => {})

    expect(target.faviconOrigin).toBe('https://a.example')
    // The whole point of the fix: a same-origin navigation must not clear it.
    expect(shouldClearFavicon(target.faviconOrigin, 'https://a.example/page2')).toBe(false)
  })

  it('does nothing for an empty or all-unqualified candidate list', async () => {
    const target = makeTarget()
    await captureFaviconInto(target, [], () => PUBLIC_PAGE, () => true, () => {})
    await captureFaviconInto(target, ['javascript:alert(1)'], () => PUBLIC_PAGE, () => true, () => {})
    expect(net.request).not.toHaveBeenCalled()
    expect(target.favicon).toBeNull()
  })

  it('decodes an upper-case DATA: candidate locally too, never falling through to a network fetch', async () => {
    const target = makeTarget()
    await captureFaviconInto(target, ['DATA:image/png;base64,' + Buffer.from(PNG_BYTES).toString('base64')], () => PUBLIC_PAGE, () => true, () => {})
    expect(net.request).not.toHaveBeenCalled()
    expect(target.favicon).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`)
  })

  // A sequential, multi-candidate loop with a timeout and redirect budget per
  // candidate can still be running after the tab has moved to another origin
  // whose page never fired its own page-favicon-updated (an unchanged icon
  // set) -- pendingFaviconUrl alone does not catch that, since nothing
  // overwrote it.
  it('never writes a favicon once the tab has navigated to another origin mid-fetch', async () => {
    let currentPage = 'https://a.example/page1'
    mockRequestOnce((request) => {
      // The tab commits a navigation while this request is still in flight.
      currentPage = 'https://b.example/page2'
      request.emit('response', respondOk(200, [PNG_BYTES]))
    })
    const target = makeTarget()
    let updated = false

    // A candidate URL no earlier test in this file used: faviconCache is
    // shared module state across every test, and a cache hit would skip
    // net.request entirely, exercising nothing this test exists to prove.
    await captureFaviconInto(target, ['https://93.184.216.99/race-icon.png'], () => currentPage, () => true, () => { updated = true })

    expect(target.favicon).toBeNull()
    expect(target.faviconOrigin).toBeNull()
    expect(updated).toBe(false)
  })

  it('does not cache an icon the capture dropped, so the next page asks again', async () => {
    const icon = 'https://93.184.216.97/dropped.png'
    let currentPage = 'https://a.example/'
    mockRequestOnce((request) => {
      currentPage = 'https://b.example/'
      request.emit('response', respondOk(200, [PNG_BYTES]))
    })
    await captureFaviconInto(makeTarget(), [icon], () => currentPage, () => true, () => {})

    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    const target = makeTarget()
    await captureFaviconInto(target, [icon], () => 'https://c.example/', () => true, () => {})

    expect(net.request).toHaveBeenCalledTimes(2)
    expect(target.favicon).not.toBeNull()
  })

  it('answers a second capture of the same icon from the cache', async () => {
    const icon = 'https://93.184.216.97/kept.png'
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    await captureFaviconInto(makeTarget(), [icon], () => 'https://a.example/', () => true, () => {})

    const target = makeTarget()
    await captureFaviconInto(target, [icon], () => 'https://c.example/', () => true, () => {})

    expect(net.request).toHaveBeenCalledTimes(1)
    expect(target.favicon).not.toBeNull()
  })

  // page-favicon-updated does not fire again for a hash change, a
  // pushState/replaceState, or a same-origin page declaring the same icon
  // set (measured on Electron 44), so dropping the icon here would leave the
  // globe for the rest of the visit.
  it.each([
    ['a hash change', 'https://a.example/page', 'https://a.example/page#section'],
    ['a replaceState to a sibling path', 'https://a.example/', 'https://a.example/home'],
    ['a same-origin navigation', 'https://a.example/one', 'https://a.example/two?x=1']
  ])('still stores the icon after %s mid-fetch', async (_label, declaringPage, laterPage) => {
    let currentPage = declaringPage
    mockRequestOnce((request) => {
      currentPage = laterPage
      request.emit('response', respondOk(200, [PNG_BYTES]))
    })
    const target = makeTarget()
    let updated = false

    await captureFaviconInto(target, [`https://93.184.216.98/${encodeURIComponent(laterPage)}.png`], () => currentPage, () => true, () => { updated = true })

    expect(target.favicon).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`)
    expect(target.faviconOrigin).toBe('https://a.example')
    expect(updated).toBe(true)
  })
})

describe('faviconOnCommit', () => {
  /** A tab that has shown the icon `data:A` for a.example, as a capture leaves it. */
  async function tabShowingA (): Promise<FaviconTarget> {
    const target: FaviconTarget = { favicon: null, faviconOrigin: null, pendingFaviconUrl: null }
    const svg = `data:image/svg+xml,${encodeURIComponent('<svg id="a"></svg>')}`
    await captureFaviconInto(target, [svg], () => 'https://a.example/', () => true, () => {})
    expect(target.favicon).not.toBeNull()
    return target
  }

  it('clears the icon on a blank page, and brings it back on returning to the site it came from', async () => {
    const target = await tabShowingA()
    const icon = target.favicon

    faviconOnCommit(target, 'about:blank')
    expect(target.favicon).toBeNull()
    expect(target.faviconOrigin).toBeNull()

    faviconOnCommit(target, 'https://a.example/x')
    expect(target.favicon).toBe(icon)
    expect(target.faviconOrigin).toBe('https://a.example')
  })

  it('shows no icon of another site\'s on a page of a site it has not shown', async () => {
    const target = await tabShowingA()
    faviconOnCommit(target, 'https://b.example/')
    expect(target.favicon).toBeNull()
  })

  it('keeps the icon on a page of the same origin', async () => {
    const target = await tabShowingA()
    const icon = target.favicon
    faviconOnCommit(target, 'https://a.example/page2')
    expect(target.favicon).toBe(icon)
  })

  it('falls back to the icon the history keeps for the site when the tab never showed it', () => {
    const target: FaviconTarget = { favicon: null, faviconOrigin: null, pendingFaviconUrl: null }
    faviconOnCommit(target, 'https://c.example/', () => 'data:image/png;base64,Qw==')
    expect(target.favicon).toBe('data:image/png;base64,Qw==')
    expect(target.faviconOrigin).toBe('https://c.example')
  })

  it('remembers the last few sites only: the oldest is forgotten first', async () => {
    const target: FaviconTarget = { favicon: null, faviconOrigin: null, pendingFaviconUrl: null }
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      faviconOnCommit(target, `https://${name}.example/`)
      await captureFaviconInto(target, [`data:image/svg+xml,${encodeURIComponent(`<svg id="${name}"></svg>`)}`], () => `https://${name}.example/`, () => true, () => {})
    }
    faviconOnCommit(target, 'about:blank')
    faviconOnCommit(target, 'https://a.example/')
    expect(target.favicon).toBeNull()
    faviconOnCommit(target, 'about:blank')
    faviconOnCommit(target, 'https://e.example/')
    expect(target.favicon).not.toBeNull()
  })
})

describe('captureFaviconInto -- which session asks', () => {
  const pageSession = { id: 'the page\'s own session' } as unknown as import('electron').Session

  it('asks for an icon on the page\'s own origin through the page\'s session, which serves an installed app from its pin', async () => {
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    const target: FaviconTarget = { favicon: null, faviconOrigin: null, pendingFaviconUrl: null }

    await captureFaviconInto(target, ['https://example.com/icon.png'], () => PUBLIC_PAGE, () => true, () => {}, pageSession)

    expect(vi.mocked(net.request).mock.calls[0]?.[0]).toMatchObject({ url: 'https://example.com/icon.png', session: pageSession, credentials: 'omit' })
    expect(target.favicon).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString('base64')}`)
  })

  it('asks for an icon on another host through the default session', async () => {
    mockRequestOnce((request) => { request.emit('response', respondOk(200, [PNG_BYTES])) })
    const target: FaviconTarget = { favicon: null, faviconOrigin: null, pendingFaviconUrl: null }

    await captureFaviconInto(target, ['https://93.184.216.34/cdn-icon.png'], () => PUBLIC_PAGE, () => true, () => {}, pageSession)

    expect(vi.mocked(net.request).mock.calls[0]?.[0]).not.toHaveProperty('session')
  })
})

describe('captureFaviconInto -- a host the verifier serves', () => {
  it('keeps the site\'s icon the tab shows when the page\'s own icon does not arrive', async () => {
    mockRequestOnce((request) => { request.emit('error', new Error('the gateways did not answer')) })
    const kept = 'data:image/png;base64,Qw=='
    const target: FaviconTarget = { favicon: kept, faviconOrigin: 'https://explore.orivonstack.eth', pendingFaviconUrl: null }
    let updated = false

    await captureFaviconInto(target, ['https://explore.orivonstack.eth/icon.svg'], () => 'https://explore.orivonstack.eth/', () => true, () => { updated = true })

    expect(target.favicon).toBe(kept)
    expect(updated).toBe(false)
  })

  it('still shows the globe when it had no icon for the site', async () => {
    mockRequestOnce((request) => { request.emit('error', new Error('the gateways did not answer')) })
    const target: FaviconTarget = { favicon: null, faviconOrigin: null, pendingFaviconUrl: null }

    await captureFaviconInto(target, ['https://explore.orivonstack.eth/icon.svg'], () => 'https://explore.orivonstack.eth/', () => true, () => {})

    expect(target.favicon).toBeNull()
    expect(target.faviconOrigin).toBe('https://explore.orivonstack.eth')
  })
})
