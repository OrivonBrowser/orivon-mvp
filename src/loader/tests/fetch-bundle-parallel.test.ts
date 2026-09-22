// fetchBundle's two throughput rules: assets are fetched a bounded few at a
// time, and a download is dropped for going quiet, never for merely being
// long.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bundleTree } from '../../broker/policy/bundle-hash.js'
import { FETCH_CONCURRENCY } from '../fetch-asset.js'
import { FETCH_IDLE_TIMEOUT_MS, fetchBundle } from '../fetch-bundle.js'
import type { Fetch } from '../fetch-bundle.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, memoryStorage, stubFetch, utf8 } from './test-helpers.js'
import type { RouteSpec } from './test-helpers.js'

describe('fetchBundle: bounded parallelism', () => {
  it(`fetches at most ${String(FETCH_CONCURRENCY)} assets at once, and more than one when there are several`, async () => {
    const paths = Array.from({ length: 10 }, (_, i) => `a${String(i)}.js`)
    const routes: Record<string, RouteSpec> = {
      [MANIFEST_URL]: { body: utf8(manifestJson({ entry: paths[0], assets: paths.slice(1) })) }
    }
    for (const path of paths) routes[`${ORIGIN}/${path}`] = { body: utf8(`// ${path}`) }

    let inFlight = 0
    let peak = 0
    const fetchFn: Fetch = async (url, pinnedAddresses, signal) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      try {
        return await stubFetch(routes)(url, pinnedAddresses, signal)
      } finally {
        inFlight -= 1
      }
    }

    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage())

    expect(result.ok).toBe(true)
    expect(peak).toBe(FETCH_CONCURRENCY)
  })

  it('produces the same tree bundleTree computes over the same bytes, whatever order the assets finish in', async () => {
    const paths = ['index.html', 'b.js', 'c.css', 'd.js', 'e.js', 'f.js']
    const manifest = utf8(manifestJson({ entry: paths[0], assets: paths.slice(1) }))
    const routes: Record<string, RouteSpec> = { [MANIFEST_URL]: { body: manifest } }
    for (const path of paths) routes[`${ORIGIN}/${path}`] = { body: utf8(`content of ${path}`) }
    const fetchFn: Fetch = async (url, pinnedAddresses, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 20 - url.length % 17))
      return await stubFetch(routes)(url, pinnedAddresses, signal)
    }

    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage())
    const expected = await bundleTree([
      { path: '/.well-known/orivon.json', content: manifest },
      ...paths.map((path) => ({ path: `/${path}`, content: utf8(`content of ${path}`) }))
    ])

    expect(result.ok && result.tree).toEqual(expected)
  })
})

describe('fetchBundle: an idle deadline, not a total one', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('completes an asset that takes several idle periods in total while bytes keep arriving', async () => {
    const chunkCount = 5
    const fetchFn: Fetch = async (url, pinnedAddresses, signal) => {
      if (url === MANIFEST_URL) return await stubFetch({ [MANIFEST_URL]: { body: utf8(manifestJson()) } })(url, pinnedAddresses, signal)
      let sent = 0
      const body = new ReadableStream<Uint8Array>({
        async pull (controller) {
          if (sent === chunkCount) { controller.close(); return }
          await new Promise<void>((resolve) => setTimeout(resolve, FETCH_IDLE_TIMEOUT_MS / 2))
          sent += 1
          controller.enqueue(utf8('<p>'))
        }
      }, { highWaterMark: 0 })
      return { ok: true, status: 200, url, body, arrayBuffer: async () => new ArrayBuffer(0) }
    }

    const pending = fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage())
    await vi.advanceTimersByTimeAsync(FETCH_IDLE_TIMEOUT_MS * chunkCount)
    const result = await pending

    expect(result.ok).toBe(true)
  })
})

describe('fetchBundle: an SPA host\'s index page is never pinned as a script', () => {
  const MANIFEST = { [MANIFEST_URL]: { body: utf8(manifestJson({ assets: ['assets/app.js'] })) } }

  it('refuses a .js asset answered with text/html', async () => {
    const routes: Record<string, RouteSpec> = { ...MANIFEST,
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') },
      [`${ORIGIN}/assets/app.js`]: { body: utf8('<!doctype html><title>app</title>'), headers: { 'content-type': 'text/html; charset=utf-8' } }
    }
    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/assets\/app\.js came back as an HTML page/)
  })

  it('refuses a .js asset whose body is an HTML document even with no Content-Type', async () => {
    const routes: Record<string, RouteSpec> = { ...MANIFEST,
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>') },
      [`${ORIGIN}/assets/app.js`]: { body: utf8('\n  <!DOCTYPE html><html></html>') }
    }
    expect((await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, memoryStorage())).ok).toBe(false)
  })

  it('accepts an HTML entry, and a script that merely contains markup', async () => {
    const routes: Record<string, RouteSpec> = { ...MANIFEST,
      [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html>'), headers: { 'content-type': 'text/html' } },
      [`${ORIGIN}/assets/app.js`]: { body: utf8('document.body.innerHTML = "<html>"'), headers: { 'content-type': 'text/javascript' } }
    }
    expect((await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, memoryStorage())).ok).toBe(true)
  })
})
