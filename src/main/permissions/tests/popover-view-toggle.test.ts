// Which toolbar icon asked, and where focus goes when a popup closes. The popup
// closes itself on blur, so the click on another icon arrives at main after the
// popup is already gone; a toggle read as the echo of its own icon is dropped,
// one for a different icon is not.
import { afterEach, describe, expect, it, vi } from 'vitest'

interface FakeWebContents {
  id: number
  handlers: Map<string, () => void>
  on: (event: string, handler: () => void) => void
  once: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  isDestroyed: () => boolean
  destroy: () => void
  isLoading: () => boolean
  isFocused: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
}

const { views } = vi.hoisted(() => ({ views: [] as Array<{ webContents: FakeWebContents, args: readonly string[], view: Record<string, unknown> }> }))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  WebContentsView: vi.fn().mockImplementation(function (this: Record<string, unknown>, options: { webPreferences: { additionalArguments: string[] } }) {
    let destroyed = false
    const handlers = new Map<string, () => void>()
    const webContents: FakeWebContents = {
      id: views.length + 1,
      handlers,
      on: (event, handler) => { handlers.set(event, handler) },
      once: vi.fn((event: string, handler: () => void) => { handlers.set(event, handler) }),
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn().mockResolvedValue(undefined),
      isDestroyed: () => destroyed,
      destroy: () => { destroyed = true },
      isLoading: () => false,
      isFocused: vi.fn(() => false),
      close: vi.fn(() => { destroyed = true }),
      focus: vi.fn()
    }
    this['webContents'] = webContents
    this['setBackgroundColor'] = vi.fn()
    this['setBorderRadius'] = vi.fn()
    this['setBounds'] = vi.fn()
    this['setVisible'] = vi.fn()
    views.push({ webContents, args: options.webPreferences.additionalArguments, view: this })
  }),
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() }
}))
vi.mock('../../shell/renderer-entry.js', () => ({ rendererEntryUrl: () => 'file:///popup.html', validatedDevServerUrl: () => undefined }))
vi.mock('../../shell/shell-session.js', () => ({ SHELL_PARTITION: 'persist:orivon-shell' }))

const { createPopoverView } = await import('../popover-view.js')

const ANCHOR = { x: 0, y: 0, width: 10, height: 10 }
const BACKGROUND = { light: '#f2f2f7', dark: '#2b2c31' }

function setup (activeContents?: () => unknown): { popover: ReturnType<typeof createPopoverView>, attached: () => number } {
  let attached = 0
  const contentView = { addChildView: () => { attached += 1 }, removeChildView: () => { attached -= 1 } }
  const win = { getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), on: vi.fn() }
  const popover = createPopoverView(win as never, contentView as never, {
    dirname: '/app', entryPath: '/site-info/', fallbackHtml: '../renderer/site-info/index.html',
    preloadRelPath: '../preload/site-info.js', urlArgName: 'orivon-site-info-url', align: 'left',
    background: BACKGROUND, registerIpc: () => () => {}, activeContents: activeContents as never
  })
  return { popover, attached: () => attached }
}

const last = (): FakeWebContents => {
  const view = views.at(-1)
  if (view === undefined) throw new Error('no view built')
  return view.webContents
}

afterEach(() => { views.length = 0 })

describe('putting a popup into the window', () => {
  it('makes the view visible when it is added, and again when it is restacked', () => {
    const { popover } = setup()
    popover.toggle(ANCHOR, ['--page=web3'], 'web3')
    const first = views.at(-1)?.view as { setVisible: ReturnType<typeof vi.fn> }
    expect(first.setVisible).toHaveBeenLastCalledWith(true)
    popover.close()
    first.setVisible.mockClear()

    popover.toggle(ANCHOR, ['--page=main'], 'main')
    popover.restack()

    const shown = views.at(-1)?.view as { setVisible: ReturnType<typeof vi.fn> }
    expect(shown.setVisible).toHaveBeenLastCalledWith(true)
  })
})

