// exposeOrdinaryTabSurface's install order: the children bridge reads the internal-net slot
// exposeOrivon() creates, and exposeFetchRoute() releases that slot, so the bridge goes between.
import { expect, it, vi } from 'vitest'

const order = vi.hoisted(() => [] as string[])
vi.mock('../surface/orivon.js', () => ({ exposeOrivon: () => { order.push('orivon') } }))
vi.mock('../expose-child-host-connect.js', () => ({ exposeChildHostConnect: () => { order.push('children') } }))
vi.mock('../expose-fetch-route.js', () => ({ exposeFetchRoute: () => { order.push('fetch-route') } }))
vi.mock('../expose-shim-globals.js', () => ({ exposeShimGlobals: () => { order.push('shim-globals') } }))
vi.mock('../manifest-hint.js', () => ({ installManifestHintWatcher: () => { order.push('manifest-hint') } }))

it('installs the children bridge after window.orivon and before the routed installers release the slot', async () => {
  vi.stubGlobal('location', { protocol: 'https:' })
  try {
    const { exposeOrdinaryTabSurface } = await import('../ordinary-tab.js')
    exposeOrdinaryTabSurface()
  } finally {
    vi.unstubAllGlobals()
  }
  expect(order.indexOf('orivon')).toBe(0)
  expect(order.indexOf('children')).toBeGreaterThan(order.indexOf('orivon'))
  expect(order.indexOf('children')).toBeLessThan(order.indexOf('fetch-route'))
})
