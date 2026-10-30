// fetchBundle reads what the entry page leads to first: a page that starts its main program only
// through another script still has that program read before the files nothing names. Content only
// reorders the declared list, and the result is what it was.

import { describe, expect, it } from 'vitest'
import { MAX_ASSET_BYTES, MAX_BUNDLE_BYTES, bundleTree } from '../../../broker/policy/bundle-hash.js'
import { FETCH_CONCURRENCY } from '../asset.js'
import { fetchBundle } from '../bundle.js'
import type { Fetch } from '../bundle.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, memoryStorage, stubFetch, utf8 } from '../../tests/test-helpers.js'
import type { RouteSpec } from '../../tests/test-helpers.js'

const LIMITS = { assetBytes: MAX_ASSET_BYTES, bundleBytes: MAX_BUNDLE_BYTES, retryBackoffMs: [1, 1] }

const CHUNKS = Array.from({ length: 24 }, (_, i) => `${String(1001 + i * 16)}.chunk.js`)
const MAIN_URL = `${ORIGIN}/main.bundle.js`

/** The files of an app whose page starts its main program through `bridge.js`, with the chunks sorted before everything else, as a publisher's tool lists them. */
function appFiles (index = '<!doctype html><script src="bridge.js"></script>'): Record<string, string> {
  return {
    'index.html': index,
    ...Object.fromEntries(CHUNKS.map((chunk) => [chunk, `// ${chunk}`])),
    'bridge.js': 'if (typeof process !== \'undefined\') document.write(\'<script defer src="./main.bundle.js"></script>\')',
    'main.bundle.js': 'document.body.dataset.app = "main"'
  }
}

function manifestOf (files: Record<string, string>): string {
  return manifestJson({ entry: 'index.html', assets: Object.keys(files).filter((path) => path !== 'index.html').sort() })
}

function routesOf (files: Record<string, string>): Record<string, RouteSpec> {
  const routes: Record<string, RouteSpec> = { [MANIFEST_URL]: { body: utf8(manifestOf(files)) } }
  for (const [path, content] of Object.entries(files)) routes[`${ORIGIN}/${path}`] = { body: utf8(content) }
  return routes
}

const pathOf = (url: string): string => url.slice(ORIGIN.length + 1)
const isDeclared = (path: string): boolean => !path.startsWith('.well-known/')

/**
 * `base` (the stub over `routes` when absent) noting each path asked for. Requests for which `hold` is true wait until
 * `release` is true of a request, or 400 ms have passed, so a wrong order fails a test instead of hanging it.
 */
function recording (routes: Record<string, RouteSpec>, hold?: (url: string) => boolean, release?: (url: string) => boolean, base: Fetch = stubFetch(routes)): { fetchFn: Fetch, asked: string[] } {
  const asked: string[] = []
  let open: () => void = () => {}
  const gate = new Promise<void>((resolve) => { open = resolve })
  const fallback = hold === undefined ? undefined : setTimeout(open, 400)
  const fetchFn: Fetch = async (url, pinned, signal, headers) => {
    asked.push(pathOf(url))
    if (release?.(url) === true) { open(); clearTimeout(fallback) }
    if (hold?.(url) === true) await gate
    return await base(url, pinned, signal, headers)
  }
  return { fetchFn, asked }
}

const isChunk = (url: string): boolean => url.endsWith('.chunk.js')

