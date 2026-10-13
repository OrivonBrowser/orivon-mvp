// A granted https host is dialled by the loader with Node, which never sees a system proxy: the same question
// orivon.net asks (T20) is put to the broker before the dial.

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import { bundleTree } from '../../../broker/policy/bundle-hash.js'
import { fromBundleTree } from '../../../broker/policy/pin.js'
import { createBroker } from '../../../broker/index.js'
import { baseDeps, manifestWith, memoryLedgerStorage } from '../../../broker/tests/index.test-helpers.js'
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

async function pinWithCapabilities (storage: ReturnType<typeof nodeLoaderStorage>, origin: string, capabilities: Record<string, unknown>): Promise<void> {
  const entries = [
    { path: '/.well-known/orivon.json', content: utf8(manifestJson({ capabilities })) },
    { path: '/index.html', content: utf8('<h1>hi</h1>') }
  ]
  const tree = await bundleTree(entries)
  for (const entry of entries) await storage.writeAsset(origin, entry.path, entry.content)
  await storage.writePin(origin, fromBundleTree(origin, tree.root, tree.assets, '1.0.0', 0))
}

describe('registerServingFor -- a granted https host and a system proxy (T20)', () => {
  const ORIGIN = 'https://proxy-reach.example'

  async function handlerWith (proxied: boolean, routed: boolean): Promise<{ request: () => Promise<Response>, dials: string[] }> {
    const userData = await mkdtemp(join(tmpdir(), 'orivon-reach-proxy-'))
    const storage = nodeLoaderStorage(userData)
    const capabilities = { net: { https: { connect: ['granted.example:443'] } } }
    await pinWithCapabilities(storage, ORIGIN, capabilities)
    const route = { provider: { connect: async () => { throw new Error('unused') } } }
    const broker = createBroker(baseDeps({
      ledgerStorage: memoryLedgerStorage(),
      proxyConfigured: async () => proxied,
      routeFor: () => routed ? route : undefined
    }))
    broker.registerApp(ORIGIN, manifestWith(capabilities))
    await broker.grant(ORIGIN, 'https.connect', ['granted.example:443'])

    const session = fakeSession()
    const dials: string[] = []
    vi.resetModules()
    vi.doMock('electron', () => ({ session: { fromPartition: () => session } }))
    vi.doMock('../../reach/reach.js', () => ({
      nodeReachDial: () => async (request: Request) => { dials.push(request.url); return new Response('bytes', { status: 200 }) }
    }))
    const { registerServingFor } = await import('../serve.js')
    await registerServingFor(storage, ORIGIN, broker)
    const handler = session.handlers.get('https')
    if (handler === undefined) throw new Error('no handler was registered')
    return { request: async () => await handler(new Request('https://granted.example/x.png')), dials }
  }

  function unmock (): void {
    vi.doUnmock('../../reach/reach.js')
    vi.doUnmock('electron')
  }

  it('refuses a granted host and never dials when a system proxy applies and the app is not routed', async () => {
    const { request, dials } = await handlerWith(true, false)
    const response = await request()
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('proxy')
    expect(dials).toEqual([])
    unmock()
  })

  it('dials a granted host when no proxy applies', async () => {
    const { request, dials } = await handlerWith(false, false)
    expect((await request()).status).toBe(200)
    expect(dials).toEqual(['https://granted.example/x.png'])
    unmock()
  })

  it('leaves a routed app alone: its route carries the traffic, so the system proxy does not matter', async () => {
    const { request, dials } = await handlerWith(true, true)
    expect((await request()).status).toBe(200)
    expect(dials).toHaveLength(1)
    unmock()
  })
})
