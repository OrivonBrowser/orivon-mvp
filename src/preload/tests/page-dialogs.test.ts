import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  executeInMainWorld: vi.fn(),
  sendSync: vi.fn()
}))
vi.mock('electron', () => ({
  contextBridge: { executeInMainWorld: bridge.executeInMainWorld, exposeInMainWorld: vi.fn() },
  ipcRenderer: { sendSync: bridge.sendSync, invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
}))

const { installPageDialogs } = await import('../page-dialogs.js')
const { PAGE_DIALOG_CHANNEL } = await import('../../main/channels.js')

interface Install { func: (askMain: (message: string, defaultText: string) => unknown) => void, args: [(message: string, defaultText: string) => unknown] }
const installed = (): Install => bridge.executeInMainWorld.mock.calls[0]?.[0] as Install

beforeEach(() => {
  bridge.executeInMainWorld.mockReset()
  bridge.sendSync.mockReset()
  vi.stubGlobal('window', { origin: 'https://page.example' })
  vi.stubGlobal('location', { protocol: 'https:' })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the page-prompt wrapper', () => {
  it('is installed into the page\'s own world, and a refusal to install is logged, not thrown', () => {
    installPageDialogs()
    expect(bridge.executeInMainWorld).toHaveBeenCalledTimes(1)

    bridge.executeInMainWorld.mockImplementation(() => { throw new Error('unavailable') })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => { installPageDialogs() }).not.toThrow()
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it('registers no listener on the page\'s window: one for beforeunload would make every navigation of the page wait on its renderer', () => {
    const addEventListener = vi.fn()
    vi.stubGlobal('window', { origin: 'https://page.example', addEventListener })
    installPageDialogs()
    expect(addEventListener).not.toHaveBeenCalled()
  })

  it('sends a prompt to main on the dialog channel and gives back the typed text, or null', () => {
    installPageDialogs()
    const [ask] = installed().args

    bridge.sendSync.mockReturnValueOnce('Ada')
    expect(ask('name?', 'x')).toBe('Ada')
    expect(bridge.sendSync).toHaveBeenLastCalledWith(PAGE_DIALOG_CHANNEL, { type: 'prompt', message: 'name?', defaultText: 'x' })
    bridge.sendSync.mockReturnValueOnce(null)
    expect(ask('name?', 'x')).toBeNull()
    bridge.sendSync.mockReturnValueOnce(42)
    expect(ask('name?', 'x')).toBeNull()
  })

  it('answers a prompt raised while the page is being left as dismissed, and never asks main', () => {
    installPageDialogs()
    const { func } = installed()
    const ask = vi.fn(() => 'asked')
    for (const type of ['beforeunload', 'pagehide', 'unload']) {
      const native = { prompt: () => 'native', event: { type } }
      vi.stubGlobal('window', native)
      func(ask)
      expect((native as unknown as Record<string, (...rest: unknown[]) => unknown>)['prompt']?.('a')).toBeNull()
    }
    expect(ask).not.toHaveBeenCalled()
  })

  it('still sees the event being handled after the page replaces window.event', () => {
    installPageDialogs()
    const { func } = installed()
    const ask = vi.fn(() => 'asked')
    let event: { type: string } | undefined = { type: 'beforeunload' }
    const native = { prompt: () => 'native' }
    Object.defineProperty(native, 'event', { get: () => event, set: () => {}, configurable: true })
    vi.stubGlobal('window', native)
    func(ask)
    Object.defineProperty(native, 'event', { value: 0, writable: true, configurable: true })
    const prompt = (native as unknown as Record<string, () => unknown>)['prompt']
    expect(prompt?.()).toBeNull()
    expect(ask).not.toHaveBeenCalled()
    event = { type: 'click' }
    expect(prompt?.()).toBe('asked')
  })

  it('answers a prompt raised by a page being hidden as dismissed, and asks for one raised by it being shown', () => {
    installPageDialogs()
    const { func } = installed()
    const ask = vi.fn(() => 'asked')
    const native = { prompt: () => 'native', event: { type: 'visibilitychange' } }
    vi.stubGlobal('window', native)
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    func(ask)
    const prompt = (native as unknown as Record<string, () => unknown>)['prompt']
    expect(prompt?.()).toBeNull()
    expect(ask).not.toHaveBeenCalled()
    vi.stubGlobal('document', { visibilityState: 'visible' })
    expect(prompt?.()).toBe('asked')
  })

  it('asks as usual while any other event is being handled', () => {
    installPageDialogs()
    const { func } = installed()
    const ask = vi.fn(() => 'asked')
    const native = { prompt: () => 'native', event: { type: 'click' } }
    vi.stubGlobal('window', native)
    func(ask)
    expect((native as unknown as Record<string, () => unknown>)['prompt']?.()).toBe('asked')
  })

  it('does not ask for a top-level document sandboxed to an opaque origin', () => {
    installPageDialogs()
    const [ask] = installed().args
    vi.stubGlobal('window', { origin: 'null' })
    bridge.sendSync.mockReturnValue('typed')
    expect(ask('ad', '')).toBeNull()
    expect(bridge.sendSync).not.toHaveBeenCalled()
  })

  it('answers a refused send as a dismissed prompt, never as an error in the page', () => {
    installPageDialogs()
    const [ask] = installed().args
    bridge.sendSync.mockImplementation(() => { throw new Error('closed') })
    expect(ask('a', '')).toBeNull()
  })

  it('wraps prompt so each call is main\'s question, whatever the page passes, and leaves alert and confirm to Electron\'s dialog event', () => {
    installPageDialogs()
    const { func } = installed()
    const ask = vi.fn(() => 'answer')
    const native = { alert: () => 'native', confirm: () => 'native', prompt: () => 'native' }
    vi.stubGlobal('window', native)
    func(ask)

    const page = native as Record<string, (...rest: unknown[]) => unknown>
    expect(page['prompt']?.('q', 'd')).toBe('answer')
    expect(page['prompt']?.()).toBe('answer')
    expect(page['prompt']?.({ toString: () => 'object text' })).toBe('answer')
    expect(ask.mock.calls).toEqual([['q', 'd'], ['', ''], ['object text', '']])
    expect(page['alert']?.('hello')).toBe('native')
    expect(page['confirm']?.('sure')).toBe('native')
  })

  it('leaves a prompt that is not there alone', () => {
    installPageDialogs()
    const { func } = installed()
    const native = { alert: () => 'native' } as Record<string, unknown>
    vi.stubGlobal('window', native)
    func(vi.fn())
    expect('prompt' in native).toBe(false)
  })

  it('survives a page whose text cannot be turned into a string', () => {
    installPageDialogs()
    const { func } = installed()
    const ask = vi.fn(() => null)
    const native = { prompt: () => 'native' } as Record<string, (...rest: unknown[]) => unknown>
    vi.stubGlobal('window', native)
    func(ask)
    expect(() => native['prompt']?.({ toString: () => { throw new Error('no') } })).not.toThrow()
    expect(ask).toHaveBeenCalledWith('', '')
  })
})
