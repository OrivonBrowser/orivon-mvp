import { describe, expect, it, vi } from 'vitest'
import type { PermissionsController, SiteNotificationsController } from '../../permissions/permissions.js'

// The settings window's own channel (queue item 4.4) -- list()/revoke()
// dispatch, and the sender-identity check every command here gets (mirrors
// ipc.ts's own isFromChrome, against this window's webContents instead).
// The permissions.test.ts suite already proves revoke() tears down a real
// handle through `PermissionsController`; this file proves the IPC layer
// on top of it reaches that same controller and refuses an impostor sender.

const handlers = new Map<string, (event: unknown, command: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: unknown, command: unknown) => unknown) => {
      handlers.set(channel, fn)
    })
  }
}))

const { registerSettingsIpc } = await import('../settings-ipc.js')
const { SETTINGS_COMMAND_CHANNEL } = await import('../../channels.js')

const SETTINGS_FRAME = {}
const settingsWebContents = { mainFrame: SETTINGS_FRAME } as unknown as import('electron').WebContents
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

function dispatch (command: unknown, senderFrame: unknown = SETTINGS_FRAME): unknown {
  const fn = handlers.get(SETTINGS_COMMAND_CHANNEL)
  if (fn === undefined) throw new Error('registerSettingsIpc did not register a handler')
  return fn({ senderFrame }, command)
}

describe('registerSettingsIpc', () => {
  it('list calls permissions.list() and returns what it resolves', async () => {
    const permissions = fakePermissions({ list: vi.fn(async () => [{ origin: 'https://app.example', appName: 'Test', rows: [], pickedPathRows: [] }]) })
    registerSettingsIpc(settingsWebContents, permissions)

    const result = await dispatch({ type: 'list' })

    expect(permissions.list).toHaveBeenCalledOnce()
    expect(result).toEqual([{ origin: 'https://app.example', appName: 'Test', rows: [], pickedPathRows: [] }])
  })

  it('revoke forwards origin and grantId to permissions.revoke() -- the settings page\'s own Revoke button', async () => {
    const permissions = fakePermissions()
    registerSettingsIpc(settingsWebContents, permissions)

    await dispatch({ type: 'revoke', origin: 'https://app.example', grantId: 'g1' })

    expect(permissions.revoke).toHaveBeenCalledWith('https://app.example', 'g1')
  })

  it('refuses every command from a frame that is not the settings window\'s own', async () => {
    const permissions = fakePermissions()
    registerSettingsIpc(settingsWebContents, permissions)

    await dispatch({ type: 'list' }, OTHER_FRAME)
    await dispatch({ type: 'revoke', origin: 'https://app.example', grantId: 'g1' }, OTHER_FRAME)

    expect(permissions.list).not.toHaveBeenCalled()
    expect(permissions.revoke).not.toHaveBeenCalled()
  })

  it('refuses a command whose senderFrame is null', async () => {
    const permissions = fakePermissions()
    registerSettingsIpc(settingsWebContents, permissions)

    await dispatch({ type: 'list' }, null)

    expect(permissions.list).not.toHaveBeenCalled()
  })

  // The site list: each site's notification answer, and Reset, which
  // forgets it so the site asks again.
  it('lists the sites\' notification answers, and resets one by origin', async () => {
    const rows = [{ origin: 'https://chat.example', allowed: true, message: 'Can show notifications.' }]
    const sites: SiteNotificationsController = { list: vi.fn(() => rows), reset: vi.fn() }
    registerSettingsIpc(settingsWebContents, fakePermissions(), () => {}, sites)

    expect(await dispatch({ type: 'listSiteNotifications' })).toEqual(rows)
    await dispatch({ type: 'resetSiteNotifications', origin: 'https://chat.example' })
    expect(sites.reset).toHaveBeenCalledWith('https://chat.example')
  })

  it('ignores a reset whose origin is not a string, and one from another frame', async () => {
    const sites: SiteNotificationsController = { list: vi.fn(() => []), reset: vi.fn() }
    registerSettingsIpc(settingsWebContents, fakePermissions(), () => {}, sites)

    await dispatch({ type: 'resetSiteNotifications', origin: 42 })
    await dispatch({ type: 'resetSiteNotifications', origin: 'https://chat.example' }, OTHER_FRAME)
    await dispatch({ type: 'listSiteNotifications' }, OTHER_FRAME)
    expect(sites.reset).not.toHaveBeenCalled()
    expect(sites.list).not.toHaveBeenCalled()
  })

  it('lists no sites when the panel was given no site list', async () => {
    registerSettingsIpc(settingsWebContents, fakePermissions())
    expect(await dispatch({ type: 'listSiteNotifications' })).toEqual([])
  })
})

describe('registerSettingsIpc: the light client section', () => {
  const VIEW = { state: 'synced' as const, summary: 'Following the chain.', checkpoint: 'Checkpoint 3 hours old.', about: 'It proves names.', endpoints: [] }

  it('answers lightClient with the current view, and null when there is no source', async () => {
    registerSettingsIpc(settingsWebContents, fakePermissions(), () => {}, undefined, { view: () => VIEW, subscribe: () => () => {} })
    expect(await dispatch({ type: 'lightClient' })).toEqual(VIEW)
    registerSettingsIpc(settingsWebContents, fakePermissions())
    expect(await dispatch({ type: 'lightClient' })).toBeNull()
  })

  it('pushes each change while open, and stops once the returned cleanup runs', async () => {
    const send = vi.fn()
    const contents = { mainFrame: SETTINGS_FRAME, isDestroyed: () => false, send } as unknown as import('electron').WebContents
    let listener: (() => void) | undefined
    const cleanup = registerSettingsIpc(contents, fakePermissions(), () => {}, undefined, {
      view: () => VIEW,
      subscribe: (l) => { listener = l; return () => { listener = undefined } }
    })
    listener?.()
    const { LIGHT_CLIENT_STATUS_CHANNEL } = await import('../../channels.js')
    expect(send).toHaveBeenCalledExactlyOnceWith(LIGHT_CLIENT_STATUS_CHANNEL, VIEW)
    cleanup()
    expect(listener).toBeUndefined()
  })

  it('refuses the command from any other frame', async () => {
    registerSettingsIpc(settingsWebContents, fakePermissions(), () => {}, undefined, { view: () => VIEW, subscribe: () => () => {} })
    expect(await dispatch({ type: 'lightClient' }, OTHER_FRAME)).toBeUndefined()
  })
})
