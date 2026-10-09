import { describe, expect, it, vi } from 'vitest'
import { MANIFEST_PATH } from '../../../broker/policy/canonical-path.js'
import { CONTENT_ROOT_HEADER, DDOC_MISMATCH, EXPECT_LEAF_HEADER, FAILURE_HEADER } from '../../fetch/content-root.js'
import { leafOf } from '../../leaf-hash.js'
import { parseManifest } from '../../manifest/manifest.js'
import { createLiveRequestHandler } from '../live-serve.js'
import type { LiveServeDeps } from '../live-serve.js'
import { manifestJson, ORIGIN, utf8 } from '../../tests/test-helpers.js'

const CID = 'bafybeiczdb3ssfsyyhhgvxwrkkqndv45umiz6vov46l4hvxukyolejbcgi'
const FILES: Record<string, string> = { '/index.html': '<h1>hello</h1>', '/app.js': 'run()', [MANIFEST_PATH]: manifestJson({ assets: ['app.js'] }) }

async function declared (): Promise<{ bundleHash: string, leaves: Array<{ path: string, leaf: string }> }> {
  const leaves = await Promise.all(Object.entries(FILES).map(async ([path, text]) => ({ path, leaf: await leafOf(path, utf8(text).length, [utf8(text)]) })))
  return { bundleHash: `sha256:${'a'.repeat(64)}`, leaves }
}

interface Seen { url: string, headers: Record<string, string>, method: string }

function manifestOf (overrides: Record<string, unknown> = {}): NonNullable<LiveServeDeps['manifest']> {
  const parsed = parseManifest(manifestJson({ assets: ['app.js'], ...overrides }))
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.manifest
}

/** A verifier that serves FILES and notes what it was asked. */
function verifier (answer?: (url: string, seen: Seen) => Response | undefined): { fetchVerified: LiveServeDeps['fetchVerified'], seen: Seen[] } {
  const seen: Seen[] = []
  return {
    seen,
    fetchVerified: async (url, init) => {
      const entry: Seen = { url, headers: init.headers, method: init.method }
      seen.push(entry)
      const custom = answer?.(url, entry)
      if (custom !== undefined) return custom
      const body = FILES[new URL(url).pathname]
      if (body === undefined) return new Response('not found', { status: 404 })
      const range = init.headers['range']
      if (range !== undefined) return new Response(body.slice(1, 4), { status: 206, headers: { 'content-range': `bytes 1-3/${body.length}`, 'content-length': '3' } })
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length), 'content-type': 'application/octet-stream' } })
    }
  }
}

async function handlerOver (overrides: Partial<LiveServeDeps> = {}, used = verifier()): Promise<{ handle: (path: string, init?: RequestInit) => Promise<Response>, seen: Seen[], badData: ReturnType<typeof vi.fn> }> {
  const badData = vi.fn()
  const handler = createLiveRequestHandler({ origin: ORIGIN, manifest: manifestOf(), declaration: await declared(), content: CID, fetchVerified: used.fetchVerified, onBadData: badData, ...overrides })
  return { handle: async (path, init) => await handler(new Request(`${ORIGIN}${path}`, init)), seen: used.seen, badData }
}