describe('fetchBundle: the files the entry leads to are read first', () => {
  it('reads main.bundle.js, which only bridge.js names, before the chunks that nothing names', async () => {
    const { fetchFn, asked } = recording(routesOf(appFiles()), isChunk, (url) => url === MAIN_URL)

    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), LIMITS)

    expect(result.ok).toBe(true)
    // The lanes that are not reading bridge.js are already on chunks by then: at most one fewer than the lanes.
    const chunksBefore = asked.slice(0, asked.indexOf('main.bundle.js')).filter((path) => path.endsWith('.chunk.js'))
    expect(chunksBefore.length).toBeLessThan(FETCH_CONCURRENCY)
  })

  it('reads the entry alone: no other declared file is asked for until it has been read', async () => {
    const real = stubFetch(routesOf(appFiles()))
    let entryPending = false
    const askedWhilePending: string[] = []
    const fetchFn: Fetch = async (url, pinned, signal, headers) => {
      const path = pathOf(url)
      if (entryPending && isDeclared(path)) askedWhilePending.push(path)
      if (path !== 'index.html') return await real(url, pinned, signal, headers)
      entryPending = true
      await new Promise((resolve) => setTimeout(resolve, 20))
      const response = await real(url, pinned, signal, headers)
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull (controller) {
          const step = await reader.read()
          if (!step.done) { controller.enqueue(step.value); return }
          entryPending = false
          controller.close()
        }
      }, { highWaterMark: 0 })
      return { ...response, body }
    }

    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), LIMITS)

    expect(result.ok).toBe(true)
    expect(askedWhilePending).toEqual([])
  })

  it('requests every declared file exactly once', async () => {
    const files = appFiles()
    const { fetchFn, asked } = recording(routesOf(files))

    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), LIMITS)

    expect(result.ok).toBe(true)
    expect(asked.filter(isDeclared).sort()).toEqual(Object.keys(files).sort())
  })

  it('gives the tree bundleTree computes over the same bytes read in the manifest\'s order, with the entries listed as the manifest does', async () => {
    const files = appFiles()

    const result = await fetchBundle(stubFetch(routesOf(files)), ORIGIN, PUBLIC_RESOLVER, memoryStorage(), LIMITS)

    const declared = ['index.html', ...Object.keys(files).filter((path) => path !== 'index.html').sort()]
    const expected = await bundleTree([
      { path: '/.well-known/orivon.json', content: utf8(manifestOf(files)) },
      ...declared.map((path) => ({ path: `/${path}`, content: utf8(files[path] as string) }))
    ])
    expect(result.ok && result.tree).toEqual(expected)
    expect(result.ok && result.entries.map((entry) => entry.path)).toEqual(['/.well-known/orivon.json', ...declared.map((path) => `/${path}`)])
  })

  it('never requests a file the manifest does not list, however a page names it', async () => {
    const files = appFiles('<!doctype html><script src="bridge.js"></script><script src="secret.js"></script><script src="//evil.example/main.bundle.js"></script><script src="../../etc/passwd.js"></script>')
    const { fetchFn, asked } = recording(routesOf(files))

    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), LIMITS)

    expect(result.ok).toBe(true)
    expect(asked.filter((path) => /secret|evil|passwd/.test(path))).toEqual([])
  })

  it('reads a retried file from its last attempt: a first attempt that broke half way does not hide what the file names', async () => {
    const files = appFiles()
    const routes = routesOf(files)
    const bridge = utf8(files['bridge.js'] as string)
    const real = stubFetch(routes)
    let bridgeAttempts = 0
    const base: Fetch = async (url, pinned, signal, headers) => {
      if (url !== `${ORIGIN}/bridge.js` || (bridgeAttempts += 1) > 1) return await real(url, pinned, signal, headers)
      let sent = false
      const broken = new ReadableStream<Uint8Array>({
        pull (controller) {
          if (sent) { controller.error(new TypeError('terminated')); return }
          sent = true
          controller.enqueue(bridge.slice(0, 10))
        }
      }, { highWaterMark: 0 })
      return { ok: true, status: 200, url, body: broken, arrayBuffer: async () => new ArrayBuffer(0) }
    }
    const { fetchFn, asked } = recording(routes, isChunk, (url) => url === MAIN_URL, base)

    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), LIMITS)

    expect(result.ok).toBe(true)
    expect(bridgeAttempts).toBe(2)
    expect(asked.filter((path) => path === 'main.bundle.js')).toHaveLength(1)
    const chunksBefore = asked.slice(0, asked.indexOf('main.bundle.js')).filter((path) => path.endsWith('.chunk.js'))
    expect(chunksBefore.length).toBeLessThan(FETCH_CONCURRENCY)
  })
})

describe('fetchBundle: a failed file still stops the bundle', () => {
  it('rejects, naming the file, when the file read first fails', async () => {
    const routes = routesOf(appFiles())
    routes[MAIN_URL] = { body: utf8(''), status: 404 }

    const result = await fetchBundle(stubFetch(routes), ORIGIN, PUBLIC_RESOLVER, memoryStorage(), LIMITS)

    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toContain('main.bundle.js')
  })

  it('rejects when the entry itself fails, before any other declared file is asked for', async () => {
    const routes = routesOf(appFiles())
    routes[`${ORIGIN}/index.html`] = { body: utf8(''), status: 404 }
    const { fetchFn, asked } = recording(routes)

    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), LIMITS)

    expect(result.ok).toBe(false)
    expect(asked.filter(isDeclared)).toEqual(['index.html'])
  })
})
