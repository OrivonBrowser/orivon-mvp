import { describe, expect, it, vi } from 'vitest'

// Drives the REAL ExtensionStore.createTab. extension-host.ts's own
// createTab impl opens a granted app's URL in that app's OWN session
// (openTrusted), never session.defaultSession -- this suite reproduces that
// shape with a fake impl.createTab returning a webContents from a
// DIFFERENT session than the one ExtensionStore was constructed with.
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  webContents: { fromId: (id: number) => ({ id }) }
}))

const { ExtensionStore } = await import('../../../../vendor/electron-chrome-extensions/src/browser/store.js')

function fakeSession (): any {
  return {}
}

function fakeWindow (): any {
  return { id: 1, isDestroyed: () => false }
}

function fakeTab (id: number, session: unknown): any {
  return { id, session, isDestroyed: () => false }
}

describe('ExtensionStore.createTab: the returned webContents must be in the extensions session', () => {
  it('refuses a tab from a different session, and never adds it to the store', async () => {
    const extensionsSession = fakeSession()
    const otherSession = fakeSession()
    const win = fakeWindow()
    const tab = fakeTab(1, otherSession)
    const createTab = vi.fn(async (): Promise<[any, any]> => [tab, win])
    const store = new ExtensionStore({ createTab }, extensionsSession)
    const tabAdded = vi.fn()
    store.on('tab-added', tabAdded)

    await expect(store.createTab({})).rejects.toThrow(/extensions session/)
    expect(tabAdded).not.toHaveBeenCalled()
    expect(store.tabs.has(tab)).toBe(false)
  })

  it('still adds a tab from the extensions session itself', async () => {
    const extensionsSession = fakeSession()
    const win = fakeWindow()
    const tab = fakeTab(1, extensionsSession)
    const createTab = vi.fn(async (): Promise<[any, any]> => [tab, win])
    const store = new ExtensionStore({ createTab }, extensionsSession)

    const result = await store.createTab({})
    expect(result).toBe(tab)
    expect(store.tabs.has(tab)).toBe(true)
  })

  it('never checks the session when the store was constructed with none (backwards compatible for a caller with no session option)', async () => {
    const win = fakeWindow()
    const tab = fakeTab(1, fakeSession())
    const createTab = vi.fn(async (): Promise<[any, any]> => [tab, win])
    const store = new ExtensionStore({ createTab })

    const result = await store.createTab({})
    expect(result).toBe(tab)
  })
})