describe('a toolbar icon\'s toggle while a popup it did not open is showing or just closed', () => {
  it('opens the other page at once when the blur already closed the popup', () => {
    const { popover, attached } = setup()
    popover.toggle(ANCHOR, ['--page=web3'], 'web3')
    last().handlers.get('blur')?.()
    expect(attached()).toBe(0)
    popover.toggle(ANCHOR, ['--page=main'], 'main')
    expect(views).toHaveLength(2)
    expect(views[1]?.args).toContain('--page=main')
    expect(attached()).toBe(1)
  })

  it('still reads a second click on the same icon, after the blur, as the echo of its own close', () => {
    const { popover, attached } = setup()
    popover.toggle(ANCHOR, ['--page=web3'], 'web3')
    last().handlers.get('blur')?.()
    popover.toggle(ANCHOR, ['--page=web3'], 'web3')
    expect(views).toHaveLength(1)
    expect(attached()).toBe(0)
  })

  it('swaps to the other page when the popup is still showing', () => {
    const { popover, attached } = setup()
    popover.toggle(ANCHOR, ['--page=web3'], 'web3')
    popover.toggle(ANCHOR, ['--page=main'], 'main')
    expect(views).toHaveLength(2)
    expect(views[1]?.args).toContain('--page=main')
    expect(attached()).toBe(1)
  })

  it('closes on the same icon while showing', () => {
    const { popover, attached } = setup()
    popover.toggle(ANCHOR, [], 'main')
    popover.toggle(ANCHOR, [], 'main')
    expect(attached()).toBe(0)
  })

  it('without a key behaves as one icon: the echo of its own blur close is dropped', () => {
    const { popover } = setup()
    popover.toggle(ANCHOR, [])
    last().handlers.get('blur')?.()
    popover.toggle(ANCHOR, [])
    expect(views).toHaveLength(1)
  })
})

describe('a click judged by the press it completes', () => {
  afterEach(() => { vi.useRealTimers() })

  it('a button held for longer than the debounce still closes the popup and leaves it closed', () => {
    vi.useFakeTimers()
    const { popover, attached } = setup()
    popover.toggle(ANCHOR, [], 'main')
    last().handlers.get('blur')?.()
    vi.advanceTimersByTime(8)
    const pressedAt = Date.now()
    vi.advanceTimersByTime(900)
    popover.toggle(ANCHOR, [], 'main', pressedAt)
    expect(views).toHaveLength(1)
    expect(attached()).toBe(0)
  })

  it('a second click whose press came after the close opens the popup again', () => {
    vi.useFakeTimers()
    const { popover, attached } = setup()
    popover.toggle(ANCHOR, [], 'main')
    last().handlers.get('blur')?.()
    vi.advanceTimersByTime(150)
    popover.toggle(ANCHOR, [], 'main', Date.now() - 20)
    expect(views).toHaveLength(2)
    expect(attached()).toBe(1)
  })

  it('a click with no press keeps the debounce', () => {
    vi.useFakeTimers()
    const { popover } = setup()
    popover.toggle(ANCHOR, [], 'main')
    last().handlers.get('blur')?.()
    vi.advanceTimersByTime(100)
    popover.toggle(ANCHOR, [], 'main')
    expect(views).toHaveLength(1)
    vi.advanceTimersByTime(300)
    popover.toggle(ANCHOR, [], 'main')
    expect(views).toHaveLength(2)
  })
})

describe('focus when a popup closes', () => {
  it('goes back to the active tab when the popup held it', () => {
    const tab = { isDestroyed: () => false, focus: vi.fn() }
    const { popover } = setup(() => tab)
    popover.toggle(ANCHOR, [], 'main')
    last().isFocused.mockReturnValue(true)
    popover.close()
    expect(tab.focus).toHaveBeenCalledTimes(1)
  })

  it('stays where the person put it when the popup was closed by a click elsewhere', () => {
    const tab = { isDestroyed: () => false, focus: vi.fn() }
    const { popover } = setup(() => tab)
    popover.toggle(ANCHOR, [], 'main')
    last().handlers.get('blur')?.()
    expect(tab.focus).not.toHaveBeenCalled()
  })

  it('does not touch a destroyed tab, or fail when there is none', () => {
    const gone = { isDestroyed: () => true, focus: vi.fn() }
    const first = setup(() => gone)
    first.popover.toggle(ANCHOR, [], 'main')
    last().isFocused.mockReturnValue(true)
    first.popover.close()
    expect(gone.focus).not.toHaveBeenCalled()
    const second = setup(() => undefined)
    second.popover.toggle(ANCHOR, [], 'main')
    last().isFocused.mockReturnValue(true)
    expect(() => { second.popover.close() }).not.toThrow()
  })
})

