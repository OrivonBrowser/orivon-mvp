// What a subframe's preload evaluates must leave no trace in the preload realm: importing the ordinary-tab
// surface registers no listener and sends nothing until `exposeOrdinaryTabSurface` runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({
  on: vi.fn(),
  once: vi.fn(),
  send: vi.fn(),
  sendSync: vi.fn(),
  invoke: vi.fn(),
  addListener: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn(), executeInMainWorld: vi.fn() },
  ipcRenderer: ipc,
  webFrame: {}
}))

beforeEach(() => {
  vi.resetModules()
  for (const fn of Object.values(ipc)) fn.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(process, 'isMainFrame')
})

describe('evaluating the ordinary-tab surface without running it', () => {
  it('registers no ipcRenderer listener and sends nothing', async () => {
    await import('../ordinary-tab.js')
    expect(ipc.on).not.toHaveBeenCalled()
    expect(ipc.once).not.toHaveBeenCalled()
    expect(ipc.addListener).not.toHaveBeenCalled()
    expect(ipc.send).not.toHaveBeenCalled()
    expect(ipc.sendSync).not.toHaveBeenCalled()
    expect(ipc.invoke).not.toHaveBeenCalled()
  })
})

describe('a subframe running the tab preload', () => {
  it('leaves nothing in the preload realm but the dialog wrapper: no ipcRenderer listener, no exposed global', async () => {
    const win: Record<string, unknown> = { origin: 'https://ads.example', addEventListener: vi.fn() }
    win['top'] = {}
    vi.stubGlobal('window', win)
    vi.stubGlobal('location', { protocol: 'https:', href: 'https://ads.example/' })
    Object.defineProperty(process, 'isMainFrame', { value: false, configurable: true })
    await import('../app.js')
    expect(ipc.on).not.toHaveBeenCalled()
    expect(ipc.send).not.toHaveBeenCalled()
    expect(ipc.invoke).not.toHaveBeenCalled()
    const bridge = (await import('electron')).contextBridge as unknown as { exposeInMainWorld: ReturnType<typeof vi.fn> }
    expect(bridge.exposeInMainWorld).not.toHaveBeenCalled()
  })
})
