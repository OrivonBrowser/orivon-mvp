import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

// Drives the REAL ExtensionRouter.onExtensionMessage together with the REAL
// NotificationsAPI handlers, the same way tabs-webnav-host-access.test.ts
// drives TabsAPI/WebNavigationAPI.
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  Notification: class {
    on = vi.fn()
    once = vi.fn()
    show = vi.fn()
  }
}))

const { ExtensionRouter } = await import('../../../../vendor/electron-chrome-extensions/src/browser/router.js')
const { NotificationsAPI } = await import('../../../../vendor/electron-chrome-extensions/src/browser/api/notifications.js')

function manifestWith (permissions: readonly string[]): Record<string, unknown> {
  return { manifest_version: 3, name: 'x', version: '1.0.0', ...(permissions.length > 0 ? { permissions } : {}) }
}

function fakeSession (): Session {
  return {
    extensions: { on: vi.fn(), getExtension: vi.fn() },
    serviceWorkers: { on: vi.fn() }
  } as unknown as Session
}

function frameEvent (session: Session): any {
  return { type: 'frame', sender: { session } }
}

describe('chrome.notifications: the notifications permission', () => {
  it('refuses notifications.create from an extension whose manifest has no notifications permission', async () => {
    const session = fakeSession()
    const router = new ExtensionRouter(session)
    new NotificationsAPI({ router, session, store: {} } as any)
    session.extensions.getExtension = vi.fn(() => ({ id: 'ext', manifest: manifestWith([]) })) as any

    await expect(
      router.onExtensionMessage(frameEvent(session), 'ext', 'notifications.create', {
        type: 'basic',
        iconUrl: 'data:image/png;base64,AA==',
        title: 't',
        message: 'm'
      })
    ).rejects.toThrow(/notifications permission/)
  })

  it('refuses notifications.getAll the same way', async () => {
    const session = fakeSession()
    const router = new ExtensionRouter(session)
    new NotificationsAPI({ router, session, store: {} } as any)
    session.extensions.getExtension = vi.fn(() => ({ id: 'ext', manifest: manifestWith([]) })) as any

    await expect(
      router.onExtensionMessage(frameEvent(session), 'ext', 'notifications.getAll')
    ).rejects.toThrow(/notifications permission/)
  })

  it('allows notifications.create for an extension holding the permission', async () => {
    const session = fakeSession()
    const router = new ExtensionRouter(session)
    new NotificationsAPI({ router, session, store: {} } as any)
    session.extensions.getExtension = vi.fn(() => ({ id: 'ext', manifest: manifestWith(['notifications']) })) as any

    const id = await router.onExtensionMessage(frameEvent(session), 'ext', 'notifications.create', {
      type: 'basic',
      iconUrl: 'data:image/png;base64,AA==',
      title: 't',
      message: 'm'
    })
    expect(typeof id).toBe('string')
  })
})
