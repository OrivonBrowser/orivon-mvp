// An update landing while the app is open, and the start after it: the
// previous bundle's files stay servable for the rest of the process (a page
// still running it may lazily load one), and the next start prunes them.

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import { bundleTree } from '../../../broker/policy/bundle-hash.js'
import { fromBundleTree } from '../../../broker/policy/pin.js'
import { nodeLoaderStorage } from '../../cache/node-storage.js'
import type { AppRequestHandler } from '../../serve/serve.js'
import { manifestJson, utf8 } from '../../tests/test-helpers.js'

function fakeSession (): Session & { handlers: Map<string, AppRequestHandler> } {
  const handlers = new Map<string, AppRequestHandler>()
  return {
    protocol: {
      isProtocolHandled: (scheme: string) => handlers.has(scheme),
      unhandle: (scheme: string) => { handlers.delete(scheme) },
      handle: (scheme: string, handler: AppRequestHandler) => { handlers.set(scheme, handler) }
    },
    handlers
  } as unknown as Session & { handlers: Map<string, AppRequestHandler> }
}

async function pinFiles (storage: ReturnType<typeof nodeLoaderStorage>, origin: string, files: Record<string, string>): Promise<void> {
  const entries = [
    { path: '/.well-known/orivon.json', content: utf8(manifestJson()) },
    ...Object.entries(files).map(([path, text]) => ({ path, content: utf8(text) }))
  ]
  const tree = await bundleTree(entries)
  for (const entry of entries) await storage.writeAsset(origin, entry.path, entry.content)
  await storage.writePin(origin, fromBundleTree(origin, tree.root, tree.assets, '1.0.0', 0))
}

describe('an update while the app is open', () => {
  it('keeps serving a file only the previous bundle had, and refuses it once its bytes no longer match', async () => {
    const origin = 'https://update-in-session.example'
    const storage = nodeLoaderStorage(await mkdtemp(join(tmpdir(), 'orivon-update-')))
    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { registerServingFor } = await import('../serve.js')

    await pinFiles(storage, origin, { '/index.html': 'v1', '/chunk-old.js': 'old chunk' })
    await registerServingFor(storage, origin)
    await pinFiles(storage, origin, { '/index.html': 'v2', '/chunk-new.js': 'new chunk' })
    await registerServingFor(storage, origin)
    const handler = session.handlers.get('https')!

    const old = await handler(new Request(`${origin}/chunk-old.js`))
    expect(old.status).toBe(200)
    expect(await old.text()).toBe('old chunk')
    expect(await (await handler(new Request(`${origin}/chunk-new.js`))).text()).toBe('new chunk')

    await storage.writeAsset(origin, '/chunk-old.js', utf8('rewritten'))
    expect((await handler(new Request(`${origin}/chunk-old.js`))).status).toBe(404)

    vi.doUnmock('electron')
  })
})

describe('a cached bundle that fails verification', () => {
  it('forgets its last update check, so the next visit downloads it in full and heals it', async () => {
    const origin = 'https://heal-after-damage.example'
    const storage = nodeLoaderStorage(await mkdtemp(join(tmpdir(), 'orivon-heal-')))
    await pinFiles(storage, origin, { '/index.html': 'v1' })
    await storage.writeUpdateCheck(origin, { checkedAt: Date.now() })
    await storage.writeAsset(origin, '/index.html', utf8('damaged'))

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { registerServingFor } = await import('../serve.js')
    await registerServingFor(storage, origin)

    expect(await storage.readUpdateCheck(origin)).toBeUndefined()
    vi.doUnmock('electron')
    vi.restoreAllMocks()
  })
})

describe('restorePinnedServing at the next start', () => {
  it('prunes the files the pin no longer declares, and clears leftover staging', async () => {
    const origin = 'https://prune-at-start.example'
    const storage = nodeLoaderStorage(await mkdtemp(join(tmpdir(), 'orivon-prune-start-')))
    await pinFiles(storage, origin, { '/index.html': 'v2' })
    await storage.writeAsset(origin, '/chunk-old.js', utf8('left by v1'))
    const leftover = await storage.openStaged(origin)
    await leftover.close()

    const session = fakeSession()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { restorePinnedServing } = await import('../serve.js')
    await restorePinnedServing(storage)

    expect(await storage.readAsset(origin, '/chunk-old.js')).toBeUndefined()
    expect(await storage.readAsset(origin, '/index.html')).toBeDefined()
    expect(await storage.readStaged(origin, leftover.id)).toBeUndefined()

    vi.doUnmock('electron')
  })
})
