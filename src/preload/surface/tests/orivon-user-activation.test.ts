import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asPage } from './main-world-socket.test-helpers.js'

// `orivon.fs.userSelected` needs a fresh user gesture, checked in
// THIS isolated world before `call()` ever sends the CONTROL_CHANNEL
// envelope -- split into its own file (code-guidelines.md Rule 2, "split
// by concern") once orivon.test.ts reached its own 800-line test budget;
// every other `fs.userSelected` test lives there and defaults this gate to
// "active" in its own `beforeEach` so it is not incidentally re-tested by
// every wiring assertion that has nothing to do with it. Every call goes
// through `asPage`, so the `window.orivon` caller filter (ADR-0045) lets it
// reach this gate rather than refusing it first with the same 'denied'.

const invoke = vi.fn()
const on = vi.fn()
const sendSync = vi.fn()
let executeInMainWorld: ReturnType<typeof vi.fn> | undefined
const exposeInMainWorld = vi.fn()

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (...args: unknown[]) => invoke(...args),
    on: (...args: unknown[]) => on(...args),
    sendSync: (...args: unknown[]) => sendSync(...args)
  },
  contextBridge: {
    exposeInMainWorld: (...args: unknown[]) => exposeInMainWorld(...args),
    get executeInMainWorld () { return executeInMainWorld },
    set executeInMainWorld (fn) { executeInMainWorld = fn }
  }
}))

const { exposeOrivon } = await import('../orivon.js')

function okEnvelope (result: unknown): { id: string, ok: true, result: unknown } {
  return { id: 'r', ok: true, result }
}

/** Same double orivon.test.ts's own `installViaFakeMainWorld` builds -- calls the real `installOrivon` against a captured plain object. */
function installViaFakeMainWorld (): Record<string, unknown> {
  const target: Record<string, unknown> = {}
  executeInMainWorld = vi.fn((opts: { func: (...args: unknown[]) => void, args: unknown[] }) => {
    opts.func(...opts.args, target)
  })
  return target
}

beforeEach(() => {
  invoke.mockReset()
  exposeInMainWorld.mockReset()
  executeInMainWorld = undefined
})

describe('exposeOrivon -- fs.userSelected needs a fresh user gesture', () => {
  it('with no user activation, rejects "denied" and never reaches the OS picker at all', async () => {
    Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: false } })
    const target = installViaFakeMainWorld()
    invoke.mockResolvedValue(okEnvelope([]))

    exposeOrivon()
    const orivon = asPage(target.orivon) as { fs: { userSelected: (opts?: { directory?: boolean }) => Promise<unknown> } }

    await expect(orivon.fs.userSelected()).rejects.toMatchObject({ code: 'denied' })
    await expect(orivon.fs.userSelected({ directory: true })).rejects.toMatchObject({ code: 'denied' })
    // No IPC round trip at all -- §Contracts: "without one it rejects
    // 'denied' and shows no dialog", checked BEFORE `call()` ever runs.
    expect(invoke).not.toHaveBeenCalled()
  })

  it('a browser with no navigator.userActivation at all (an older embedder) still fails closed, not open', async () => {
    Object.defineProperty(navigator, 'userActivation', { configurable: true, value: undefined })
    const target = installViaFakeMainWorld()

    exposeOrivon()
    const orivon = asPage(target.orivon) as { fs: { userSelected: () => Promise<unknown> } }

    await expect(orivon.fs.userSelected()).rejects.toMatchObject({ code: 'denied' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('with a fresh user activation, the call proceeds exactly as before', async () => {
    Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } })
    const target = installViaFakeMainWorld()
    invoke.mockResolvedValue(okEnvelope([]))

    exposeOrivon()
    const orivon = asPage(target.orivon) as { fs: { userSelected: () => Promise<unknown> } }

    await expect(orivon.fs.userSelected()).resolves.toEqual([])
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
