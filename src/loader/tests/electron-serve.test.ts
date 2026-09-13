import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import { bundleTree } from '../../broker/policy/bundle-hash.js'
import { fromBundleTree } from '../../broker/policy/pin.js'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { nodeLoaderStorage } from '../node-storage.js'
import { manifestJson, utf8 } from './test-helpers.js'

// registerAppOrigin needs no `electron` mock at all -- it takes a Session
// directly, the same "structural fake, no real Electron" pattern
// src/broker/policy/origin.ts's SenderFrameLike tests already use.
function fakeSession (): Session & { calls: { unhandle: string[], handle: string[] } } {
  const handled = new Set<string>()
  const calls = { unhandle: [] as string[], handle: [] as string[] }
  return {
    protocol: {
      isProtocolHandled: (scheme: string) => handled.has(scheme),
      unhandle: (scheme: string) => { handled.delete(scheme); calls.unhandle.push(scheme) },
      handle: (scheme: string) => { handled.add(scheme); calls.handle.push(scheme) }
    },
    calls
  } as unknown as Session & { calls: { unhandle: string[], handle: string[] } }
}

describe('registerAppOrigin', () => {
  it('derives the scheme from the origin itself and registers a handler for it', async () => {
    const { registerAppOrigin } = await import('../electron-serve.js')
    const session = fakeSession()

    registerAppOrigin(session, 'https://app.example', async () => new Response(null))

    expect(session.calls.handle).toEqual(['https'])
    expect(session.calls.unhandle).toEqual([])
  })

  it('registers "http" for a plain-http origin -- the dev-mode fixture app case (canonical-path.ts\'s ASSET_SCHEMES)', async () => {
    const { registerAppOrigin } = await import('../electron-serve.js')
    const session = fakeSession()

    registerAppOrigin(session, 'http://127.0.0.1:8872', async () => new Response(null))

    expect(session.calls.handle).toEqual(['http'])
  })

  it('unhandles first when the scheme is already registered -- Electron throws on a second handle() for one scheme otherwise', async () => {
    const { registerAppOrigin } = await import('../electron-serve.js')
    const session = fakeSession()

    registerAppOrigin(session, 'https://app.example', async () => new Response(null))
    registerAppOrigin(session, 'https://app.example', async () => new Response(null))

    expect(session.calls.handle).toEqual(['https', 'https'])
    expect(session.calls.unhandle).toEqual(['https'])
  })
})

describe('restorePinnedServing', () => {
  async function pinRealOrigin (storage: ReturnType<typeof nodeLoaderStorage>, origin: string): Promise<void> {
    const entries = [
      { path: '/.well-known/orivon.json', content: utf8(manifestJson()) },
      { path: '/index.html', content: utf8('<h1>hi</h1>') }
    ]
    const tree = await bundleTree(entries)
    for (const entry of entries) await storage.writeAsset(origin, entry.path, entry.content)
    await storage.writePin(origin, fromBundleTree(origin, tree.root, tree.assets, '1.0.0', 0))
  }

  it('registers a handler, on the correct partition, for every real pinned origin found on disk', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restore-serving-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, 'https://app-a.example')
    await pinRealOrigin(storage, 'https://app-b.example')

    const sessionsByPartition = new Map<string, ReturnType<typeof fakeSession>>()
    const fromPartition = vi.fn((partition: string) => {
      const existing = sessionsByPartition.get(partition)
      if (existing !== undefined) return existing
      const created = fakeSession()
      sessionsByPartition.set(partition, created)
      return created
    })
    vi.doMock('electron', () => ({ session: { fromPartition } }))
    const { restorePinnedServing } = await import('../electron-serve.js')

    const results = await restorePinnedServing(storage)

    expect([...results].sort((a, b) => a.origin.localeCompare(b.origin))).toEqual([
      { origin: 'https://app-a.example', ok: true },
      { origin: 'https://app-b.example', ok: true }
    ])
    expect(fromPartition).toHaveBeenCalledWith(partitionFor('https://app-a.example'))
    expect(fromPartition).toHaveBeenCalledWith(partitionFor('https://app-b.example'))
    expect(sessionsByPartition.get(partitionFor('https://app-a.example'))?.calls.handle).toEqual(['https'])

    vi.doUnmock('electron')
  })

  it('one origin throwing during registration is reported and does not stop the rest', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restore-serving-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, 'https://good.example')
    await pinRealOrigin(storage, 'https://also-good.example')

    const fromPartition = vi.fn((partition: string) => {
      if (partition === partitionFor('https://good.example')) throw new Error('simulated Electron failure')
      return fakeSession()
    })
    vi.doMock('electron', () => ({ session: { fromPartition } }))
    const { restorePinnedServing } = await import('../electron-serve.js')

    const results = await restorePinnedServing(storage)

    expect([...results].sort((a, b) => a.origin.localeCompare(b.origin))).toEqual([
      { origin: 'https://also-good.example', ok: true },
      { origin: 'https://good.example', ok: false }
    ])

    vi.doUnmock('electron')
  })

  it('is a no-op, registering nothing, when no origin is pinned', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-restore-serving-'))
    const storage = nodeLoaderStorage(userData)
    const fromPartition = vi.fn()
    vi.doMock('electron', () => ({ session: { fromPartition } }))
    const { restorePinnedServing } = await import('../electron-serve.js')

    expect(await restorePinnedServing(storage)).toEqual([])
    expect(fromPartition).not.toHaveBeenCalled()

    vi.doUnmock('electron')
  })
})
