// A transient fault (a gateway's 502/503/504, a dropped connection) is
// retried a bounded number of times before the bundle is rejected; a
// definitive answer (404, a script served as HTML) rejects at once.

import { describe, expect, it, vi } from 'vitest'
import { MAX_ASSET_BYTES, MAX_BUNDLE_BYTES } from '../../../broker/policy/bundle-hash.js'
import { fetchBundle } from '../bundle.js'
import type { Fetch } from '../bundle.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, memoryStorage, stubFetch, utf8 } from '../../tests/test-helpers.js'
import type { RouteSpec } from '../../tests/test-helpers.js'

const LIMITS = { assetBytes: MAX_ASSET_BYTES, bundleBytes: MAX_BUNDLE_BYTES, retryBackoffMs: [1, 1] }
const APP_JS = `${ORIGIN}/app.js`

const routes: Record<string, RouteSpec> = {
  [MANIFEST_URL]: { body: utf8(manifestJson({ assets: ['app.js'] })) },
  [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html><title>a</title>') },
  [APP_JS]: { body: utf8('console.log(1)') }
}

/** `fault(n)` decides what the n-th request (from 1) for `url` does instead of the stub's answer. */
function flaky (url: string, fault: (attempt: number) => Response | Error | undefined): { fetchFn: Fetch, attempts: () => number } {
  const real = stubFetch(routes)
  let attempts = 0
  const fetchFn: Fetch = async (requested, pinned, signal, headers) => {
    if (requested !== url) return await real(requested, pinned, signal, headers)
    attempts += 1
    const injected = fault(attempts)
    if (injected instanceof Error) throw injected
    if (injected !== undefined) {
      return { ok: injected.ok, status: injected.status, url: requested, headers: injected.headers, body: injected.body, arrayBuffer: async () => await injected.arrayBuffer() }
    }
    return await real(requested, pinned, signal, headers)
  }
  return { fetchFn, attempts: () => attempts }
}

describe('fetchBundle: transient faults are retried', () => {
  it.each([502, 503, 504])('an asset that answers %i once is fetched again, and the bundle installs', async (status) => {
    const { fetchFn, attempts } = flaky(APP_JS, (n) => n === 1 ? new Response('bad gateway', { status }) : undefined)
    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), LIMITS)
    expect(result.ok).toBe(true)
    expect(attempts()).toBe(2)
  })

  it('a network error on an asset is retried', async () => {
    const { fetchFn, attempts } = flaky(APP_JS, (n) => n === 1 ? new TypeError('fetch failed') : undefined)
    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), LIMITS)
    expect(result.ok).toBe(true)
    expect(attempts()).toBe(2)
  })

  it('the manifest is retried too', async () => {
    const { fetchFn, attempts } = flaky(MANIFEST_URL, (n) => n === 1 ? new Response('', { status: 502 }) : undefined)
    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), LIMITS)
    expect(result.ok).toBe(true)
    expect(attempts()).toBe(2)
  })

  it('a body that breaks half way is fetched again, and the broken attempt does not eat the bundle budget', async () => {
    const body = utf8('console.log("0123456789")')
    const manifest = utf8(manifestJson({ assets: ['app.js'] }))
    const html = utf8('<!doctype html>')
    const exact = { assetBytes: MAX_ASSET_BYTES, bundleBytes: body.length + manifest.length + html.length, retryBackoffMs: [1, 1] }
    const real = stubFetch({ [MANIFEST_URL]: { body: manifest }, [`${ORIGIN}/index.html`]: { body: html }, [APP_JS]: { body } })
    let attempts = 0
    const fetchFn: Fetch = async (url, pinned, signal, headers) => {
      if (url !== APP_JS) return await real(url, pinned, signal, headers)
      attempts += 1
      if (attempts > 1) return await real(url, pinned, signal, headers)
      let sent = false
      const broken = new ReadableStream<Uint8Array>({
        pull (controller) {
          if (sent) { controller.error(new TypeError('terminated')); return }
          sent = true
          controller.enqueue(body.slice(0, 10))
        }
      }, { highWaterMark: 0 })
      return { ok: true, status: 200, url, body: broken, arrayBuffer: async () => new ArrayBuffer(0) }
    }
    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), exact)
    expect(result.ok).toBe(true)
    expect(attempts).toBe(2)
  })
})

describe('fetchBundle: the retry is bounded and only for transient faults', () => {
  it('rejects, naming the status, once every attempt has failed, and marks the failure transient', async () => {
    const { fetchFn, attempts } = flaky(APP_JS, () => new Response('', { status: 502 }))
    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), LIMITS)
    expect(result).toMatchObject({ ok: false, transient: true })
    expect(!result.ok && result.reason).toContain('HTTP 502')
    expect(attempts()).toBe(3)
  })

  it('does not retry a 404', async () => {
    const { fetchFn, attempts } = flaky(APP_JS, () => new Response('', { status: 404 }))
    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), LIMITS)
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('transient')
    expect(attempts()).toBe(1)
  })

  it('does not retry a script served as an HTML page', async () => {
    const { fetchFn, attempts } = flaky(APP_JS, () => new Response('<!doctype html><p>', { status: 200, headers: { 'content-type': 'text/html' } }))
    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), LIMITS)
    expect(result.ok).toBe(false)
    expect(attempts()).toBe(1)
  })

  it('stops waiting between attempts when the bundle deadline passes', async () => {
    vi.useFakeTimers()
    try {
      const { fetchFn, attempts } = flaky(APP_JS, () => new Response('', { status: 502 }))
      const pending = fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), { ...LIMITS, retryBackoffMs: [60 * 60_000, 60 * 60_000] })
      await vi.advanceTimersByTimeAsync(31 * 60_000)
      const result = await pending
      expect(result.ok).toBe(false)
      expect(attempts()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
