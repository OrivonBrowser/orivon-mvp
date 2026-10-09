import { describe, expect, it, vi } from 'vitest'
import { MANIFEST_PATH } from '../../../broker/policy/canonical-path.js'
import { CONTENT_ROOT_HEADER, DDOC_MISMATCH, EXPECT_LEAF_HEADER, FAILURE_HEADER } from '../../fetch/content-root.js'
import { leafOf } from '../../leaf-hash.js'
import { parseManifest } from '../../manifest/manifest.js'
import { createLiveRequestHandler } from '../live-serve.js'
import type { LiveServeDeps, LiveVersion } from '../live-serve.js'
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

  it('is a failed load, not bad data, when a gateway lied and no honest one holds the block, or a host is unwell', async () => {
    for (const status of [500, 502, 503]) {
      const { fetchVerified, seen } = verifier(() => new Response('a source lied', { status }))
      const { handle, badData } = await handlerOver({}, { fetchVerified, seen })
      expect((await handle('/app.js')).type, String(status)).toBe('error')
      expect(badData, String(status)).not.toHaveBeenCalled()
      // The next file still loads: nothing was ended.
      expect(await handle('/index.html').then((response) => response.type)).toBe('error')
      expect(seen, String(status)).toHaveLength(2)
    }
    const refusing = verifier(() => { throw new Error('connection refused') })
    const { handle, badData } = await handlerOver({}, refusing)
    expect((await handle('/app.js')).type).toBe('error')
    expect(badData).not.toHaveBeenCalled()
  })

  describe('when the name leads to another root than the one asked for', () => {
    const NEXT = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
    const NEW_APP_JS = 'run2()'

    async function movedTo (overrides: { fresh?: LiveServeDeps['fresh'] } = {}): Promise<{ handle: (path: string, init?: RequestInit) => Promise<Response>, seen: Seen[], badData: ReturnType<typeof vi.fn>, adopt: ReturnType<typeof vi.fn>, fresh: ReturnType<typeof vi.fn> }> {
      const newTree = { bundleHash: `sha256:${'e'.repeat(64)}`, leaves: [{ path: '/app.js', leaf: await leafOf('/app.js', NEW_APP_JS.length, [utf8(NEW_APP_JS)]) }, ...(await declared()).leaves.filter((entry) => entry.path !== '/app.js')] }
      const next = { manifest: manifestOf(), declaration: newTree, content: NEXT }
      const fresh = vi.fn(async () => next)
      const adopt = vi.fn(async () => {})
      const used = verifier((url, seen) => {
        if (seen.headers[CONTENT_ROOT_HEADER] === CID) return new Response('now points elsewhere', { status: 409 })
        return url.endsWith('/app.js') ? new Response(NEW_APP_JS, { status: 200, headers: { 'content-length': String(NEW_APP_JS.length) } }) : undefined
      })
      const { handle, badData } = await handlerOver({ fresh: overrides.fresh ?? fresh, adopt }, used)
      return { handle, seen: used.seen, badData, adopt, fresh }
    }

    it('is the next version, never bad data: the current version is adopted, and the request is answered from it', async () => {
      const { handle, seen, badData, adopt, fresh } = await movedTo()
      const response = await handle('/app.js')
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(NEW_APP_JS)
      expect(adopt).toHaveBeenCalledTimes(1)
      expect(fresh).toHaveBeenCalledTimes(1)
      expect(badData).not.toHaveBeenCalled()
      expect(seen[0]?.headers[CONTENT_ROOT_HEADER]).toBe(CID)
      expect(seen[1]?.headers[CONTENT_ROOT_HEADER]).toBe(NEXT)
      expect(seen[1]?.headers[EXPECT_LEAF_HEADER]).toBe(await leafOf('/app.js', NEW_APP_JS.length, [utf8(NEW_APP_JS)]))
      // Later requests go to the new root at once, without asking again.
      await handle('/index.html')
      expect(seen[2]?.headers[CONTENT_ROOT_HEADER]).toBe(NEXT)
      expect(fresh).toHaveBeenCalledTimes(1)
    })

    it('asks for the current version once however many requests meet the move together', async () => {
      const { handle, adopt, fresh } = await movedTo()
      const answers = await Promise.all([handle('/app.js'), handle('/index.html'), handle('/app.js')])
      expect(answers.map((response) => response.status)).toEqual([200, 200, 200])
      expect(fresh).toHaveBeenCalledTimes(1)
      expect(adopt).toHaveBeenCalledTimes(1)
    })

    it('is a failed load, and nothing is forgotten, when the current version cannot be read: the next request asks again', async () => {
      const { handle, badData, fresh } = await movedTo({ fresh: vi.fn(async () => undefined) })
      expect((await handle('/app.js')).type).toBe('error')
      expect((await handle('/index.html')).type).toBe('error')
      expect(badData).not.toHaveBeenCalled()
      expect(fresh).toBeDefined()
    })

    it('does not mistake a mismatch the verifier reports for a name that moved: that is bad data', async () => {
      const { fetchVerified, seen } = verifier(() => new Response('x', { status: 502, headers: { [FAILURE_HEADER]: DDOC_MISMATCH } }))
      const fresh = vi.fn(async () => ({ manifest: manifestOf(), declaration: undefined, content: CID }))
      const { handle, badData } = await handlerOver({ fresh }, { fetchVerified, seen })
      expect((await handle('/app.js')).type).toBe('error')
      expect(badData).toHaveBeenCalledTimes(1)
      expect(fresh).not.toHaveBeenCalled()
    })
  })

  it('says the app is in use once, when its first file is delivered', async () => {
    const served = vi.fn()
    const { handle } = await handlerOver({ onServed: served })
    expect(served).not.toHaveBeenCalled()
    await handle('/')
    await handle('/app.js')
    expect(served).toHaveBeenCalledTimes(1)
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

/** An ordinary host that serves FILES, noting what it was asked and answering as `answer` says. */
function host (answer?: (url: string) => Response | undefined): { fetchNetwork: NonNullable<LiveServeDeps['fetchNetwork']>, seen: Seen[] } {
  const seen: Seen[] = []
  return {
    seen,
    fetchNetwork: async (url, init) => {
      seen.push({ url, headers: init.headers, method: init.method })
      const custom = answer?.(url)
      if (custom !== undefined) return custom
      const body = FILES[new URL(url).pathname]
      if (body === undefined) return new Response('not found', { status: 404 })
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })
    }
  }
}

