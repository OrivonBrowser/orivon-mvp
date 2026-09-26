import { describe, expect, it, vi } from 'vitest'
import { bundleTree } from '../../../broker/policy/bundle-hash.js'
import { fromBundleTree } from '../../../broker/policy/pin.js'
import { leafOf } from '../../leaf-hash.js'
import { createAppRequestHandler } from '../serve.js'
import type { OpenedAsset } from '../../cache/storage.js'
import { manifestJson, memoryStorage, ORIGIN, utf8 } from '../../tests/test-helpers.js'
import type { MemoryStorage } from '../../tests/test-helpers.js'

// A served asset streams from disk: a request costs the bytes it sends, not
// the whole file in memory, and a previous version's retained file is
// re-hashed once per file identity rather than once per request.

const APP_JS = 'x'.repeat(200 * 1024)
const OLD_JS = 'old chunk '.repeat(1000)

interface Metered {
  readonly storage: MemoryStorage
  /** Bytes handed out by every opened asset's `read`, across all requests. */
  bytesRead: () => number
  /** Opened assets not yet closed. */
  open: () => number
}

function metered (storage: MemoryStorage): Metered {
  let bytes = 0
  let open = 0
  const openAsset = storage.openAsset.bind(storage)
  storage.openAsset = async (origin, path) => {
    const asset = await openAsset(origin, path)
    if (asset === undefined) return undefined
    open += 1
    let closed = false
    const wrapped: OpenedAsset = {
      byteLength: asset.byteLength,
      identity: asset.identity,
      read: async function * (start, end) {
        for await (const chunk of asset.read(start, end)) { bytes += chunk.length; yield chunk }
      },
      close: async () => { if (!closed) { closed = true; open -= 1 } await asset.close() }
    }
    return wrapped
  }
  return { storage, bytesRead: () => bytes, open: () => open }
}

async function installed (): Promise<Metered> {
  const entries = [
    { path: '/.well-known/orivon.json', content: utf8(manifestJson()) },
    { path: '/index.html', content: utf8('<h1>v2</h1>') },
    { path: '/app.js', content: utf8(APP_JS) }
  ]
  const tree = await bundleTree(entries)
  const storage = memoryStorage()
  for (const entry of entries) await storage.writeAsset(ORIGIN, entry.path, entry.content)
  await storage.writePin(ORIGIN, fromBundleTree(ORIGIN, tree.root, tree.assets, '2.0.0', 0))
  await storage.writeAsset(ORIGIN, '/old.js', utf8(OLD_JS))
  return metered(storage)
}

async function retainedOldJs (): Promise<ReadonlyMap<string, string>> {
  const bytes = utf8(OLD_JS)
  return new Map([['/old.js', await leafOf('/old.js', bytes.length, [bytes])]])
}

async function handlerFor (m: Metered, retained?: ReadonlyMap<string, string>): Promise<(request: Request) => Promise<Response>> {
  return await createAppRequestHandler(m.storage, ORIGIN, undefined, undefined, undefined, undefined, undefined, undefined, undefined, retained)
}