describe('a popup whose page is gone while it shows', () => {
  it('closes when its renderer crashes, and the next click opens a new popup at once', () => {
    const { popover, attached } = setup()
    popover.toggle(ANCHOR, [], 'main')
    last().handlers.get('render-process-gone')?.()
    expect(attached()).toBe(0)
    expect(popover.isOpen()).toBe(false)
    popover.toggle(ANCHOR, [], 'main')
    expect(views).toHaveLength(2)
    expect(attached()).toBe(1)
  })

  it('closes without throwing when its contents are destroyed and the view no longer answers webContents', () => {
    const { popover, attached } = setup()
    popover.toggle(ANCHOR, [], 'main')
    const view = views[0]
    expect(view).toBeDefined()
    // The order the end-to-end run observed: the view has already lost its contents when blur arrives, and 'destroyed' follows.
    const contents = view?.webContents
    contents?.destroy()
    if (view !== undefined) view.view['webContents'] = undefined
    expect(() => { contents?.handlers.get('blur')?.() }).not.toThrow()
    contents?.handlers.get('destroyed')?.()
    expect(attached()).toBe(0)
    expect(popover.isOpen()).toBe(false)
    expect(() => { popover.close() }).not.toThrow()
    popover.toggle(ANCHOR, [], 'main')
    expect(views).toHaveLength(2)
    expect(attached()).toBe(1)
  })

  it('is closed by the window-level close even when the contents were destroyed first', () => {
    const { popover } = setup()
    popover.toggle(ANCHOR, [], 'main')
    const view = views[0]
    view?.webContents.destroy()
    if (view !== undefined) view.view['webContents'] = undefined
    expect(() => { popover.close() }).not.toThrow()
    expect(popover.isOpen()).toBe(false)
  })
})

describe('focus when the popup that holds the keyboard is gone', () => {
  it('goes back to the active tab when the popup crashes while shown', () => {
    const tab = { isDestroyed: () => false, focus: vi.fn() }
    const { popover } = setup(() => tab)
    popover.toggle(ANCHOR, [], 'main')
    last().handlers.get('render-process-gone')?.()
    expect(tab.focus).toHaveBeenCalledTimes(1)
  })

  it('goes back to the active tab when the popup is destroyed while shown', () => {
    const tab = { isDestroyed: () => false, focus: vi.fn() }
    const { popover } = setup(() => tab)
    popover.toggle(ANCHOR, [], 'main')
    last().destroy()
    last().handlers.get('destroyed')?.()
    expect(tab.focus).toHaveBeenCalledTimes(1)
  })

  it('leaves focus alone when a click elsewhere had already closed the popup', () => {
    const tab = { isDestroyed: () => false, focus: vi.fn() }
    const { popover } = setup(() => tab)
    popover.toggle(ANCHOR, [], 'main')
    last().handlers.get('blur')?.()
    last().destroy()
    last().handlers.get('destroyed')?.()
    expect(tab.focus).not.toHaveBeenCalled()
  })
})

describe('a popup whose detaching throws', () => {
  it('still releases its contents and does not throw to the caller', () => {
    const detach = vi.fn(() => { throw new Error('window disposed') })
    const win = { getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), on: vi.fn() }
    const popover = createPopoverView(win as never, { addChildView: vi.fn(), removeChildView: detach } as never, {
      dirname: '/app', entryPath: '/site-info/', fallbackHtml: '../renderer/site-info/index.html',
      preloadRelPath: '../preload/site-info.js', urlArgName: 'orivon-site-info-url', align: 'left',
      background: BACKGROUND, registerIpc: () => () => {}
    })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    popover.toggle(ANCHOR, [], 'main')
    expect(() => { popover.close() }).not.toThrow()
    expect(last().close).toHaveBeenCalledTimes(1)
    expect(popover.isOpen()).toBe(false)
    quiet.mockRestore()
  })
})

describe('a warm popup whose page is gone', () => {
  it('is rebuilt on the next open, and the dead view\'s late destroyed event is not read as a fresh open request', () => {
    let attached = 0
    const contentView = { addChildView: () => { attached += 1 }, removeChildView: () => { attached -= 1 } }
    const win = { getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), on: vi.fn() }
    const popover = createPopoverView(win as never, contentView as never, {
      dirname: '/app', entryPath: '/site-info/', fallbackHtml: '../renderer/site-info/index.html',
      preloadRelPath: '../preload/site-info.js', urlArgName: 'orivon-site-info-url', align: 'left',
      background: BACKGROUND, warm: true, registerIpc: () => () => {}
    })
    popover.toggle(ANCHOR, [], 'main')
    const dead = views[0]
    dead?.webContents.handlers.get('render-process-gone')?.()
    expect(attached).toBe(0)
    popover.toggle(ANCHOR, [], 'main')
    expect(views).toHaveLength(2)
    expect(attached).toBe(1)
    // The person clicks away from the rebuilt popup, then the dead one's contents report destroyed.
    views[1]?.webContents.handlers.get('blur')?.()
    dead?.webContents.handlers.get('destroyed')?.()
    popover.toggle(ANCHOR, [], 'main')
    expect(attached).toBe(0)
  })
})
