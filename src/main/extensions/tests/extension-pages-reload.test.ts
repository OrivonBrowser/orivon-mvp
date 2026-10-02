import { describe, expect, it, vi } from 'vitest'
import { reloadExtensionPages, type ReloadablePage } from '../extension-pages-reload.js'
import { watchForMissedServiceWorkerPreload } from '../extension-sw-preload-recovery.js'
import { EXTENSION_SW_HEALTH_REPLY_CHANNEL } from '../../channels.js'

const ID = 'abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'ponmlkjihgfedcbaponmlkjihgfedcba'

function page (url: string, destroyed = false): ReloadablePage & { loadURL: ReturnType<typeof vi.fn> } {
  return { isDestroyed: () => destroyed, getURL: () => url, loadURL: vi.fn(async () => undefined) }
}

describe('reloadExtensionPages', () => {
  it('navigates every live page of the extension to its own URL again, and nothing else', () => {
    const welcome = page(`chrome-extension://${ID}/welcome.html`)
    const popup = page(`chrome-extension://${ID}/popup.html#tab`)
    const foreign = page(`chrome-extension://${OTHER}/welcome.html`)
    const web = page('https://example.com/')
    const gone = page(`chrome-extension://${ID}/gone.html`, true)

    expect(reloadExtensionPages(ID, [welcome, popup, foreign, web, gone])).toBe(2)

    expect(welcome.loadURL).toHaveBeenCalledWith(`chrome-extension://${ID}/welcome.html`)
    expect(popup.loadURL).toHaveBeenCalledWith(`chrome-extension://${ID}/popup.html#tab`)
    for (const untouched of [foreign, web, gone]) expect(untouched.loadURL).not.toHaveBeenCalled()
  })

  it('logs a page that cannot be reloaded and still reloads the rest', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const stuck = page(`chrome-extension://${ID}/a.html`)
    stuck.loadURL.mockRejectedValue(new Error('ERR_FAILED'))
    const fine = page(`chrome-extension://${ID}/b.html`)

    expect(reloadExtensionPages(ID, [stuck, fine])).toBe(2)
    await new Promise((resolve) => setImmediate(resolve))

    expect(fine.loadURL).toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('could not reload'), expect.any(Error))
    errorSpy.mockRestore()
  })
})

describe('watchForMissedServiceWorkerPreload: pages opened around the recovery', () => {
  it('tells the caller once the extension has been reloaded', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const handlers: Array<(event: { runningStatus: string, versionId: number }) => void> = []
    let reply: ((event: unknown, ok: boolean) => void) | undefined
    const worker = {
      scope: `chrome-extension://${ID}/background.js`,
      send: vi.fn(),
      ipc: { once: vi.fn((channel: string, fn: (event: unknown, ok: boolean) => void) => { if (channel === EXTENSION_SW_HEALTH_REPLY_CHANNEL) reply = fn }) }
    }
    const session = {
      extensions: { getExtension: vi.fn(() => ({ path: '/ext' })), removeExtension: vi.fn(), loadExtension: vi.fn(async () => undefined) },
      serviceWorkers: {
        on: vi.fn((name: string, fn: (event: { runningStatus: string, versionId: number }) => void) => { if (name === 'running-status-changed') handlers.push(fn) }),
        getWorkerFromVersionID: vi.fn(() => worker)
      }
    } as unknown as Parameters<typeof watchForMissedServiceWorkerPreload>[0]
    const reloaded = vi.fn()

    watchForMissedServiceWorkerPreload(session, undefined, reloaded)
    handlers[0]?.({ runningStatus: 'running', versionId: 1 })
    reply?.(undefined, false)
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))

    expect(reloaded).toHaveBeenCalledExactlyOnceWith(ID)
    errorSpy.mockRestore()
  })
})
