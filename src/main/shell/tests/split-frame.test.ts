import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SPLIT_FRAME_CHANNEL, SPLIT_STATE_CHANNEL } from '../../channels.js'

interface Fake extends EventEmitter {
  mainFrame: object
  send: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  ipc: { handle: (channel: string, fn: (event: unknown, command: unknown) => void) => void }
}
const made: Array<{ webContents: Fake, options: { webPreferences: Record<string, unknown> } }> = []
const handlers = new Map<string, (event: unknown, command: unknown) => void>()

vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: (typeof made)[number], options: (typeof made)[number]['options']) {
    const contents = new EventEmitter() as Fake
    contents.mainFrame = {}
    contents.send = vi.fn()
    contents.loadURL = vi.fn(async () => {})
    contents.close = vi.fn()
    contents.isDestroyed = () => false
    contents.ipc = { handle: (channel, fn) => { handlers.set(channel, fn) } }
    this.webContents = contents
    this.options = options
    made.push(this)
  })
}))

const { SplitFrame } = await import('../split-frame.js')

beforeEach(() => { made.length = 0; handlers.clear() })

const STATE = { area: { x: 0, y: 76, width: 1000, height: 600 }, orientation: 'row', divider: null, panes: null, active: null, placeholder: null } as never

function frame (): { frame: InstanceType<typeof SplitFrame>, dragTo: ReturnType<typeof vi.fn>, reset: ReturnType<typeof vi.fn> } {
  const dragTo = vi.fn()
  const reset = vi.fn()
  return { frame: new SplitFrame({ dragTo, reset }, '/out/main'), dragTo, reset }
}

describe('SplitFrame', () => {
  it('makes its view only when asked for, once, with the privileges of a popover', () => {
    const { frame: f } = frame()
    expect(made).toHaveLength(0)
    const view = f.view
    expect(f.view).toBe(view)
    expect(made).toHaveLength(1)
    expect(made[0]?.options.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true })
    expect(made[0]?.webContents.loadURL).toHaveBeenCalledTimes(1)
  })

  it('draws what it is told, once the page has loaded, and the latest thing if it was told sooner', () => {
    const { frame: f } = frame()
    const contents = f.view.webContents as unknown as Fake
    f.update(STATE)
    expect(contents.send).not.toHaveBeenCalled()

    contents.emit('did-finish-load')
    expect(contents.send).toHaveBeenCalledExactlyOnceWith(SPLIT_STATE_CHANNEL, STATE)

    f.update({ ...(STATE as object), orientation: 'column' } as never)
    expect(contents.send).toHaveBeenCalledTimes(2)
  })

  it('hears a drag to a place and a reset, from its own page only, and only a number as a place', () => {
    const { frame: f, dragTo, reset } = frame()
    const contents = f.view.webContents as unknown as Fake
    const handler = handlers.get(SPLIT_FRAME_CHANNEL) as (event: unknown, command: unknown) => void

    handler({ senderFrame: contents.mainFrame }, { type: 'drag', at: 320 })
    handler({ senderFrame: contents.mainFrame }, { type: 'drag', at: '320' })
    handler({ senderFrame: contents.mainFrame }, { type: 'drag', at: Number.NaN })
    handler({ senderFrame: contents.mainFrame }, { type: 'reset' })
    handler({ senderFrame: contents.mainFrame }, { type: 'format-disk' })
    handler({ senderFrame: {} }, { type: 'drag', at: 100 })
    handler({ senderFrame: {} }, { type: 'reset' })

    expect(dragTo.mock.calls).toEqual([[320]])
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('is closed with the window, and does nothing to a view it never made', () => {
    const untouched = frame().frame
    expect(() => { untouched.dispose() }).not.toThrow()
    const { frame: f } = frame()
    const contents = f.view.webContents as unknown as Fake
    f.dispose()
    expect(contents.close).toHaveBeenCalledTimes(1)
  })
})
