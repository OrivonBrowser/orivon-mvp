import { describe, expect, it, vi } from 'vitest'
import type { TabManager } from '../tabs.js'
import type { BookmarkStore } from '../bookmarks.js'
import type { PermissionsController } from '../permissions.js'

// ipc.ts had no dedicated suite before queue item 4.4 (the tab/bookmark
// commands are exercised end-to-end by scripts/smoke.mjs instead) -- this
// file covers only the two commands this lane added on COMMAND_CHANNEL:
// the address-bar icon's per-tab lookup, and opening the settings window.
// Listing every app and revoking live on the settings window's OWN channel
// instead (settings-ipc.test.ts) -- see ShellCommand's own doc on why.

const handlers = new Map<string, (event: unknown, command: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: unknown, command: unknown) => unknown) => {
      handlers.set(channel, fn)
    })
  }
}))

const { registerShellIpc } = await import('../ipc.js')
const { COMMAND_CHANNEL } = await import('../channels.js')

const CHROME_FRAME = {}
const chromeWebContents = { mainFrame: CHROME_FRAME } as unknown as import('electron').WebContents
const OTHER_FRAME = {}

function fakePermissions (overrides: Partial<PermissionsController> = {}): PermissionsController {
  return {
    list: vi.fn(async () => []),
    forUrl: vi.fn(async () => null),
    revoke: vi.fn(async () => {}),
    revokeCapability: vi.fn(async () => {}),
    revokePickedPath: vi.fn(async () => {}),
    ...overrides
  }
}

function dispatch (command: unknown, senderFrame: unknown = CHROME_FRAME): unknown {
  const fn = handlers.get(COMMAND_CHANNEL)
  if (fn === undefined) throw new Error('registerShellIpc did not register a handler')
  return fn({ senderFrame }, command)
}

describe('registerShellIpc -- the permissions commands (queue item 4.4)', () => {
  it('appPermissionsFor forwards the tab URL to permissions.forUrl()', async () => {
    const permissions = fakePermissions({ forUrl: vi.fn(async () => null) })
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, permissions, vi.fn())

    await dispatch({ type: 'appPermissionsFor', url: 'https://app.example/page' })

    expect(permissions.forUrl).toHaveBeenCalledWith('https://app.example/page')
  })

  it('refuses appPermissionsFor from a frame that is not the chrome view\'s own', async () => {
    const permissions = fakePermissions()
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, permissions, vi.fn())

    await dispatch({ type: 'appPermissionsFor', url: 'https://app.example/page' }, OTHER_FRAME)

    expect(permissions.forUrl).not.toHaveBeenCalled()
  })

  it('openSettings toggles the permissions panel, passing the key\'s anchor and the tab url when given', async () => {
    const permissions = fakePermissions()
    const openSettings = vi.fn()
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, permissions, openSettings)

    // The anchor is the chrome view's measurement of its own permission key
    // -- main has no way to derive it, so it always rides the command.
    const anchor = { x: 900, y: 44, width: 32, height: 32 }
    await dispatch({ type: 'openSettings', anchor })
    await dispatch({ type: 'openSettings', url: 'https://app.example/some/page', anchor })

    expect(openSettings).toHaveBeenNthCalledWith(1, anchor, undefined)
    expect(openSettings).toHaveBeenNthCalledWith(2, anchor, 'https://app.example/some/page')
  })

  it('refuses openSettings from a frame that is not the chrome view\'s own', async () => {
    const permissions = fakePermissions()
    const openSettings = vi.fn()
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, permissions, openSettings)

    await dispatch({ type: 'openSettings', anchor: { x: 900, y: 44, width: 32, height: 32 } }, OTHER_FRAME)

    expect(openSettings).not.toHaveBeenCalled()
  })
})

describe('registerShellIpc -- starring a page keeps its icon', () => {
  const ICON = 'data:image/png;base64,iVBORw0KGgo='

  it('stores the icon MAIN already captured for that tab, not one sent by the renderer', () => {
    const add = vi.fn()
    const tabs = { faviconFor: vi.fn(() => ICON) } as unknown as TabManager
    registerShellIpc(chromeWebContents, tabs, { add } as unknown as BookmarkStore, fakePermissions(), vi.fn())

    void dispatch({ type: 'addBookmark', url: 'https://a.example/', title: 'A', tabId: 'tab-7' })

    expect(tabs.faviconFor).toHaveBeenCalledWith('tab-7')
    expect(add).toHaveBeenCalledWith({ url: 'https://a.example/', title: 'A', favicon: ICON })
  })

  it('saves the bookmark with no icon when that tab has not got one yet', () => {
    const add = vi.fn()
    const tabs = { faviconFor: vi.fn(() => null) } as unknown as TabManager
    registerShellIpc(chromeWebContents, tabs, { add } as unknown as BookmarkStore, fakePermissions(), vi.fn())

    void dispatch({ type: 'addBookmark', url: 'https://a.example/', title: 'A', tabId: 'tab-7' })

    expect(add).toHaveBeenCalledWith({ url: 'https://a.example/', title: 'A', favicon: null })
  })
})

describe('registerShellIpc -- deliveryProvenanceFor (S4-6, ADR-0007)', () => {
  it('forwards the tab URL to the injected deliveryProvenance function', async () => {
    const permissions = fakePermissions()
    const deliveryProvenance = vi.fn(async () => ({ servedFromPinnedCache: true }))
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, permissions, vi.fn(), deliveryProvenance)

    const result = await dispatch({ type: 'deliveryProvenanceFor', url: 'https://app.example/page' })

    expect(deliveryProvenance).toHaveBeenCalledWith('https://app.example/page')
    expect(result).toEqual({ servedFromPinnedCache: true })
  })

  it('refuses deliveryProvenanceFor from a frame that is not the chrome view\'s own', async () => {
    const permissions = fakePermissions()
    const deliveryProvenance = vi.fn(async () => ({ servedFromPinnedCache: true }))
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, permissions, vi.fn(), deliveryProvenance)

    await dispatch({ type: 'deliveryProvenanceFor', url: 'https://app.example/page' }, OTHER_FRAME)

    expect(deliveryProvenance).not.toHaveBeenCalled()
  })

  it('with no deliveryProvenance function injected, defaults to reporting false rather than throwing', async () => {
    const permissions = fakePermissions()
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, permissions, vi.fn())

    const result = await dispatch({ type: 'deliveryProvenanceFor', url: 'https://app.example/page' })

    expect(result).toEqual({ servedFromPinnedCache: false })
  })
})
