import { describe, expect, it, vi } from 'vitest'

// UPSTREAM.md patch 67: chrome.runtime.openOptionsPage() shows the options tab that is
// already open and only opens one when there is none.
vi.mock('electron', () => ({ BaseWindow: { getAllWindows: () => [] }, BrowserWindow: { getAllWindows: () => [] }, nativeImage: {} }))

const { RuntimeAPI } = await import('../../../../vendor/electron-chrome-extensions/src/browser/api/runtime.js')

const ID = 'c'.repeat(32)

function setup (manifest: Record<string, unknown>, shown: boolean): { open: () => Promise<unknown>, createTab: ReturnType<typeof vi.fn>, activateTabShowing: ReturnType<typeof vi.fn> } {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const createTab = vi.fn(async () => undefined)
  const activateTabShowing = vi.fn(() => shown)
  const ctx = {
    router: { apiHandler: () => (name: string, fn: (...args: any[]) => unknown) => { handlers.set(name, fn) } },
    store: { impl: { activateTabShowing }, createTab }
  }
  new RuntimeAPI(ctx as never, {} as never, {} as never)
  const extension = { id: ID, manifest }
  return { open: async () => await handlers.get('runtime.openOptionsPage')?.({ type: 'frame', sender: {}, extension }), createTab, activateTabShowing }
}

describe('chrome.runtime.openOptionsPage', () => {
  it('opens no second tab when the options page is already open', async () => {
    const s = setup({ manifest_version: 3, options_page: 'options.html' }, true)
    await s.open()
    expect(s.activateTabShowing).toHaveBeenCalledWith(`chrome-extension://${ID}/options.html`)
    expect(s.createTab).not.toHaveBeenCalled()
  })

  it('opens the page of options_ui when no tab shows it', async () => {
    const s = setup({ manifest_version: 3, options_ui: { page: 'ui.html' } }, false)
    await s.open()
    expect(s.createTab).toHaveBeenCalledWith({ url: `chrome-extension://${ID}/ui.html`, active: true })
  })

  it('does nothing for an extension with no options page', async () => {
    const s = setup({ manifest_version: 3 }, false)
    await s.open()
    expect(s.createTab).not.toHaveBeenCalled()
    expect(s.activateTabShowing).not.toHaveBeenCalled()
  })
})