describe('the handler an app runs on before its files are pinned', () => {
  it('serves the entry for the root, from the root the manifest came from, naming the leaf the declared tree gives it', async () => {
    const { handle, seen } = await handlerOver()
    const response = await handle('/')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<h1>hello</h1>')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(`${ORIGIN}/index.html`)
    expect(seen[0]?.headers[CONTENT_ROOT_HEADER]).toBe(CID)
    expect(seen[0]?.headers[EXPECT_LEAF_HEADER]).toBe(await leafOf('/index.html', 14, [utf8('<h1>hello</h1>')]))
  })

  it('answers with the policy a pinned app is served under, and the type of the path', async () => {
    const { handle } = await handlerOver()
    const response = await handle('/app.js')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-type')).toMatch(/javascript/)
    expect(response.headers.has('cross-origin-opener-policy')).toBe(false)
    const isolated = await handlerOver({ manifest: manifestOf({ crossOriginIsolated: true }) })
    expect((await isolated.handle('/app.js')).headers.get('cross-origin-opener-policy')).toBe('same-origin')
  })

  it('passes a range on and answers it as a range', async () => {
    const { handle, seen } = await handlerOver()
    const response = await handle('/app.js', { headers: { range: 'bytes=1-3' } })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 1-3/5')
    expect(seen[0]?.headers['range']).toBe('bytes=1-3')
  })

  it('asks for the exact path and nothing the page put after it', async () => {
    const { handle, seen } = await handlerOver()
    await handle('/app.js?cache=1#x')
    expect(seen[0]?.url).toBe(`${ORIGIN}/app.js`)
  })

  it('names no leaf for a site that declares no tree, and still serves only the files the manifest lists', async () => {
    const { handle, seen } = await handlerOver({ declaration: undefined })
    expect((await handle('/app.js')).status).toBe(200)
    expect(seen[0]?.headers[EXPECT_LEAF_HEADER]).toBeUndefined()
    expect((await handle('/secret.js')).status).toBe(404)
    expect(seen).toHaveLength(1)
  })

  it('denies a path the manifest does not list without asking the verifier, as a pinned app would', async () => {
    const { handle, seen, badData } = await handlerOver()
    expect((await handle('/secret.js')).status).toBe(404)
    expect(seen).toEqual([])
    expect(badData).not.toHaveBeenCalled()
  })

  it('serves the entry for a navigation to a route, and not for a script', async () => {
    const { handle, seen } = await handlerOver()
    const route = await handle('/settings/profile', { headers: { 'upgrade-insecure-requests': '1', accept: 'text/html' } })
    expect(route.status).toBe(200)
    expect(seen[0]?.url).toBe(`${ORIGIN}/index.html`)
    expect((await handle('/settings/profile.js')).status).toBe(404)
  })

  it('treats a file the manifest lists but the declared tree does not as bad data, and sends the page a failure', async () => {
    const tree = await declared()
    const { handle, seen, badData } = await handlerOver({ declaration: { ...tree, leaves: tree.leaves.filter((entry) => entry.path !== '/app.js') } })
    const response = await handle('/app.js')
    expect(response.type).toBe('error')
    expect(seen).toEqual([])
    expect(badData).toHaveBeenCalledWith({ differing: ['/app.js'] })
  })

  it('never delivers a file the verifier says is not the declared one, and raises the block once', async () => {
    const { fetchVerified, seen } = verifier(() => new Response('<h1>not what was declared</h1>', { status: 502, headers: { [FAILURE_HEADER]: DDOC_MISMATCH } }))
    const { handle, badData } = await handlerOver({}, { fetchVerified, seen })
    const first = await handle('/')
    expect(first.type).toBe('error')
    expect((await handle('/app.js')).status).toBe(404)
    expect(badData).toHaveBeenCalledTimes(1)
    expect(badData).toHaveBeenCalledWith({ differing: ['/index.html'] })
  })

  it('raises the block, naming no file, for content the verifier proved is not what its address names', async () => {
    const { fetchVerified, seen } = verifier(() => new Response('tampered', { status: 502, headers: { [FAILURE_HEADER]: 'unverifiable' } }))
    const { handle, badData } = await handlerOver({}, { fetchVerified, seen })
    expect((await handle('/')).type).toBe('error')
    expect(badData).toHaveBeenCalledWith({ differing: [], invalid: expect.stringContaining('/index.html') })
  })

  it('denies everything once the block was raised: nothing more of this origin reaches the page', async () => {
    let bad = true
    const { fetchVerified, seen } = verifier(() => bad ? new Response('x', { status: 502, headers: { [FAILURE_HEADER]: DDOC_MISMATCH } }) : undefined)
    const { handle } = await handlerOver({}, { fetchVerified, seen })
    await handle('/')
    bad = false
    const later = await handle('/app.js')
    expect(later.status === 404 || later.type === 'error').toBe(true)
    expect(seen).toHaveLength(1)
  })

  it('passes a failure that is not bad data on as one, without blocking: a name that moved, a gateway that is down', async () => {
    const { fetchVerified, seen } = verifier(() => new Response('moved', { status: 409 }))
    const { handle, badData } = await handlerOver({}, { fetchVerified, seen })
    expect((await handle('/app.js')).status).toBe(409)
    expect(badData).not.toHaveBeenCalled()
  })

  it('sends a request for another origin to the reach gate, which refuses what the app was not granted', async () => {
    const used = verifier()
    const handler = createLiveRequestHandler({ origin: ORIGIN, manifest: manifestOf(), declaration: undefined, content: CID, fetchVerified: used.fetchVerified, onBadData: () => {} })
    expect((await handler(new Request('https://other.example/x.js'))).status).toBe(404)
    expect(used.seen).toEqual([])
  })

  it('redirects the root to an entry that lives in a directory, as a pinned app does', async () => {
    const { handle } = await handlerOver({ manifest: manifestOf({ entry: 'app/index.html', assets: ['app.js'] }), declaration: undefined })
    const response = await handle('/')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/app/index.html')
  })
})
