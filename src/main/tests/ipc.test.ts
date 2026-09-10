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

  it('openSettings opens the settings window, with the address-bar icon\'s tab url when given', async () => {
    const permissions = fakePermissions()
    const openSettings = vi.fn()
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, permissions, openSettings)

    await dispatch({ type: 'openSettings' })
    await dispatch({ type: 'openSettings', url: 'https://app.example/some/page' })

    expect(openSettings).toHaveBeenNthCalledWith(1, undefined)
    expect(openSettings).toHaveBeenNthCalledWith(2, 'https://app.example/some/page')
  })

  it('refuses openSettings from a frame that is not the chrome view\'s own', async () => {
    const permissions = fakePermissions()
    const openSettings = vi.fn()
    registerShellIpc(chromeWebContents, {} as TabManager, {} as BookmarkStore, permissions, openSettings)

    await dispatch({ type: 'openSettings' }, OTHER_FRAME)

    expect(openSettings).not.toHaveBeenCalled()
  })
})
