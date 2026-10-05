import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// Drives the REAL PopupView (UPSTREAM.md patches 34, 35 and 68) with a fake view and a fake host,
// so focus, size and window-event timing are set directly, without a display. The e2e equivalent
// (test/extensions/e2e-extensions-popup-lifecycle.test.ts) measured that a synthetic move or
// resize of a window does not reliably produce a native event under a virtual display, so these
// events are emitted here instead.
//
// PopupView reads process.versions.electron, which plain vitest never sets: stubbed once so the
// constructor takes the preferred-size path it takes under the Electron this app ships.
;(process.versions as unknown as { electron: string }).electron = '44.0.0'

class FakeWebContents extends EventEmitter {
  private destroyed = false
  focused = false
  closed = 0
  devTools = false
  isDestroyed (): boolean { return this.destroyed }
  isDevToolsOpened (): boolean { return this.devTools }
  closeDevTools (): void { this.devTools = false }
  isFocused (): boolean { return this.focused }
  focus (): void { this.focused = true }
  close (): void { this.closed += 1; this.destroyed = true; this.emit('destroyed') }
  async loadURL (_url: string): Promise<void> {}
  measured: { width: number, height: number } = { width: 0, height: 0 }
  async executeJavaScript (): Promise<{ width: number, height: number }> { return this.measured }
}

class FakeView {
  static instances: FakeView[] = []
  readonly webContents = new FakeWebContents()
  readonly constructorOpts: { webPreferences?: { disableDialogs?: boolean } }
  background = ''
  radius = 0
  bounds = { x: 0, y: 0, width: 0, height: 0 }
  constructor (opts: { webPreferences?: { disableDialogs?: boolean } }) {
    this.constructorOpts = opts
    FakeView.instances.push(this)
  }

  setBackgroundColor (color: string): void { this.background = color }
  setBorderRadius (radius: number): void { this.radius = radius }
  getBounds (): typeof this.bounds { return this.bounds }
  setBounds (bounds: Partial<typeof this.bounds>): void { this.bounds = { ...this.bounds, ...bounds } }
}

let baseWindows: EventEmitter[] = []
const nativeThemeStub = { shouldUseDarkColors: false }

vi.mock('electron', () => ({
  WebContentsView: FakeView,
  BaseWindow: { getAllWindows: () => baseWindows },
  BrowserWindow: { getAllWindows: () => [] },
  nativeTheme: nativeThemeStub
}))

const { PopupView, setPopupHost, popupParentOf } = await import('../../../../vendor/electron-chrome-extensions/src/browser/popup.js')

interface FakeParent extends EventEmitter {
  isDestroyed: () => boolean
  contentView: { children: unknown[] }
}

function fakeParent (): FakeParent {
  const parent = new EventEmitter() as FakeParent
  parent.isDestroyed = () => false
  parent.contentView = { children: [] }
  return parent
}

const host = { mount: vi.fn(), unmount: vi.fn(), place: vi.fn() }

function makePopup (parent: FakeParent): InstanceType<typeof PopupView> {
  return new PopupView({
    extensionId: 'a'.repeat(32),
    session: {} as never,
    parent: parent as never,
    url: 'chrome-extension://aaaa/popup.html',
    anchorRect: { x: 0, y: 0, width: 10, height: 10 }
  })
}

const pageOf = (popup: InstanceType<typeof PopupView>): FakeWebContents => popup.webContents as unknown as FakeWebContents
const macrotask = async (): Promise<void> => await new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
  FakeView.instances = []
  baseWindows = []
  nativeThemeStub.shouldUseDarkColors = false
  host.mount.mockReset()
  host.unmount.mockReset()
  host.place.mockReset()
  setPopupHost(host)
})

