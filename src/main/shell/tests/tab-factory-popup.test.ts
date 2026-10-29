import { describe, expect, it, vi } from 'vitest'

vi.mock('../tab-view.js', () => ({
  appTabArgsFor: vi.fn(),
  makeTabView: vi.fn(),
  partitionForTarget: vi.fn(),
  partitionForTab: vi.fn(),
  wireView: vi.fn()
}))
vi.mock('../tab-backing.js', () => ({ paintBacking: vi.fn() }))
vi.mock('../theme-colors.js', () => ({ DASHBOARD_BACKGROUND: 'a', INTERNAL_PAGE_BACKGROUND: 'b', onThemeUpdated: vi.fn(), resolveThemeColor: () => '#000' }))
vi.mock('../../pages/internal-tab.js', () => ({ guardInternalView: vi.fn() }))
vi.mock('electron', () => ({ session: { defaultSession: {} } }))

const { TabFactory } = await import('../tab-factory.js')

const factory = (): InstanceType<typeof TabFactory> => new TabFactory({ services: undefined } as never, () => undefined, 'http://localhost:5999/newtab/', undefined)

describe('a popup a page opened', () => {
  it('remembers the view it was created in, which the page that opened it writes into until the website answers', () => {
    const view = { webContents: { id: 7 } }
    const built = factory().popup(view as never, undefined)
    expect(built.record.popupView).toBe(view)
    expect(built.record.view).toBe(view)
  })
})
