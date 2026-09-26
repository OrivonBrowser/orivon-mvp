import { afterEach, describe, expect, it, vi } from 'vitest'
import { DDOC_PATH, MAX_DDOC_BYTES } from '../../ddoc-declaration.js'
import { fetchBundle } from '../bundle.js'
import type { Fetch } from '../bundle.js'
import { parseManifest } from '../../manifest/manifest.js'
import { MANIFEST_URL, ORIGIN, PUBLIC_RESOLVER, manifestJson, memoryStorage, stubFetch, utf8 } from '../../tests/test-helpers.js'
import type { RouteSpec } from '../../tests/test-helpers.js'

// ADR-0029: the hash tree a site publishes about itself is fetched and
// handed on, and nothing about it ever decides whether the bundle loads.

const DDOC_URL = `${ORIGIN}${DDOC_PATH}`

function bundleRoutes (): Record<string, RouteSpec> {
  return {
    [MANIFEST_URL]: { body: utf8(manifestJson({ assets: ['app.js'] })) },
    [`${ORIGIN}/index.html`]: { body: utf8('<!doctype html><title>a</title>') },
    [`${ORIGIN}/app.js`]: { body: utf8('console.log(1)') }
  }
}

/** The tree an honest publisher would write for bundleRoutes(), computed by the loader itself -- never a second hash implementation. */
async function honestDdoc (): Promise<{ bundleHash: string, leaves: Record<string, string> }> {
  const result = await fetchBundle(stubFetch(bundleRoutes()), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
  if (!result.ok) throw new Error(result.reason)
  return { bundleHash: result.tree.root, leaves: Object.fromEntries(result.tree.assets.map((a) => [a.path, a.leaf])) }
}

async function fetchWithDdoc (spec: RouteSpec | undefined, bodyReadSpy?: Set<string>): Promise<Awaited<ReturnType<typeof fetchBundle>>> {
  const routes = bundleRoutes()
  if (spec !== undefined) routes[DDOC_URL] = spec
  return await fetchBundle(stubFetch(routes, bodyReadSpy), ORIGIN, PUBLIC_RESOLVER, memoryStorage())
}

afterEach(() => { vi.restoreAllMocks() })

describe('fetchBundle: the published DDOC hash tree', () => {
  it('returns the published tree beside the computed one, and never hashes it as a leaf', async () => {
    const ddoc = await honestDdoc()
    const result = await fetchWithDdoc({ body: utf8(JSON.stringify(ddoc)) })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tree.root).toBe(ddoc.bundleHash)
    expect(result.tree.assets.map((a) => a.path)).not.toContain(DDOC_PATH)
    expect(result.declaration?.bundleHash).toBe(ddoc.bundleHash)
    expect(result.declaration?.leaves).toEqual(result.tree.assets)
  })

  it('a tree that does not match still loads: the trust page judges it, the loader does not', async () => {
    const ddoc = { ...(await honestDdoc()), bundleHash: 'sha256:' + 'f'.repeat(64) }
    const result = await fetchWithDdoc({ body: utf8(JSON.stringify(ddoc)) })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.declaration?.bundleHash).toBe(ddoc.bundleHash)
    expect(result.tree.root).not.toBe(ddoc.bundleHash)
  })

  it('a 404 or a network error is "not published", and the bundle still loads', async () => {
    for (const spec of [{ status: 404, body: utf8('') }, undefined]) {
      const result = await fetchWithDdoc(spec)
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.declaration).toBeUndefined()
    }
  })

  it('an index page served for the path is "not published", logged with a hint', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const result = await fetchWithDdoc({ body: utf8('<!doctype html><title>spa</title>') })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.declaration).toBeUndefined()
    expect(info).toHaveBeenCalledWith(expect.stringContaining('HTML page'))
  })

  const LEAF = 'sha256:' + '1'.repeat(64)
  it.each([
    ['not JSON', 'not json'],
    ['an array', '[]'],
    ['no bundleHash', JSON.stringify({ leaves: { '/index.html': LEAF } })],
    ['a numeric bundleHash', JSON.stringify({ bundleHash: 1, leaves: { '/index.html': LEAF } })],
    ['63 hex digits', JSON.stringify({ bundleHash: 'sha256:' + 'a'.repeat(63), leaves: { '/index.html': LEAF } })],
    ['uppercase hex, never repaired', JSON.stringify({ bundleHash: 'sha256:' + 'A'.repeat(64), leaves: { '/index.html': LEAF } })],
    ['an uppercase prefix', JSON.stringify({ bundleHash: 'SHA256:' + 'a'.repeat(64), leaves: { '/index.html': LEAF } })],
    ['no leaves', JSON.stringify({ bundleHash: LEAF })],
    ['empty leaves', JSON.stringify({ bundleHash: LEAF, leaves: {} })],
    ['leaves as an array', JSON.stringify({ bundleHash: LEAF, leaves: [LEAF] })],
    ['a leaf path with no leading slash', JSON.stringify({ bundleHash: LEAF, leaves: { 'index.html': LEAF } })],
    ['a traversal leaf path', JSON.stringify({ bundleHash: LEAF, leaves: { '/../index.html': LEAF } })],
    ['a malformed leaf digest', JSON.stringify({ bundleHash: LEAF, leaves: { '/index.html': 'sha256:zz' } })],
    ['only a __proto__ key', '{"__proto__": {"bundleHash": "' + LEAF + '", "leaves": {"/index.html": "' + LEAF + '"}}}']
  ])('%s is "not published", and the bundle still loads', async (_label, body) => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const result = await fetchWithDdoc({ body: utf8(body) })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.declaration).toBeUndefined()
  })

  it('a declared length over MAX_DDOC_BYTES is refused without reading a byte of it', async () => {
    const bodyReadSpy = new Set<string>()
    const result = await fetchWithDdoc({ body: utf8('{}'), headers: { 'content-length': String(MAX_DDOC_BYTES + 1) } }, bodyReadSpy)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.declaration).toBeUndefined()
    expect(bodyReadSpy.has(DDOC_URL)).toBe(false)
  })

  it('a streamed body over MAX_DDOC_BYTES is refused, and the bundle still loads', async () => {
    const result = await fetchWithDdoc({ body: new Uint8Array(MAX_DDOC_BYTES + 1).fill(0x20) })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.declaration).toBeUndefined()
  })

  // Asked with the same pinned literals as the rest of the bundle, and only
  // once the manifest has arrived: a 304 ends the check before it.
  it('is requested only after a changed manifest, never on a 304', async () => {
    const requested: string[] = []
    const routes = { ...bundleRoutes(), [MANIFEST_URL]: { status: 304, body: utf8('') } }
    const fetchFn: Fetch = async (url, pinned, signal, conditional) => {
      requested.push(url)
      return await stubFetch(routes)(url, pinned, signal, conditional)
    }
    const result = await fetchBundle(fetchFn, ORIGIN, PUBLIC_RESOLVER, memoryStorage(), undefined, { etag: '"v1"' })

    expect('notModified' in result).toBe(true)
    expect(requested).toEqual([MANIFEST_URL])
  })
})

describe('parseManifest: paths the loader fetches on its own are never assets', () => {
  it.each([
    '.well-known/orivon-ddoc.json',
    '.well-known/ORIVON-DDOC.json',
    '%2Ewell-known/orivon-ddoc.json',
    '.well-known/orivon.json'
  ])('refuses %s', (path) => {
    const parsed = parseManifest(manifestJson({ assets: [path] }))
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.reason).toContain('reserved path')
  })

  it('still accepts another file under .well-known', () => {
    expect(parseManifest(manifestJson({ assets: ['.well-known/assetlinks.json'] })).ok).toBe(true)
  })
})
