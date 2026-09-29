// A freshly created WebContentsView defaults to an opaque white background,
// painted the instant Electron composites its first frame -- well before the
// popup's own page has loaded its stylesheet. This proves createPopoverView
// sets the popup's OWN theme colour before it is ever attached to the
// screen, that it tracks nativeTheme rather than a value baked in once, and
// (for a `warm` popup, ./menu-panel.ts's own case) that the fix survives
// being kept open across shows instead of rebuilt on every one.
import { afterEach, describe, expect, it, vi } from 'vitest'

const { calls, nativeThemeState, nativeThemeListeners } = vi.hoisted(() => ({
  calls: [] as string[],
  nativeThemeState: { shouldUseDarkColors: false },
  nativeThemeListeners: [] as Array<() => void>
}))

interface FakeWebContents {
  id: number
  on: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  isLoading: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
}

let nextWebContentsId = 1

function fakeWebContents (): FakeWebContents {
  const id = nextWebContentsId++
  let destroyed = false
  return {
    id,
    on: vi.fn(),
    once: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    isDestroyed: vi.fn(() => destroyed),
    isLoading: vi.fn().mockReturnValue(false),
    close: vi.fn(() => { destroyed = true; calls.push(`close:${id}`) }),
    focus: vi.fn()
  }
}

// popover-view.ts imports WebContentsView and nativeTheme from 'electron' at
// module scope (tab-view.test.ts's own header explains why this is
// unavoidable). Every constructed instance's setBackgroundColor and the
// contentView's addChildView/removeChildView push onto the SAME `calls`
// array, so a test can assert relative ORDER, not just that each happened.
vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.webContents = fakeWebContents()
    this.setBackgroundColor = vi.fn((color: string) => { calls.push(`setBackgroundColor:${color}`) })
    this.setBorderRadius = vi.fn()
    this.setBounds = vi.fn()
  }),
  get nativeTheme () {
    return {
      get shouldUseDarkColors () { return nativeThemeState.shouldUseDarkColors },
      on: (_event: 'updated', listener: () => void) => { nativeThemeListeners.push(listener) },
      removeListener: (_event: 'updated', listener: () => void) => {
        const at = nativeThemeListeners.indexOf(listener)
        if (at !== -1) nativeThemeListeners.splice(at, 1)
      }
    }
  }
}))

vi.mock('../../shell/renderer-entry.js', () => ({ rendererEntryUrl: () => 'file:///popup.html' }))
vi.mock('../../shell/shell-session.js', () => ({ SHELL_PARTITION: 'persist:orivon-shell' }))

const { createPopoverView } = await import('../popover-view.js')
const { WebContentsView } = await import('electron')

function fireThemeUpdated (): void { for (const listener of [...nativeThemeListeners]) listener() }

function fakeWin (): { getContentBounds: () => { x: number, y: number, width: number, height: number }, on: ReturnType<typeof vi.fn> } {
  return { getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 800 }), on: vi.fn() }
}

function fakeContentView (): { addChildView: (v: unknown) => void, removeChildView: (v: unknown) => void } {
  return {
    addChildView: () => { calls.push('addChildView') },
    removeChildView: () => { calls.push('removeChildView') }
  }
}

const BACKGROUND = { light: '#f2f2f7', dark: '#2b2c31' }
const ANCHOR = { x: 0, y: 0, width: 10, height: 10 }

afterEach(() => {
  calls.length = 0
  nativeThemeState.shouldUseDarkColors = false
  nativeThemeListeners.length = 0
  nextWebContentsId = 1
  vi.mocked(WebContentsView).mockClear()
})