describe('PopupView: a view in the window, mounted by the host', () => {
  it('is built with dialogs disabled, so alert, confirm and prompt never open a native box (UPSTREAM.md patch 62)', () => {
    makePopup(fakeParent())
    expect(FakeView.instances[0]?.constructorOpts.webPreferences?.disableDialogs).toBe(true)
  })

  it('mounts once the page has loaded, at its smallest size, placed before it is mounted, and gives it the keyboard', async () => {
    const parent = fakeParent()
    const order: string[] = []
    host.place.mockImplementation(() => { order.push('place') })
    host.mount.mockImplementation(() => { order.push('mount') })
    const popup = makePopup(parent)
    expect(host.mount).not.toHaveBeenCalled()
    await popup.whenReady()
    expect(host.mount).toHaveBeenCalledTimes(1)
    expect(host.mount).toHaveBeenCalledWith(parent, popup.view)
    expect(order).toEqual(['place', 'mount'])
    expect(host.place).toHaveBeenCalledWith(parent, popup.view, expect.objectContaining({ size: { width: 25, height: 25 } }))
    expect(pageOf(popup).focused).toBe(true)
  })

  it('does not mount again when the page reports its size', async () => {
    const popup = makePopup(fakeParent())
    await popup.whenReady()
    pageOf(popup).emit('preferred-size-changed', {}, { width: 111, height: 222 })
    pageOf(popup).emit('preferred-size-changed', {}, { width: 130, height: 240 })
    expect(host.mount).toHaveBeenCalledTimes(1)
  })

  it('places again at every new size, keeping the anchor it opened from', async () => {
    const popup = makePopup(fakeParent())
    await popup.whenReady()
    pageOf(popup).emit('preferred-size-changed', {}, { width: 111, height: 222 })
    pageOf(popup).emit('preferred-size-changed', {}, { width: 300, height: 400 })
    expect(host.place).toHaveBeenLastCalledWith(expect.anything(), popup.view, {
      anchorRect: { x: 0, y: 0, width: 10, height: 10 }, alignment: undefined, size: { width: 300, height: 400 }
    })
  })

  it('records the window its page hangs under, for chrome.tabs', () => {
    const parent = fakeParent()
    const popup = makePopup(parent)
    expect(popupParentOf(popup.webContents)).toBe(parent)
  })

  it('paints the theme\'s colour and has rounded corners before its page has a pixel (UPSTREAM.md patch 35)', () => {
    nativeThemeStub.shouldUseDarkColors = true
    makePopup(fakeParent())
    expect(FakeView.instances[0]?.background).toBe('#202124')
    expect(FakeView.instances[0]?.radius).toBeGreaterThan(0)
    nativeThemeStub.shouldUseDarkColors = false
    makePopup(fakeParent())
    expect(FakeView.instances[1]?.background).toBe('#ffffff')
  })
})