describe('serving a pinned asset', () => {
  it('streams it instead of reading it whole', async () => {
    const m = await installed()
    const handler = await handlerFor(m)
    vi.mocked(m.storage.readAsset).mockClear()

    const response = await handler(new Request(`${ORIGIN}/app.js`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(APP_JS.length))
    expect(await response.text()).toBe(APP_JS)
    expect(m.storage.readAsset).not.toHaveBeenCalled()
  })

  it('reads only the requested slice for a Range request', async () => {
    const m = await installed()
    const handler = await handlerFor(m)
    const before = m.bytesRead()

    const response = await handler(new Request(`${ORIGIN}/app.js`, { headers: { range: 'bytes=100-199' } }))
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(`bytes 100-199/${String(APP_JS.length)}`)
    expect((await response.text()).length).toBe(100)
    expect(m.bytesRead() - before).toBe(100)
  })

  it('releases the file once the body is read, cancelled, or never sent (416)', async () => {
    const m = await installed()
    const handler = await handlerFor(m)

    await (await handler(new Request(`${ORIGIN}/app.js`))).arrayBuffer()
    expect(m.open()).toBe(0)

    const cancelled = await handler(new Request(`${ORIGIN}/app.js`))
    const reader = cancelled.body!.getReader()
    await reader.read()
    await reader.cancel()
    expect(m.open()).toBe(0)

    const unsatisfiable = await handler(new Request(`${ORIGIN}/app.js`, { headers: { range: 'bytes=999999999-' } }))
    expect(unsatisfiable.status).toBe(416)
    expect(m.open()).toBe(0)
  })
})

describe('a response whose body is not read', () => {
  it('holds no file open, so an abandoned or HEAD response leaks nothing', async () => {
    const m = await installed()
    const handler = await handlerFor(m, await retainedOldJs())

    const unread = await handler(new Request(`${ORIGIN}/app.js`))
    expect(unread.status).toBe(200)
    await handler(new Request(`${ORIGIN}/old.js`))
    expect(m.open()).toBe(0)

    const head = await handler(new Request(`${ORIGIN}/app.js`, { method: 'HEAD' }))
    expect(head.headers.get('content-length')).toBe(String(APP_JS.length))
    expect(head.body).toBeNull()
    expect(m.open()).toBe(0)
  })

  it('fails the body, rather than sending other bytes, when the file changed after the headers were built', async () => {
    const m = await installed()
    const handler = await handlerFor(m)
    const response = await handler(new Request(`${ORIGIN}/app.js`))
    await m.storage.writeAsset(ORIGIN, '/app.js', utf8(APP_JS.toUpperCase()))

    await expect(response.text()).rejects.toThrow()
    expect(m.open()).toBe(0)
  })
})

describe('serving a previous version\'s retained file', () => {
  it('hashes it on the first request only, while the file is unchanged', async () => {
    const m = await installed()
    const handler = await handlerFor(m, await retainedOldJs())
    const start = m.bytesRead()

    expect(await (await handler(new Request(`${ORIGIN}/old.js`))).text()).toBe(OLD_JS)
    expect(m.bytesRead() - start).toBe(2 * OLD_JS.length)

    const second = m.bytesRead()
    expect(await (await handler(new Request(`${ORIGIN}/old.js`))).text()).toBe(OLD_JS)
    expect(m.bytesRead() - second).toBe(OLD_JS.length)

    const ranged = m.bytesRead()
    const slice = await handler(new Request(`${ORIGIN}/old.js`, { headers: { range: 'bytes=0-9' } }))
    expect(await slice.text()).toBe(OLD_JS.slice(0, 10))
    expect(m.bytesRead() - ranged).toBe(10)
  })

  it('shares one hash between concurrent first requests', async () => {
    const m = await installed()
    const handler = await handlerFor(m, await retainedOldJs())
    const start = m.bytesRead()
    const responses = await Promise.all([handler(new Request(`${ORIGIN}/old.js`)), handler(new Request(`${ORIGIN}/old.js`))])
    for (const response of responses) expect(await response.text()).toBe(OLD_JS)
    expect(m.bytesRead() - start).toBe(3 * OLD_JS.length)
  })

  it('refuses a file that no longer matches, without re-hashing it on every request', async () => {
    const m = await installed()
    await m.storage.writeAsset(ORIGIN, '/old.js', utf8(OLD_JS.toUpperCase()))
    const handler = await handlerFor(m, await retainedOldJs())

    expect((await handler(new Request(`${ORIGIN}/old.js`))).status).toBe(404)
    const again = m.bytesRead()
    expect((await handler(new Request(`${ORIGIN}/old.js`))).status).toBe(404)
    expect(m.bytesRead() - again).toBe(0)
    expect(m.open()).toBe(0)
  })

  it('checks the file again once it is replaced on disk', async () => {
    const m = await installed()
    const handler = await handlerFor(m, await retainedOldJs())
    expect((await handler(new Request(`${ORIGIN}/old.js`))).status).toBe(200)

    await m.storage.writeAsset(ORIGIN, '/old.js', utf8('rewritten'))
    expect((await handler(new Request(`${ORIGIN}/old.js`))).status).toBe(404)

    await m.storage.writeAsset(ORIGIN, '/old.js', utf8(OLD_JS))
    expect(await (await handler(new Request(`${ORIGIN}/old.js`))).text()).toBe(OLD_JS)
  })
})