describe('createPopoverView: background colour set before the view is ever shown', () => {
  it('sets the LIGHT colour, before addChildView, when the OS theme is light', () => {
    const popover = createPopoverView(fakeWin() as never, fakeContentView() as never, {
      dirname: '/app', entryPath: '/menu/', fallbackHtml: '../renderer/menu/index.html',
      preloadRelPath: '../preload/menu.js', urlArgName: 'orivon-menu-url', align: 'right',
      background: BACKGROUND, registerIpc: () => () => {}
    })

    popover.toggle(ANCHOR, [])

    expect(calls).toEqual(['setBackgroundColor:#f2f2f7', 'addChildView'])
  })

  it('sets the DARK colour when the OS theme is dark', () => {
    nativeThemeState.shouldUseDarkColors = true
    const popover = createPopoverView(fakeWin() as never, fakeContentView() as never, {
      dirname: '/app', entryPath: '/menu/', fallbackHtml: '../renderer/menu/index.html',
      preloadRelPath: '../preload/menu.js', urlArgName: 'orivon-menu-url', align: 'right',
      background: BACKGROUND, registerIpc: () => () => {}
    })

    popover.toggle(ANCHOR, [])

    expect(calls[0]).toBe('setBackgroundColor:#2b2c31')
  })

  it('a non-warm popup is destroyed on close and rebuilt fresh on the next open', () => {
    const popover = createPopoverView(fakeWin() as never, fakeContentView() as never, {
      dirname: '/app', entryPath: '/permissions/', fallbackHtml: '../renderer/permissions/index.html',
      preloadRelPath: '../preload/permissions.js', urlArgName: 'orivon-permissions-url', align: 'right',
      background: BACKGROUND, registerIpc: () => () => {}
    })

    popover.toggle(ANCHOR, [])
    expect(vi.mocked(WebContentsView)).toHaveBeenCalledTimes(1)
    popover.close()
    expect(calls).toContain('close:1')

    // Past REOPEN_DEBOUNCE_MS: an immediate second toggle is read as the
    // echo of this close's own blur, not fresh intent (popover-view.ts's own
    // doc), which is correct but not what this test is about.
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_000)
    popover.toggle(ANCHOR, [])
    expect(vi.mocked(WebContentsView)).toHaveBeenCalledTimes(2)
    dateNow.mockRestore()
  })
})

describe('createPopoverView: a `warm` popup (menu-panel.ts\'s own case)', () => {
  it('is built once, before the first toggle, via setImmediate', async () => {
    createPopoverView(fakeWin() as never, fakeContentView() as never, {
      dirname: '/app', entryPath: '/menu/', fallbackHtml: '../renderer/menu/index.html',
      preloadRelPath: '../preload/menu.js', urlArgName: 'orivon-menu-url', align: 'right',
      background: BACKGROUND, warm: true, registerIpc: () => () => {}
    })

    expect(vi.mocked(WebContentsView)).not.toHaveBeenCalled()
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(vi.mocked(WebContentsView)).toHaveBeenCalledTimes(1)
  })

  it('hides instead of destroying, and reuses the SAME view on the next show', async () => {
    const onShow = vi.fn()
    const popover = createPopoverView(fakeWin() as never, fakeContentView() as never, {
      dirname: '/app', entryPath: '/menu/', fallbackHtml: '../renderer/menu/index.html',
      preloadRelPath: '../preload/menu.js', urlArgName: 'orivon-menu-url', align: 'right',
      background: BACKGROUND, warm: true, onShow, registerIpc: () => () => {}
    })
    await new Promise((resolve) => { setImmediate(resolve) })

    popover.toggle(ANCHOR, [])
    expect(onShow).toHaveBeenCalledTimes(1)
    popover.toggle(ANCHOR, []) // hide
    expect(calls).not.toContain('close:1')

    // Past REOPEN_DEBOUNCE_MS -- see the non-warm test's own comment on this.
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1_000)
    popover.toggle(ANCHOR, []) // show again
    expect(onShow).toHaveBeenCalledTimes(2)
    dateNow.mockRestore()

    // Still only the one WebContentsView ever built -- prewarm plus two
    // shows, never rebuilt.
    expect(vi.mocked(WebContentsView)).toHaveBeenCalledTimes(1)
  })

  it('repaints the warm view on a live OS/app theme change, even while hidden', async () => {
    createPopoverView(fakeWin() as never, fakeContentView() as never, {
      dirname: '/app', entryPath: '/menu/', fallbackHtml: '../renderer/menu/index.html',
      preloadRelPath: '../preload/menu.js', urlArgName: 'orivon-menu-url', align: 'right',
      background: BACKGROUND, warm: true, registerIpc: () => () => {}
    })
    await new Promise((resolve) => { setImmediate(resolve) })
    calls.length = 0

    nativeThemeState.shouldUseDarkColors = true
    fireThemeUpdated()

    expect(calls).toEqual(['setBackgroundColor:#2b2c31'])
  })

  it('destroys the warm view when the window closes', async () => {
    const win = fakeWin()
    createPopoverView(win as never, fakeContentView() as never, {
      dirname: '/app', entryPath: '/menu/', fallbackHtml: '../renderer/menu/index.html',
      preloadRelPath: '../preload/menu.js', urlArgName: 'orivon-menu-url', align: 'right',
      background: BACKGROUND, warm: true, registerIpc: () => () => {}
    })
    await new Promise((resolve) => { setImmediate(resolve) })

    const closedHandler = win.on.mock.calls.find(([event]) => event === 'closed')?.[1] as (() => void) | undefined
    expect(closedHandler).toBeDefined()
    closedHandler?.()

    expect(calls).toContain('close:1')
  })
})