describe('PopupView: never stays at its smallest size (UPSTREAM.md patches 35 and 68)', () => {
  it('measures its page when preferred-size-changed never arrives in time', async () => {
    vi.useFakeTimers()
    try {
      const popup = makePopup(fakeParent())
      pageOf(popup).measured = { width: 210, height: 130 }
      await popup.whenReady()

      await vi.advanceTimersByTimeAsync(600)

      expect(host.mount).toHaveBeenCalledTimes(1)
      expect(host.place).toHaveBeenLastCalledWith(expect.anything(), popup.view, expect.objectContaining({ size: { width: 210, height: 130 } }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes a default size when the page cannot be measured', async () => {
    vi.useFakeTimers()
    try {
      const popup = makePopup(fakeParent())
      await popup.whenReady()

      await vi.advanceTimersByTimeAsync(600)

      expect(host.place).toHaveBeenLastCalledWith(expect.anything(), popup.view, expect.objectContaining({ size: { width: 320, height: 400 } }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not resize once preferred-size-changed already did', async () => {
    vi.useFakeTimers()
    try {
      const popup = makePopup(fakeParent())
      pageOf(popup).measured = { width: 210, height: 130 }
      await popup.whenReady()
      pageOf(popup).emit('preferred-size-changed', {}, { width: 111, height: 222 })

      await vi.advanceTimersByTimeAsync(600)

      expect(host.mount).toHaveBeenCalledTimes(1)
      expect(host.place).toHaveBeenLastCalledWith(expect.anything(), popup.view, expect.objectContaining({ size: { width: 111, height: 222 } }))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('PopupView: sizes it measures (UPSTREAM.md patch 68)', () => {
  it('measures again while no preferred size has arrived, so a page that renders late is not left at its loading size', async () => {
    vi.useFakeTimers()
    try {
      const popup = makePopup(fakeParent())
      pageOf(popup).measured = { width: 210, height: 130 }
      await popup.whenReady()
      await vi.advanceTimersByTimeAsync(600)
      pageOf(popup).measured = { width: 320, height: 480 }
      await vi.advanceTimersByTimeAsync(1200)
      expect(host.place).toHaveBeenLastCalledWith(expect.anything(), popup.view, expect.objectContaining({ size: { width: 320, height: 480 } }))
      expect(host.mount).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the size its page reported before the load ended', async () => {
    vi.spyOn(FakeWebContents.prototype, 'loadURL').mockImplementationOnce(async function (this: FakeWebContents) {
      this.emit('preferred-size-changed', {}, { width: 111, height: 222 })
    })
    const popup = makePopup(fakeParent())
    await popup.whenReady()
    expect(popup.view.getBounds()).toMatchObject({ width: 111, height: 222 })
  })
})

describe('PopupView: its window closing under it (UPSTREAM.md patch 68)', () => {
  it('touches neither the host nor the view for a size or a load that finishes after the window is gone', async () => {
    const parent = fakeParent()
    const popup = makePopup(parent)
    parent.isDestroyed = () => true
    parent.emit('closed')
    host.place.mockClear()
    host.mount.mockClear()
    pageOf(popup).emit('preferred-size-changed', {}, { width: 111, height: 222 })
    await popup.whenReady()
    expect(host.place).not.toHaveBeenCalled()
    expect(host.mount).not.toHaveBeenCalled()
    await macrotask()
    expect(popup.isDestroyed()).toBe(true)
  })
})

describe('PopupView: closing (UPSTREAM.md patches 34 and 68)', () => {
  async function open (): Promise<{ parent: FakeParent, popup: InstanceType<typeof PopupView> }> {
    const parent = fakeParent()
    const popup = makePopup(parent)
    await popup.whenReady()
    pageOf(popup).emit('preferred-size-changed', {}, { width: 111, height: 222 })
    return { parent, popup }
  }

  it.each(['move', 'resize', 'minimize', 'closed'])('closes a macrotask after the parent window emits %s', async (name) => {
    const { parent, popup } = await open()
    parent.emit(name)
    expect(popup.isDestroyed()).toBe(false)
    await macrotask()
    expect(popup.isDestroyed()).toBe(true)
  })

  it('closes a macrotask after Escape, not on another key', async () => {
    const { popup } = await open()
    pageOf(popup).emit('before-input-event', {}, { type: 'keyDown', key: 'a' })
    await macrotask()
    expect(popup.isDestroyed()).toBe(false)
    pageOf(popup).emit('before-input-event', {}, { type: 'keyDown', key: 'Escape' })
    await macrotask()
    expect(popup.isDestroyed()).toBe(true)
  })

  it('closes a macrotask after its page blurs while an app window is focused', async () => {
    const { popup } = await open()
    const shell = Object.assign(new EventEmitter(), { isFocused: () => true })
    baseWindows = [shell]
    pageOf(popup).emit('blur')
    expect(popup.isDestroyed()).toBe(false)
    await macrotask()
    expect(popup.isDestroyed()).toBe(true)
  })

  it('stays open when the page blurs while the host says it is moving focus for the popup\'s own extension', async () => {
    const { popup } = await open()
    const shell = Object.assign(new EventEmitter(), { isFocused: () => true })
    baseWindows = [shell]
    let keep = true
    const keepOpenOnBlur = vi.fn(() => keep)
    setPopupHost({ ...host, keepOpenOnBlur })
    const other = makePopup(fakeParent())
    await other.whenReady()
    pageOf(other).emit('blur')
    await macrotask()
    expect(other.isDestroyed()).toBe(false)
    expect(keepOpenOnBlur).toHaveBeenCalledWith({ extensionId: 'a'.repeat(32), parent: other.parent })
    keep = false
    pageOf(other).emit('blur')
    await macrotask()
    expect(other.isDestroyed()).toBe(true)
    expect(popup.isDestroyed()).toBe(false)
  })

  describe('after a blur the host kept it open for', () => {
    const shell = Object.assign(new EventEmitter(), { isFocused: () => true })
    let keep = true

    async function keptOpen (): Promise<InstanceType<typeof PopupView>> {
      baseWindows = [shell]
      keep = true
      setPopupHost({ ...host, keepOpenOnBlur: () => keep, focusHandoverMs: 20 })
      const popup = makePopup(fakeParent())
      await popup.whenReady()
      pageOf(popup).focused = false
      pageOf(popup).emit('blur')
      await macrotask()
      expect(popup.isDestroyed()).toBe(false)
      return popup
    }
    const later = async (ms: number): Promise<void> => await new Promise((resolve) => setTimeout(resolve, ms))

    it('takes the keyboard back once the hand-over is over, so the next click elsewhere closes it', async () => {
      const popup = await keptOpen()
      expect(pageOf(popup).focused).toBe(false)
      await later(60)
      expect(pageOf(popup).focused).toBe(true)
      keep = false
      pageOf(popup).emit('blur')
      await macrotask()
      expect(popup.isDestroyed()).toBe(true)
    })

    it('leaves the keyboard alone when the app is no longer the focused one, and closes on the next focus inside it', async () => {
      const popup = await keptOpen()
      baseWindows = [Object.assign(shell, { isFocused: () => false })]
      await later(60)
      expect(pageOf(popup).focused).toBe(false)
      shell.emit('focus')
      await macrotask()
      expect(popup.isDestroyed()).toBe(true)
      Object.assign(shell, { isFocused: () => true })
    })

    it('does nothing once the popup has closed', async () => {
      const popup = await keptOpen()
      popup.destroy()
      await later(60)
      expect(pageOf(popup).focused).toBe(false)
    })
  })

  it('closes when its page goes away', async () => {
    const { popup } = await open()
    pageOf(popup).emit('destroyed')
    await macrotask()
    expect(popup.isDestroyed()).toBe(true)
  })

  it('unmounts once and closes the page, however many triggers fire', async () => {
    const { parent, popup } = await open()
    parent.emit('resize')
    pageOf(popup).emit('before-input-event', {}, { type: 'keyDown', key: 'Escape' })
    popup.destroy()
    await macrotask()
    expect(host.unmount).toHaveBeenCalledTimes(1)
    expect(host.unmount).toHaveBeenCalledWith(parent, popup.view)
    expect(pageOf(popup).closed).toBe(1)
  })

  it('unmounts nothing if it closed before it was mounted, and still closes the page', async () => {
    const popup = makePopup(fakeParent())
    popup.destroy()
    await popup.whenReady()
    expect(host.unmount).not.toHaveBeenCalled()
    expect(pageOf(popup).closed).toBe(1)
  })

  it('closes DevTools first, and survives a host that cannot unmount', async () => {
    const { popup } = await open()
    pageOf(popup).devTools = true
    host.unmount.mockImplementation(() => { throw new Error('window gone') })
    expect(() => { popup.destroy() }).not.toThrow()
    expect(pageOf(popup).devTools).toBe(false)
  })

  it('keeps open while DevTools is open', async () => {
    const { popup } = await open()
    pageOf(popup).devTools = true
    pageOf(popup).emit('blur')
    await macrotask()
    expect(popup.isDestroyed()).toBe(false)
  })

  it('stops listening on the parent once destroyed, leaking nothing for the next popup', async () => {
    const { parent, popup } = await open()
    popup.destroy()
    for (const name of ['move', 'resize', 'minimize', 'closed']) expect(parent.listenerCount(name)).toBe(0)
  })
})

describe('PopupView: after a blur that may have left the app (UPSTREAM.md patch 34)', () => {
  /** The shell's own window, alive and not focused: neither it nor the popup reports focus, as in a
   * focus hand-over that is not atomic, or a trip to a password manager outside the app. */
  function fakeShell (): EventEmitter & { isFocused: () => boolean } {
    return Object.assign(new EventEmitter(), { isFocused: () => false })
  }

  async function blurred (): Promise<{ popup: InstanceType<typeof PopupView>, shell: ReturnType<typeof fakeShell>, tab: EventEmitter }> {
    const parent = fakeParent()
    const tab = new EventEmitter()
    parent.contentView.children = [{ webContents: tab, children: [] }]
    const shell = fakeShell()
    baseWindows = [shell]
    const popup = makePopup(parent)
    await popup.whenReady()
    pageOf(popup).emit('preferred-size-changed', {}, { width: 111, height: 222 })
    pageOf(popup).focused = false
    pageOf(popup).emit('blur')
    await macrotask()
    expect(popup.isDestroyed()).toBe(false)
    return { popup, shell, tab }
  }

  it('closes when focus lands elsewhere in the app a macrotask later', async () => {
    const { popup, shell } = await blurred()
    shell.emit('focus')
    await macrotask()
    expect(popup.isDestroyed()).toBe(true)
  })

  it('closes when focus reaches a tab of the parent that the window itself never re-announced', async () => {
    const { popup, tab } = await blurred()
    tab.emit('focus')
    await macrotask()
    expect(popup.isDestroyed()).toBe(true)
  })

  it('stays open when focus came back to the popup\'s own page: the person returned to it', async () => {
    const { popup, shell } = await blurred()
    shell.emit('focus')
    pageOf(popup).focused = true
    await macrotask()
    expect(popup.isDestroyed()).toBe(false)
  })

  it('never throws when a focus arrives after the popup already closed', async () => {
    const { popup, shell } = await blurred()
    shell.emit('focus')
    await macrotask()
    expect(popup.isDestroyed()).toBe(true)
    expect(() => { shell.emit('focus') }).not.toThrow()
  })
})
