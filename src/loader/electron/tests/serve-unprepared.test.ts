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

async function pinRealOrigin (storage: ReturnType<typeof nodeLoaderStorage>, origin: string): Promise<void> {
  const entries = [
    { path: '/.well-known/orivon.json', content: utf8(manifestJson()) },
    { path: '/index.html', content: utf8('<h1>hi</h1>') }
  ]
  const tree = await bundleTree(entries)
  for (const entry of entries) await storage.writeAsset(origin, entry.path, entry.content)
  await storage.writePin(origin, fromBundleTree(origin, tree.root, tree.assets, '1.0.0', 0))
}

// The session of a routed app that could not be pointed at its proxy route (its front failed to bind, say) must not
// leave the app to open as an ordinary website on the shared session, which would send its traffic direct.
describe('registerServingFor -- a session that cannot be prepared', () => {
  it('still gives the app its own partition, answered by a handler that refuses everything and says what its preparer says', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-serving-unprepared-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, 'https://routed.example')
    const session = fakeSession()
    vi.resetModules()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { registerServingFor, beforeAppSessionServes, isOriginServedFromCacheSync, isOriginPinnedSync } = await import('../serve.js')
    const { AppNotReady } = await import('../app-partitions.js')
    beforeAppSessionServes(async () => { throw new AppNotReady('its tunnel could not start', 'Check the tunnel under Tunnels, then open it again.', { cause: new Error('the front would not bind') }) })

    await expect(registerServingFor(storage, 'https://routed.example')).rejects.toThrow('its tunnel could not start')

    expect(isOriginServedFromCacheSync('https://routed.example'), 'a tab for it runs in the app\'s partition, not on the shared session').toBe(true)
    expect(isOriginPinnedSync('https://routed.example'), 'it is still an app Orivon holds').toBe(true)
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')
    for (const path of ['/', '/index.html', '/anything-else']) {
      const answer = await handler(new Request(`https://routed.example${path}`))
      expect(answer.status).toBe(503)
      const text = await answer.text()
      expect(text).toContain('its tunnel could not start')
      expect(text).toContain('Check the tunnel under Tunnels')
    }
  })

  it('says only what is true of a failure no preparer explained: not the tunnel', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-serving-unexplained-'))
    const storage = nodeLoaderStorage(userData)
    await pinRealOrigin(storage, 'https://unexplained.example')
    const session = fakeSession()
    vi.resetModules()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    const { registerServingFor, beforeAppSessionServes } = await import('../serve.js')
    beforeAppSessionServes(async () => { throw new Error('disk full') })

    await expect(registerServingFor(storage, 'https://unexplained.example')).rejects.toThrow('disk full')

    const answer = await session.handlers.get('https')?.(new Request('https://unexplained.example/'))
    expect(answer?.status).toBe(503)
    const text = await answer?.text()
    expect(text).toContain('the session it opens in could not be made ready')
    expect(text).not.toContain('tunnel')
  })
})
