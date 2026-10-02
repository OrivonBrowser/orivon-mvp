// A tab's preloads run in every subframe too (the tab's `nodeIntegrationInSubFrames`); a subframe must get the
// page-dialog wrapper and nothing else.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ names: [] as string[], exposed: [] as string[] }))
vi.mock('../ordinary-tab.js', () => ({ exposeOrdinaryTabSurface: () => { calls.names.push('surface') } }))
vi.mock('../page-dialogs.js', () => ({ installPageDialogs: () => { calls.names.push('dialogs') } }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string) => { calls.exposed.push(name) } },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
}))

const setFrame = (main: boolean | undefined): void => {
  Object.defineProperty(process, 'isMainFrame', { value: main, configurable: true })
}
const original = Object.getOwnPropertyDescriptor(process, 'isMainFrame')

beforeEach(() => {
  vi.resetModules()
  calls.names.length = 0
  calls.exposed.length = 0
  vi.stubGlobal('location', { href: 'orivon://newtab/', protocol: 'orivon:', hostname: 'settings' })
  process.argv.push('--orivon-newtab-url=orivon://newtab/', '--orivon-internal-page=settings')
})
afterEach(() => {
  vi.unstubAllGlobals()
  process.argv.length -= 2
  if (original === undefined) Reflect.deleteProperty(process, 'isMainFrame')
  else Object.defineProperty(process, 'isMainFrame', original)
})

describe('which preloads reach a subframe, and with what', () => {
  it('the top frame of an ordinary tab gets the dialog wrapper and the whole surface', async () => {
    setFrame(true)
    await import('../app.js')
    expect(calls.names).toEqual(['dialogs', 'surface'])
  })

  it('a subframe of an ordinary tab gets the dialog wrapper only', async () => {
    setFrame(false)
    await import('../app.js')
    expect(calls.names).toEqual(['dialogs'])
  })

  it('a preload that cannot tell which frame it is in is a subframe', async () => {
    setFrame(undefined)
    await import('../app.js')
    expect(calls.names).toEqual(['dialogs'])
  })

  it('a subframe of the dashboard tab exposes neither the dashboard\'s API nor the surface', async () => {
    setFrame(false)
    await import('../newtab.js')
    expect(calls.names).toEqual(['dialogs'])
    expect(calls.exposed).toEqual([])
  })

  it('the top frame of the dashboard tab still gets its own API', async () => {
    setFrame(true)
    await import('../newtab.js')
    expect(calls.exposed).toEqual(['orivonNewTab'])
  })

  it('a subframe of an internal page gets no internal API, even on the page\'s own address', async () => {
    setFrame(false)
    await import('../internal.js')
    expect(calls.names).toEqual(['dialogs'])
    expect(calls.exposed).toEqual([])
  })

  it('the top frame of an internal page still gets it', async () => {
    setFrame(true)
    await import('../internal.js')
    expect(calls.exposed).toEqual(['orivonInternal'])
  })
})
