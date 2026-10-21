import { beforeEach, describe, expect, it, vi } from 'vitest'

const partitionForTarget = vi.fn((target: string) => (target.startsWith('https://site.eth') ? 'persist:site-eth' : undefined))
const appTabArgsFor = vi.fn((_target: string, _broker: unknown) => [] as string[])
const makeTabView = vi.fn((_preload: string, _partition: string | undefined, _args: string[], _options?: { target: string }) => ({ webContents: { id: 1, once: vi.fn(), on: vi.fn(), off: vi.fn() } }))
vi.mock('../tab-view.js', () => ({
  appTabArgsFor: (target: string, broker: unknown) => appTabArgsFor(target, broker),
  makeTabView: (preload: string, partition: string | undefined, args: string[], options?: { target: string }) => makeTabView(preload, partition, args, options),
  partitionForTarget: (target: string) => partitionForTarget(target),
  wireView: vi.fn()
}))
vi.mock('../tab-backing.js', () => ({ paintBacking: vi.fn() }))
vi.mock('../theme-colors.js', () => ({ DASHBOARD_BACKGROUND: 'a', INTERNAL_PAGE_BACKGROUND: 'b', onThemeUpdated: vi.fn(), resolveThemeColor: () => '#000' }))
vi.mock('../../pages/internal-tab.js', () => ({ guardInternalView: vi.fn() }))
vi.mock('electron', () => ({ session: { defaultSession: {} } }))

const { TabFactory } = await import('../tab-factory.js')
const { provideVerifierAccess } = await import('../../verifier/verifier-access.js')

function factory (on: boolean): InstanceType<typeof TabFactory> {
  const host = { services: { settings: { get: () => on } } }
  return new TabFactory(host as never, () => undefined, 'http://localhost:5999/newtab/', undefined)
}

beforeEach(() => {
  partitionForTarget.mockClear()
  appTabArgsFor.mockClear()
  makeTabView.mockClear()
  provideVerifierAccess({ start: () => {}, ready: async () => {}, servesName: () => true })
})

describe('a tab opened at a gateway address', () => {
  it('is built for the .eth name by content(): its session, its arguments and its first load', () => {
    const built = factory(true).content('https://site.eth.limo/p?q=1#f')
    expect(built.target).toBe('https://site.eth/p?q=1#f')
    expect(partitionForTarget).toHaveBeenCalledWith('https://site.eth/p?q=1#f')
    expect(appTabArgsFor.mock.calls[0]?.[0]).toBe('https://site.eth/p?q=1#f')
    expect(makeTabView.mock.calls[0]?.[1]).toBe('persist:site-eth')
    expect(built.record.partition).toBe('persist:site-eth')
  })

  it('is built for the .eth name by trusted(), which an extension\'s tabs.create and a startup page use', () => {
    const built = factory(true).trusted('https://site.eth.limo/p')
    expect(built.target).toBe('https://site.eth/p')
    expect(partitionForTarget).toHaveBeenCalledWith('https://site.eth/p')
    expect(appTabArgsFor.mock.calls[0]?.[0]).toBe('https://site.eth/p')
    expect(built.record.partition).toBe('persist:site-eth')
  })

  it('keeps the gateway address with the setting off, or for a name the verifier cannot load', () => {
    expect(factory(false).content('https://site.eth.limo/p').target).toBe('https://site.eth.limo/p')
    expect(factory(false).trusted('https://site.eth.limo/p').target).toBe('https://site.eth.limo/p')
    provideVerifierAccess({ start: () => {}, ready: async () => {}, servesName: () => false })
    expect(factory(true).content('https://site.eth.limo/p').target).toBe('https://site.eth.limo/p')
  })

  it('leaves the new-tab page and an ordinary address alone', () => {
    expect(factory(true).content().target).toBe('http://localhost:5999/newtab/')
    expect(factory(true).content('https://example.com/').target).toBe('https://example.com/')
  })
})
