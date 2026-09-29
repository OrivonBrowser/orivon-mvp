import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BaseWindow } from 'electron'
import type { ShellServices } from '../../shell/shell-services.js'
import type { SubsystemContext } from '../../registry.js'

// extension-host.ts imports 'electron' and the seven virtual specifiers
// (electron-chrome-extensions-lib.d.ts's own header says why they exist)
// at module scope -- all mocked, same reasoning as
// extension-install-prompt.test.ts's own header. The mocked
// 'orivon:crx-extensions' class captures the Impl object the real library
// would otherwise have driven into `new ElectronChromeExtensions(...)`, so
// this suite can call createTab directly, the way the library would.

let capturedOptions: any

const getExtension = vi.fn<(id: string) => unknown>()

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { on: vi.fn() },
  session: {
    defaultSession: {
      extensions: { getExtension },
      serviceWorkers: { on: vi.fn() }
    },
    fromPartition: vi.fn()
  }
}))

vi.mock('orivon:crx-extensions', () => ({
  ElectronChromeExtensions: class {
    static handleCRXProtocol = vi.fn()
    on = vi.fn()
    constructor (opts: any) { capturedOptions = opts }
  }
}))

vi.mock('orivon:crx-extensions-partition', () => ({
  setSessionPartitionResolver: vi.fn()
}))

vi.mock('orivon:crx-extensions-router', () => ({
  setRemoteMessageSenderCheck: vi.fn(),
  setMessageSenderIdCheck: vi.fn(),
  setEventListenerFilter: vi.fn(),
  isSandboxPageUrl: vi.fn()
}))

vi.mock('orivon:crx-extensions-cookies', () => ({
  setCookieHostAccessCheck: vi.fn()
}))

vi.mock('orivon:crx-extensions-tabs', () => ({
  setTabUrlAccessCheck: vi.fn(),
  setTabHostAccessCheck: vi.fn()
}))

vi.mock('orivon:crx-extensions-browser-action', () => ({
  setTabCaptureInvocationRecorder: vi.fn()
}))

vi.mock('orivon:crx-extensions-tab-capture', () => ({
  setTabCaptureInvocationCheck: vi.fn(),
  setTabCaptureAppRefusalCheck: vi.fn(),
  setTabCaptureGrantRecorder: vi.fn(),
  setTabCaptureConsumedCheck: vi.fn()
}))

const { createExtensionHost, attachExtensionShell } = await import('../extension-host.js')

const AN_EXTENSION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function buildShell (): { services: ShellServices, openTrusted: ReturnType<typeof vi.fn> } {
  const openTrusted = vi.fn((target?: string) => target === undefined ? undefined : ['tab-id', {}])
  const win = { id: 1 } as unknown as BaseWindow
  const shellWindow = { window: win, tabs: { openTrusted } }
  const services = {
    windows: {
      all: () => [shellWindow],
      focused: () => shellWindow
    },
    tabLifecycle: { subscribe: vi.fn() }
  } as unknown as ShellServices
  return { services, openTrusted }
}

describe('extension-host: createTab', () => {
  beforeEach(() => {
    capturedOptions = undefined
    getExtension.mockReset()
  })

  it('refuses a chrome-extension URL whose id Electron reports as null (getExtension answers null, not undefined, for an unloaded id)', async () => {
    getExtension.mockReturnValue(null)
    createExtensionHost('preload.js')
    const { services, openTrusted } = buildShell()
    attachExtensionShell({} as unknown as SubsystemContext, services, {} as any)
    await expect(capturedOptions.createTab({ windowId: 1, url: `chrome-extension://${AN_EXTENSION_ID}/page.html` }))
      .rejects.toThrow(/refused to open/)
    expect(openTrusted).not.toHaveBeenCalled()
  })

  it('refuses a chrome-extension URL whose id Electron reports as undefined', async () => {
    getExtension.mockReturnValue(undefined)
    createExtensionHost('preload.js')
    const { services, openTrusted } = buildShell()
    attachExtensionShell({} as unknown as SubsystemContext, services, {} as any)
    await expect(capturedOptions.createTab({ windowId: 1, url: `chrome-extension://${AN_EXTENSION_ID}/page.html` }))
      .rejects.toThrow(/refused to open/)
    expect(openTrusted).not.toHaveBeenCalled()
  })

  it('allows a chrome-extension URL naming an extension Electron reports as loaded', async () => {
    getExtension.mockReturnValue({ id: AN_EXTENSION_ID })
    createExtensionHost('preload.js')
    const { services, openTrusted } = buildShell()
    attachExtensionShell({} as unknown as SubsystemContext, services, {} as any)
    const url = `chrome-extension://${AN_EXTENSION_ID}/page.html`
    await capturedOptions.createTab({ windowId: 1, url })
    expect(openTrusted).toHaveBeenCalledWith(url)
  })

  it('opens the normalised served URL for an ipfs:// target, not the raw ipfs: string', async () => {
    createExtensionHost('preload.js')
    const { services, openTrusted } = buildShell()
    attachExtensionShell({} as unknown as SubsystemContext, services, {} as any)
    await capturedOptions.createTab({ windowId: 1, url: 'ipfs://examplecid/index.html' })
    expect(openTrusted).toHaveBeenCalledTimes(1)
    const opened = openTrusted.mock.calls[0]?.[0]
    expect(opened).not.toBe('ipfs://examplecid/index.html')
    expect(opened).toMatch(/^https:\/\/ipfs\.orivon\//)
  })

  it('opens the trimmed URL when details.url carries surrounding whitespace', async () => {
    createExtensionHost('preload.js')
    const { services, openTrusted } = buildShell()
    attachExtensionShell({} as unknown as SubsystemContext, services, {} as any)
    await capturedOptions.createTab({ windowId: 1, url: '  https://example.com/page  ' })
    expect(openTrusted).toHaveBeenCalledWith('https://example.com/page')
  })
})
