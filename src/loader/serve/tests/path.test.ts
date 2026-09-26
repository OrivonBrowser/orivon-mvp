import { describe, expect, it } from 'vitest'
import { bundleTree } from '../../../broker/policy/bundle-hash.js'
import { fromBundleTree } from '../../../broker/policy/pin.js'
import type { PinRecord } from '../../../broker/policy/pin.js'
import { isNavigationRequest, resolveRequestPath } from '../path.js'
import { createAppRequestHandler } from '../serve.js'
import { manifestJson, memoryStorage, ORIGIN, utf8 } from '../../tests/test-helpers.js'

/** The headers Chromium sends on a document navigation, as measured through protocol.handle. */
const NAVIGATION_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'upgrade-insecure-requests': '1'
}

async function pinOf (paths: readonly string[]): Promise<PinRecord> {
  const tree = await bundleTree([
    { path: '/.well-known/orivon.json', content: utf8(manifestJson()) },
    ...paths.map((path) => ({ path, content: utf8(path) }))
  ])
  return fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0)
}

describe('isNavigationRequest', () => {
  it('recognises Chromium\'s navigation headers, and not a subresource\'s', () => {
    expect(isNavigationRequest(new Request(`${ORIGIN}/x`, { headers: NAVIGATION_HEADERS }))).toBe(true)
    expect(isNavigationRequest(new Request(`${ORIGIN}/x`, { headers: { accept: '*/*' } }))).toBe(false)
    expect(isNavigationRequest(new Request(`${ORIGIN}/x`))).toBe(false)
  })

  it('lets Sec-Fetch-Mode decide whenever it is present', () => {
    expect(isNavigationRequest(new Request(`${ORIGIN}/x`, { headers: { ...NAVIGATION_HEADERS, 'sec-fetch-mode': 'cors' } }))).toBe(false)
  })
})

describe('resolveRequestPath: history fallback and a subdirectory entry', () => {
  it('a navigation to an unpinned route serves the entry; a subresource request for it is still denied', async () => {
    const pin = await pinOf(['/index.html', '/assets/app.js'])
    expect(resolveRequestPath('/index.html', pin, `${ORIGIN}/settings/profile`, true)).toEqual({ ok: true, canonicalPath: '/index.html' })
    expect(resolveRequestPath('/index.html', pin, `${ORIGIN}/settings/profile`, false).ok).toBe(false)
  })

  it('a navigation to an unpinned FILE (it has an extension) is still denied -- a missing chunk is a 404, not the entry', async () => {
    const pin = await pinOf(['/index.html'])
    expect(resolveRequestPath('/index.html', pin, `${ORIGIN}/assets/missing.js`, true).ok).toBe(false)
  })

  it('a pinned path is served as itself even on a navigation', async () => {
    const pin = await pinOf(['/index.html', '/about.html'])
    expect(resolveRequestPath('/index.html', pin, `${ORIGIN}/about.html`, true)).toEqual({ ok: true, canonicalPath: '/about.html' })
  })

  it('/ redirects to an entry in a subdirectory, so the entry\'s relative URLs resolve against its own directory', async () => {
    const pin = await pinOf(['/app/index.html'])
    expect(resolveRequestPath('/app/index.html', pin, `${ORIGIN}/`)).toEqual({ ok: true, redirectTo: '/app/index.html' })
  })
})

describe('createAppRequestHandler: the same rules end to end', () => {
  async function servedStorage (entry: string, files: Record<string, string>): Promise<ReturnType<typeof memoryStorage>> {
    const entries = [
      { path: '/.well-known/orivon.json', content: utf8(manifestJson({ entry })) },
      ...Object.entries(files).map(([path, text]) => ({ path, content: utf8(text) }))
    ]
    const tree = await bundleTree(entries)
    const storage = memoryStorage()
    for (const item of entries) await storage.writeAsset(ORIGIN, item.path, item.content)
    await storage.writePin(ORIGIN, fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0))
    return storage
  }

  it('a reload of a client-side route gets the entry document, as HTML', async () => {
    const handler = await createAppRequestHandler(await servedStorage('index.html', { '/index.html': '<h1>app</h1>' }), ORIGIN)
    const response = await handler(new Request(`${ORIGIN}/inbox/42`, { headers: NAVIGATION_HEADERS }))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await response.text()).toBe('<h1>app</h1>')
  })

  it('/ answers 302 to a subdirectory entry', async () => {
    const handler = await createAppRequestHandler(await servedStorage('app/index.html', { '/app/index.html': '<h1>app</h1>' }), ORIGIN)
    const response = await handler(new Request(`${ORIGIN}/`, { headers: NAVIGATION_HEADERS }))

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/app/index.html')
  })
})
