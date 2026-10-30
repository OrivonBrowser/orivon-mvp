import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../tab-view.js', () => ({
  appTabArgsFor: vi.fn(),
  makeDashboardView: vi.fn(),
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

const emitState = vi.fn()
const factory = (): InstanceType<typeof TabFactory> => new TabFactory({ services: undefined, emitState } as never, () => undefined, 'http://localhost:5999/newtab/', undefined)
const popupOf = (opener: unknown): { webContents: EventEmitter & { opener: unknown, id: number } } => ({ webContents: Object.assign(new EventEmitter(), { opener, id: 7 }) })

describe('a popup Chromium made for a page', () => {
  it('is recorded as a popup its opener writes into when it holds that opener, and the chrome is told', () => {
    const view = popupOf({})
    const built = factory().popup(view as never, undefined)
    expect(built.record.view).toBe(view)
    expect(built.record.popupWithOpener).toBe(view)
    expect(emitState).toHaveBeenCalled()
  })

  it('is not recorded without one, as a link with a target opens its tab', () => {
    emitState.mockClear()
    const view = popupOf(null)
    const built = factory().popup(view as never, undefined)
    view.webContents.emit('did-start-navigation', { isMainFrame: true })
    expect(built.record.popupWithOpener).toBeUndefined()
    expect(emitState).not.toHaveBeenCalled()
  })
})
