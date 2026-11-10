import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipc = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: { send: ipc.send } }))

const { WORKER_CONTROL_CHANNEL } = await import('../../main/channels.js')

const setFrame = (main: boolean): void => { Object.defineProperty(process, 'isMainFrame', { value: main, configurable: true }) }

async function install (): Promise<void> {
  const { installWorkerControlReport } = await import('../worker-control.js')
  installWorkerControlReport()
}

beforeEach(() => { vi.resetModules(); ipc.send.mockClear(); setFrame(true); vi.stubGlobal('location', { href: 'https://kept.eth/page' }) })
afterEach(() => { Reflect.deleteProperty(process, 'isMainFrame'); vi.unstubAllGlobals() })

describe('installWorkerControlReport', () => {
  it('tells main the address of the document a worker controls', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { controller: { scriptURL: 'https://kept.eth/sw.js' } } })
    await install()
    expect(ipc.send).toHaveBeenCalledExactlyOnceWith(WORKER_CONTROL_CHANNEL, { documentUrl: 'https://kept.eth/page' })
  })

  it('says nothing for a document no worker controls', async () => {
    vi.stubGlobal('navigator', { serviceWorker: { controller: null } })
    await install()
    expect(ipc.send).not.toHaveBeenCalled()
  })

  it('says nothing where workers cannot exist, or where reading them fails', async () => {
    vi.stubGlobal('navigator', {})
    await install()
    vi.stubGlobal('navigator', { get serviceWorker (): never { throw new Error('no container') } })
    await install()
    expect(ipc.send).not.toHaveBeenCalled()
  })

  it('says nothing from a subframe', async () => {
    setFrame(false)
    vi.stubGlobal('navigator', { serviceWorker: { controller: {} } })
    await install()
    expect(ipc.send).not.toHaveBeenCalled()
  })
})
