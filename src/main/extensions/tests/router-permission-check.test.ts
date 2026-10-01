import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

// UPSTREAM.md patch 15: setPermissionCheck overrides onExtensionMessage's
// manifest-permission gate. Driven against the real router.ts, the same way
// router-listener-sender-id.test.ts drives patch 9 (that file's own header
// says why this is possible: UPSTREAM.md patches 13-14 make router.ts
// satisfy the root tsconfig).
const onHandlers = new Map<string, (...args: any[]) => unknown>()

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn((channel: string, fn: (...args: any[]) => unknown) => { onHandlers.set(channel, fn) })
  }
}))

const { ExtensionRouter, setPermissionCheck } = await import(
  '../../../../vendor/electron-chrome-extensions/src/browser/router.js'
)

function fakeSession (extension: unknown): Session {
  return {
    extensions: { on: vi.fn(), getExtension: vi.fn(() => extension) },
    serviceWorkers: { on: vi.fn() }
  } as unknown as Session
}

function frameEvent (session: Session): any {
  return { type: 'frame', sender: { session, id: 1 } }
}

describe('setPermissionCheck (UPSTREAM.md patch 15)', () => {
  it('falls back to the loaded manifest\'s own permissions when unset', async () => {
    setPermissionCheck(undefined as any)
    const extension = { id: 'ext-1', manifest: { permissions: ['tabs'] } }
    const session = fakeSession(extension)
    const router = new ExtensionRouter(session)
    const callback = vi.fn(async () => 'ok')
    router.apiHandler()('test.method', callback, { permission: 'tabs' })

    const result = await router.onExtensionMessage(frameEvent(session), 'ext-1', 'test.method')
    expect(result).toBe('ok')
    expect(callback).toHaveBeenCalled()
  })

  it('refuses against the loaded manifest when the permission is absent, with no override set', async () => {
    setPermissionCheck(undefined as any)
    const extension = { id: 'ext-1', manifest: { permissions: [] } }
    const session = fakeSession(extension)
    const router = new ExtensionRouter(session)
    router.apiHandler()('test.method', vi.fn(), { permission: 'declarativeNetRequest' })

    await expect(router.onExtensionMessage(frameEvent(session), 'ext-1', 'test.method')).rejects.toThrow(
      /requires an extension with declarativeNetRequest permissions/
    )
  })

  it('uses the override instead of the loaded (stripped) manifest when set', async () => {
    // The loaded manifest has NO declarativeNetRequest permission (Orivon
    // strips it before load) -- the default check would always refuse.
    const extension = { id: 'ext-1', manifest: { permissions: [] } }
    const session = fakeSession(extension)
    const router = new ExtensionRouter(session)
    const callback = vi.fn(async () => 'ok')
    router.apiHandler()('declarativeNetRequest.updateDynamicRules', callback, { permission: 'declarativeNetRequest' })

    setPermissionCheck((extensionId: string, permission: string) => extensionId === 'ext-1' && permission === 'declarativeNetRequest')
    const result = await router.onExtensionMessage(frameEvent(session), 'ext-1', 'declarativeNetRequest.updateDynamicRules')
    expect(result).toBe('ok')
  })

  it('the override refusing still refuses the call', async () => {
    const extension = { id: 'ext-1', manifest: { permissions: ['declarativeNetRequest'] } }
    const session = fakeSession(extension)
    const router = new ExtensionRouter(session)
    router.apiHandler()('declarativeNetRequest.updateDynamicRules', vi.fn(), { permission: 'declarativeNetRequest' })

    setPermissionCheck(() => false)
    await expect(router.onExtensionMessage(frameEvent(session), 'ext-1', 'declarativeNetRequest.updateDynamicRules')).rejects.toThrow(
      /requires an extension with declarativeNetRequest permissions/
    )
    setPermissionCheck(undefined as any)
  })

  it('a handler with no permission option is never checked, override or not', async () => {
    const extension = { id: 'ext-1', manifest: { permissions: [] } }
    const session = fakeSession(extension)
    const router = new ExtensionRouter(session)
    const callback = vi.fn(async () => 'ok')
    router.apiHandler()('test.unguarded', callback)

    setPermissionCheck(() => false)
    const result = await router.onExtensionMessage(frameEvent(session), 'ext-1', 'test.unguarded')
    expect(result).toBe('ok')
    setPermissionCheck(undefined as any)
  })
})
