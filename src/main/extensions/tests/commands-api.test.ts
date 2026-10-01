import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

// Driven against the real router, as router-permission-check.test.ts does: a
// handler this module registers replaces the library's own `commands.getAll`.
vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

const { ExtensionRouter } = await import('../../../../vendor/electron-chrome-extensions/src/browser/router.js')
const { commandsApi, provideCommandKeys, resetCommandKeys } = await import('../api/commands-api.js')

function fakeSession (extension: unknown): Session {
  return { extensions: { on: vi.fn(), getExtension: vi.fn(() => extension) }, serviceWorkers: { on: vi.fn() } } as unknown as Session
}

const frame = (session: Session): never => ({ type: 'frame', sender: { session, id: 1 } }) as never

function router (extensionId: string) {
  const session = fakeSession({ id: extensionId, manifest: { permissions: [] } })
  const r = new ExtensionRouter(session)
  const old = vi.fn(() => 'library')
  r.apiHandler()('commands.getAll', old)
  commandsApi.install({
    handle: (name: string, run: never) => { r.apiHandler()(name, run, {}) }
  } as never)
  return { call: async () => await r.onExtensionMessage(frame(session), extensionId, 'commands.getAll'), old }
}

describe('commands.getAll', () => {
  beforeEach(() => { resetCommandKeys() })

  it('answers from the command keys, not from the library', async () => {
    const { call, old } = router('ext-1')
    provideCommandKeys({ whenReady: async () => {}, getAll: (id) => [{ name: 'go', description: id, shortcut: 'Ctrl+Shift+Y' }] })
    expect(await call()).toEqual([{ name: 'go', description: 'ext-1', shortcut: 'Ctrl+Shift+Y' }])
    expect(old).not.toHaveBeenCalled()
  })

  it('waits for the keys and for the saved shortcuts when a worker asks early', async () => {
    const { call } = router('ext-1')
    let release: () => void = () => {}
    const pending = call()
    let settled = false
    void pending.then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(settled).toBe(false)
    provideCommandKeys({ whenReady: async () => { await new Promise<void>((resolve) => { release = resolve }) }, getAll: () => [] })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(settled).toBe(false)
    release()
    expect(await pending).toEqual([])
  })
})
