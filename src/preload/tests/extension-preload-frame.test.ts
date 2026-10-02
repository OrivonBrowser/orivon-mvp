// The session-wide frame preload that gives an extension's page its `chrome.*` runs in a subframe too once a
// tab runs its preloads there; only a top frame (or a worker) may get the API.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const inject = vi.hoisted(() => vi.fn())
vi.mock('../../../vendor/electron-chrome-extensions/src/renderer/index.js', () => ({ injectExtensionAPIs: inject }))
vi.mock('../../../vendor/electron-chrome-extensions/src/renderer/extras.js', () => ({ getExtraMainWorldApis: () => [] }))
vi.mock('electron', () => ({
  contextBridge: { executeInMainWorld: vi.fn() },
  ipcRenderer: { sendSync: vi.fn(() => false) }
}))

const original = Object.getOwnPropertyDescriptor(process, 'isMainFrame')
const setFrame = (main: boolean | undefined): void => {
  Object.defineProperty(process, 'isMainFrame', { value: main, configurable: true })
}

beforeEach(() => {
  vi.resetModules()
  inject.mockReset()
  vi.stubGlobal('location', { href: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html' })
  vi.stubGlobal('self', { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })
})
afterEach(() => {
  vi.unstubAllGlobals()
  if (original === undefined) Reflect.deleteProperty(process, 'isMainFrame')
  else Object.defineProperty(process, 'isMainFrame', original)
})

describe('which frames of a chrome-extension: page get the extension API', () => {
  it('the top frame of an extension page gets it', async () => {
    setFrame(true)
    await import('../../../vendor/electron-chrome-extensions/src/preload.js')
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('an extension page a site embeds in an iframe gets nothing', async () => {
    setFrame(false)
    await import('../../../vendor/electron-chrome-extensions/src/preload.js')
    expect(inject).not.toHaveBeenCalled()
  })

  it('a frame that cannot say which it is gets nothing', async () => {
    setFrame(undefined)
    await import('../../../vendor/electron-chrome-extensions/src/preload.js')
    expect(inject).not.toHaveBeenCalled()
  })
})
