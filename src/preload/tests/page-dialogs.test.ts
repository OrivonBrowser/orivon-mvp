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

interface Install { func: (askMain: (type: string, message: string, defaultText: string) => unknown) => void, args: [(type: string, message: string, defaultText: string) => unknown] }
const installed = (): Install => bridge.executeInMainWorld.mock.calls[0]?.[0] as Install

beforeEach(() => { bridge.executeInMainWorld.mockReset(); bridge.sendSync.mockReset() })
afterEach(() => { vi.unstubAllGlobals() })

describe('the page-dialog wrapper in a frame', () => {
  it('is installed into the page\'s own world, and a refusal to install is logged, not thrown', () => {
    installPageDialogs()
    expect(bridge.executeInMainWorld).toHaveBeenCalledTimes(1)

    bridge.executeInMainWorld.mockImplementation(() => { throw new Error('unavailable') })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => { installPageDialogs() }).not.toThrow()
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it('sends a call to main on the dialog channel and gives back what the page\'s own function would', () => {
    installPageDialogs()
    const [ask] = installed().args

    bridge.sendSync.mockReturnValueOnce(undefined)
    expect(ask('alert', 'hi', '')).toBeUndefined()
    expect(bridge.sendSync).toHaveBeenLastCalledWith(PAGE_DIALOG_CHANNEL, { type: 'alert', message: 'hi', defaultText: '' })

    bridge.sendSync.mockReturnValueOnce(true)
    expect(ask('confirm', 'sure?', '')).toBe(true)
    bridge.sendSync.mockReturnValueOnce('yes')
    expect(ask('confirm', 'sure?', '')).toBe(false)

    bridge.sendSync.mockReturnValueOnce('Ada')
    expect(ask('prompt', 'name?', 'x')).toBe('Ada')
    bridge.sendSync.mockReturnValueOnce(42)
    expect(ask('prompt', 'name?', 'x')).toBeNull()
  })

  it('answers a refused send as a dismissed dialog, never as an error in the page', () => {
    installPageDialogs()
    const [ask] = installed().args
    bridge.sendSync.mockImplementation(() => { throw new Error('closed') })
    expect(ask('alert', 'a', '')).toBeUndefined()
    expect(ask('confirm', 'a', '')).toBe(false)
    expect(ask('prompt', 'a', '')).toBeNull()
  })

  it('wraps alert, confirm and prompt so each call is main\'s question, whatever the page passes', () => {
    installPageDialogs()
    const { func } = installed()
    const ask = vi.fn(() => 'answer')
    const native = { alert: () => 'native', confirm: () => 'native', prompt: () => 'native' }
    vi.stubGlobal('window', native)
    func(ask)

    const page = native as Record<string, (...rest: unknown[]) => unknown>
    expect(page['alert']?.('hello')).toBe('answer')
    expect(page['confirm']?.()).toBe('answer')
    expect(page['prompt']?.('q', 'd')).toBe('answer')
    expect(page['prompt']?.({ toString: () => 'object text' })).toBe('answer')
    expect(ask.mock.calls).toEqual([
      ['alert', 'hello', ''],
      ['confirm', '', ''],
      ['prompt', 'q', 'd'],
      ['prompt', 'object text', '']
    ])
  })

  it('leaves a dialog function that is not there alone', () => {
    installPageDialogs()
    const { func } = installed()
    const native = { alert: () => 'native' } as Record<string, unknown>
    vi.stubGlobal('window', native)
    func(vi.fn())
    expect('confirm' in native).toBe(false)
  })

  it('survives a page whose text cannot be turned into a string', () => {
    installPageDialogs()
    const { func } = installed()
    const ask = vi.fn(() => undefined)
    const native = { alert: () => 'native' } as Record<string, (...rest: unknown[]) => unknown>
    vi.stubGlobal('window', native)
    func(ask)
    expect(() => native['alert']?.({ toString: () => { throw new Error('no') } })).not.toThrow()
    expect(ask).toHaveBeenCalledWith('alert', '', '')
  })
})
