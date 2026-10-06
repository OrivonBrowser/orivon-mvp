import { beforeEach, describe, expect, it, vi } from 'vitest'

// chrome.management.uninstall answers the store page, then tells it the extension is gone from a
// microtask. A store tab closed in between made that send throw outside any handler, and the main
// process exits on an uncaught exception (UPSTREAM.md, web-store patch 10).
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()
const uninstallExtension = vi.fn(async () => {})

vi.mock('electron', () => ({
  app: {},
  BrowserWindow: { fromWebContents: vi.fn() },
  nativeImage: { createFromBuffer: vi.fn() },
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => { handlers.set(channel, handler) } }
}))
vi.mock('../../../../vendor/electron-chrome-web-store/src/browser/installer.js', () => ({
  installExtension: vi.fn(),
  uninstallExtension: (...args: unknown[]) => uninstallExtension(...(args as []))
}))

const { registerWebStoreApi } = await import('../../../../vendor/electron-chrome-web-store/src/browser/api.js')

const session = {}

function storeFrame (): unknown {
  const frame: Record<string, unknown> = { origin: 'https://chromewebstore.google.com', isDestroyed: () => false }
  frame['top'] = frame
  return frame
}

function eventFrom (sender: { isDestroyed: () => boolean, send: (...args: unknown[]) => void }): unknown {
  return { senderFrame: storeFrame(), sender: { session, ...sender } }
}

beforeEach(() => {
  uninstallExtension.mockClear()
  registerWebStoreApi({ session, installing: new Set(), minimumManifestVersion: 3 } as never)
})

const settle = async (): Promise<void> => await new Promise((resolve) => setTimeout(resolve, 5))

describe('chrome.management.uninstall', () => {
  it('tells a live store page the extension is gone', async () => {
    const send = vi.fn()
    await handlers.get('chrome.management.uninstall')!(eventFrom({ isDestroyed: () => false, send }), 'abc', {})
    await settle()
    expect(send).toHaveBeenCalledWith('chrome.management.onUninstalled', 'abc')
  })

  it('does not throw when the store tab was destroyed before the notice went out', async () => {
    const uncaught = vi.fn()
    process.on('uncaughtException', uncaught)
    const send = vi.fn(() => { throw new Error('Object has been destroyed') })
    await handlers.get('chrome.management.uninstall')!(eventFrom({ isDestroyed: () => true, send }), 'abc', {})
    await settle()
    process.off('uncaughtException', uncaught)
    expect(uncaught).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