async function networkHandler (overrides: Partial<LiveServeDeps> = {}, used = host()): Promise<{ handle: (path: string, init?: RequestInit) => Promise<Response>, seen: Seen[], badData: ReturnType<typeof vi.fn> }> {
  const badData = vi.fn()
  const handler = createLiveRequestHandler({ origin: ORIGIN, manifest: manifestOf(), declaration: await declared(), content: undefined, fetchNetwork: used.fetchNetwork, onBadData: badData, ...overrides })
  return { handle: async (path, init) => await handler(new Request(`${ORIGIN}${path}`, init)), seen: used.seen, badData }
}

describe('the handler an app on an ordinary site runs on before its files are pinned', () => {
  it('delivers the very bytes it hashed, once they match the declared leaf, and asks the host for nothing of its own making', async () => {
    const { handle, seen } = await networkHandler()
    const response = await handle('/app.js')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('run()')
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(`${ORIGIN}/app.js`)
    expect(Object.keys(seen[0]?.headers ?? {})).toEqual([])
  })

  it('never delivers a file whose bytes are not the declared ones, whatever the host sends beside them', async () => {
    const lying = host((url) => url.endsWith('/app.js') ? new Response('steal()', { status: 200, headers: { 'x-orivon-failure': 'nothing' } }) : undefined)
    const { handle, badData } = await networkHandler({}, lying)
    const response = await handle('/app.js')
    expect(response.type).toBe('error')
    expect(badData).toHaveBeenCalledWith({ differing: ['/app.js'] })
    expect((await handle('/index.html')).status).toBe(404)
  })

  it('serves a range of the checked file, cut from what it held', async () => {
    const { handle, seen } = await networkHandler()
    const response = await handle('/app.js', { headers: { range: 'bytes=1-3' } })
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('un(')
    expect(response.headers.get('content-range')).toBe('bytes 1-3/5')
    expect(seen[0]?.headers['range']).toBeUndefined()
    expect((await handle('/app.js', { headers: { range: 'bytes=10-20' } })).status).toBe(416)
  })

  it('answers HEAD with the headers of a file it checked', async () => {
    const { handle } = await networkHandler()
    const response = await handle('/app.js', { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('5')
    expect(await response.text()).toBe('')
  })

  it('believes no header the host sends: one that says the content failed verification is just a header', async () => {
    const sending = host((url) => url.endsWith('/app.js') ? new Response('run()', { status: 200, headers: { 'x-orivon-failure': 'unverifiable' } }) : undefined)
    const { handle, badData } = await networkHandler({}, sending)
    expect(await (await handle('/app.js')).text()).toBe('run()')
    const failing = host(() => new Response('', { status: 502, headers: { 'x-orivon-failure': 'ddoc-mismatch' } }))
    const second = await networkHandler({}, failing)
    expect((await second.handle('/app.js')).type).toBe('error')
    expect(second.badData).not.toHaveBeenCalled()
    expect(badData).not.toHaveBeenCalled()
  })

  it('treats a host that is unwell, or cannot be reached, as a failed load and judges nothing', async () => {
    const unwell = await networkHandler({}, host(() => new Response('', { status: 503 })))
    expect((await unwell.handle('/app.js')).type).toBe('error')
    const gone = await networkHandler({}, host(() => { throw new Error('ECONNREFUSED') }))
    expect((await gone.handle('/app.js')).type).toBe('error')
    expect(unwell.badData).not.toHaveBeenCalled()
    expect(gone.badData).not.toHaveBeenCalled()
  })

  it('passes a 404 on as one, and denies a path the manifest does not list without asking the host', async () => {
    const { handle, seen } = await networkHandler({}, host(() => new Response('', { status: 404 })))
    expect((await handle('/app.js')).status).toBe(404)
    expect((await handle('/secret.js')).status).toBe(404)
    expect(seen).toHaveLength(1)
  })

  it('treats a file past what an app may carry as not the declared one, never holding more than its share', async () => {
    const huge = host(() => new Response('x', { status: 200, headers: { 'content-length': String(65 * 1024 * 1024) } }))
    const { handle, badData } = await networkHandler({}, huge)
    expect((await handle('/app.js')).type).toBe('error')
    expect(badData).toHaveBeenCalledWith({ differing: ['/app.js'] })
  })

  it('serves a site that declares no tree on Orivon\'s own checks, passing a range on and streaming', async () => {
    const { handle, seen } = await networkHandler({ declaration: undefined })
    expect((await handle('/app.js', { headers: { range: 'bytes=1-3' } })).status).toBe(200)
    expect(seen[0]?.headers['range']).toBe('bytes=1-3')
    expect((await handle('/secret.js')).status).toBe(404)
  })

  it('treats a manifest-listed file the tree has no leaf for as bad data, as for a verifier', async () => {
    const tree = await declared()
    const { handle, seen, badData } = await networkHandler({ declaration: { ...tree, leaves: tree.leaves.filter((entry) => entry.path !== '/app.js') } })
    expect((await handle('/app.js')).type).toBe('error')
    expect(seen).toEqual([])
    expect(badData).toHaveBeenCalledWith({ differing: ['/app.js'] })
  })

  describe('bytes that are not the declared ones', () => {
    const NEW_APP_JS = 'run2()'

    async function deployed (current: (() => Promise<LiveVersion | undefined>) | undefined, bytes = NEW_APP_JS): Promise<{ handle: (path: string, init?: RequestInit) => Promise<Response>, badData: ReturnType<typeof vi.fn>, adopt: ReturnType<typeof vi.fn>, seen: Seen[] }> {
      const adopt = vi.fn(async () => {})
      const used = host((url) => url.endsWith('/app.js') ? new Response(bytes, { status: 200 }) : undefined)
      const handler = await networkHandler({ fresh: current, adopt }, used)
      return { handle: handler.handle, badData: handler.badData, adopt, seen: used.seen }
    }

    async function newVersion (listsApp = true, leafBytes = NEW_APP_JS): Promise<LiveVersion> {
      const tree = await declared()
      return {
        manifest: manifestOf(listsApp ? {} : { assets: [] }),
        declaration: { bundleHash: `sha256:${'f'.repeat(64)}`, leaves: [{ path: '/app.js', leaf: await leafOf('/app.js', leafBytes.length, [utf8(leafBytes)]) }, ...tree.leaves.filter((entry) => entry.path !== '/app.js')] },
        content: undefined
      }
    }

    it('are the next version, not bad data, when the current tree names them: it is adopted and the page gets those very bytes', async () => {
      const next = await newVersion()
      const { handle, badData, adopt } = await deployed(async () => next)
      const response = await handle('/app.js')
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(NEW_APP_JS)
      expect(adopt).toHaveBeenCalledWith(next)
      expect(badData).not.toHaveBeenCalled()
      expect((await handle('/app.js')).status).toBe(200)
      expect(adopt).toHaveBeenCalledTimes(1)
    })

    it('are bad data when the current tree does not name them, however new it is', async () => {
      const { handle, badData, adopt } = await deployed(async () => await newVersion(true, 'something else'))
      expect((await handle('/app.js')).type).toBe('error')
      expect(badData).toHaveBeenCalledWith({ differing: ['/app.js'] })
      expect(adopt).not.toHaveBeenCalled()
    })

    it('are bad data when the current version cannot be read, or is the one already served', async () => {
      const unread = await deployed(async () => undefined)
      expect((await unread.handle('/app.js')).type).toBe('error')
      expect(unread.badData).toHaveBeenCalledTimes(1)
      const none = await deployed(undefined)
      expect((await none.handle('/app.js')).type).toBe('error')
      expect(none.badData).toHaveBeenCalledTimes(1)
    })

    it('are bad data when the current manifest no longer lists the file, though its tree names the bytes', async () => {
      const { handle, badData } = await deployed(async () => await newVersion(false))
      expect((await handle('/app.js')).type).toBe('error')
      expect(badData).toHaveBeenCalledTimes(1)
    })
  })

  it('says the app is in use once, when its first checked file is delivered', async () => {
    const served = vi.fn()
    const { handle } = await networkHandler({ onServed: served })
    await handle('/app.js')
    await handle('/')
    expect(served).toHaveBeenCalledTimes(1)
  })
})
