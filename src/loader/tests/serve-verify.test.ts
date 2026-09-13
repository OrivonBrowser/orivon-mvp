import { describe, expect, it } from 'vitest'
import { bundleTree } from '../../broker/policy/bundle-hash.js'
import { fromBundleTree } from '../../broker/policy/pin.js'
import { verifyPinnedTree } from '../serve-verify.js'
import { memoryStorage, ORIGIN, utf8 } from './test-helpers.js'

async function realPin (): Promise<{ pin: ReturnType<typeof fromBundleTree>, entries: Array<{ path: string, content: Uint8Array }> }> {
  const entries = [
    { path: '/.well-known/orivon.json', content: utf8('{"orivonApiVersion":0}') },
    { path: '/index.html', content: utf8('<h1>hi</h1>') },
    { path: '/app.js', content: utf8('console.log(1)') }
  ]
  const tree = await bundleTree(entries)
  const pin = fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0)
  return { pin, entries }
}

describe('verifyPinnedTree', () => {
  it('passes when every pinned asset is still readable and hashes to the pinned root', async () => {
    const { pin, entries } = await realPin()
    const storage = memoryStorage()
    for (const entry of entries) await storage.writeAsset(ORIGIN, entry.path, entry.content)

    expect(await verifyPinnedTree(storage, ORIGIN, pin)).toBe(true)
  })

  it('fails when a pinned asset\'s bytes changed on disk since it was pinned -- the ADR-0007 property this file exists for', async () => {
    const { pin, entries } = await realPin()
    const storage = memoryStorage()
    for (const entry of entries) await storage.writeAsset(ORIGIN, entry.path, entry.content)
    // Tamper with one asset directly on the backing store, bypassing writeAsset --
    // models a file edited on disk between runs, not a fresh install.
    await storage.writeAsset(ORIGIN, '/app.js', utf8('console.log("tampered")'))

    expect(await verifyPinnedTree(storage, ORIGIN, pin)).toBe(false)
  })

  it('fails when a pinned asset is missing entirely', async () => {
    const { pin, entries } = await realPin()
    const storage = memoryStorage()
    // Write every asset EXCEPT one -- models a file deleted from disk since it was pinned.
    for (const entry of entries) {
      if (entry.path !== '/app.js') await storage.writeAsset(ORIGIN, entry.path, entry.content)
    }

    expect(await verifyPinnedTree(storage, ORIGIN, pin)).toBe(false)
  })

  it('fails, not throws, for a different origin entirely (nothing written there)', async () => {
    const { pin } = await realPin()
    const storage = memoryStorage()

    expect(await verifyPinnedTree(storage, 'https://someone-else.example', pin)).toBe(false)
  })
})
