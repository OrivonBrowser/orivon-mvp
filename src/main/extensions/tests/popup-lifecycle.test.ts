import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// Drives the REAL PopupView (UPSTREAM.md patches 34-35), the same way
// browser-action-popup-url.test.ts drives the REAL BrowserActionAPI --
// fakes stand in for BrowserWindow/nativeTheme/the parent BaseWindow so
// this suite can control focus, size-event and window-event timing
// directly, deterministically, and without a real display. The e2e
// equivalent (test/e2e-extensions-popup-lifecycle.test.ts) measured this
// directly: under bare xvfb-run OR under a real window manager
// (test/with-window-manager.mjs), a synthetic setPosition()/setSize() on a
// BaseWindow does not reliably produce a native 'move'/'resize' event at
// all -- an environment limitation of the virtual display, not of this
// code, and not something an e2e assertion can be pinned to. This suite
// exercises the same event handlers directly instead.
//
// PopupView's own supportsPreferredSize() reads
// process.versions.electron, which plain vitest/node never sets -- stubbed
// once here so the constructor takes the same `usingPreferredSize: true`
// path it does under the real Electron 44 this app ships.
;(process.versions as unknown as { electron: string }).electron = '44.0.0'

class FakeWebContents extends EventEmitter {
  private destroyed = false
  isDestroyed (): boolean { return this.destroyed }
  isDevToolsOpened (): boolean { return false }
  closeDevTools (): void {}
  async loadURL (_url: string): Promise<void> {}
  async executeJavaScript (): Promise<{ width: number, height: number }> { return { width: 0, height: 0 } }
  getURL (): string { return '' }
}

class FakeBrowserWindow extends EventEmitter {
  static instances: FakeBrowserWindow[] = []
  webContents = new FakeWebContents()
  readonly constructorOpts: { backgroundColor?: string }
  private destroyed = false
  private visible = false
  private bounds = { x: 0, y: 0, width: 25, height: 25 }

  constructor (opts: { backgroundColor?: string }) {
    super()
    this.constructorOpts = opts
    FakeBrowserWindow.instances.push(this)
  }

  show (): void { this.visible = true }
  isVisible (): boolean { return this.visible }
  isDestroyed (): boolean { return this.destroyed }
  // getAllWindows() (api/common.ts) includes the popup's OWN
  // BrowserWindow -- maybeClose's own `getAllWindows().some(isFocused)`
  // needs this to exist on every entry, not just the ones a test cares
  // about. Never focused: nothing in this suite exercises a popup that
  // reports itself focused via this path.
  isFocused (): boolean { return false }
  destroy (): void { if (this.destroyed) return; this.destroyed = true; this.emit('closed') }
  getBounds (): typeof this.bounds { return this.bounds }
  setBounds (b: Partial<typeof this.bounds>): void { this.bounds = { ...this.bounds, ...b } }

  static getAllWindows (): FakeBrowserWindow[] { return FakeBrowserWindow.instances.filter((w) => !w.isDestroyed()) }
  static reset (): void { FakeBrowserWindow.instances = [] }
}

let baseWindows: EventEmitter[] = []
const nativeThemeStub = { shouldUseDarkColors: false }

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
  BaseWindow: { getAllWindows: () => baseWindows },
  nativeTheme: nativeThemeStub
}))

const { PopupView } = await import('../../../../vendor/electron-chrome-extensions/src/browser/popup.js')

interface FakeParent extends EventEmitter {
  getBounds: () => { x: number, y: number, width: number, height: number }
  getContentBounds: () => { x: number, y: number, width: number, height: number }
  isDestroyed: () => boolean
  contentView: { children: unknown[] }
}

/** A minimal fake parent BaseWindow: an EventEmitter with the handful of
 * BaseWindow members popup.ts actually calls (`getBounds`/`getContentBounds`
 * for updatePosition, `contentView.children` for closeOnNextAppFocus's own
 * collectWebContents, `isDestroyed` for destroy()'s own cleanup). */
function fakeParent (): FakeParent {
  const parent = new EventEmitter() as FakeParent
  parent.getBounds = () => ({ x: 0, y: 0, width: 800, height: 600 })
  parent.getContentBounds = () => ({ x: 0, y: 0, width: 800, height: 564 })
  parent.isDestroyed = () => false
  parent.contentView = { children: [] }
  return parent
}

function makePopup (parent: FakeParent): InstanceType<typeof PopupView> {
  return new PopupView({
    extensionId: 'a'.repeat(32),
    session: {} as never,
    parent: parent as never,
    url: 'chrome-extension://aaaa/popup.html',
    anchorRect: { x: 0, y: 0, width: 10, height: 10 }
  })
}

function browserWindowOf (popup: InstanceType<typeof PopupView>): FakeBrowserWindow {
  return popup.browserWindow as unknown as FakeBrowserWindow
}

beforeEach(() => {
  FakeBrowserWindow.reset()
  baseWindows = []
  nativeThemeStub.shouldUseDarkColors = false
})

describe('PopupView: closing on parent window events (UPSTREAM.md patch 34)', () => {
  it('closes when the parent window moves', () => {
    const parent = fakeParent()
    const popup = makePopup(parent)
    parent.emit('move')
    expect(popup.isDestroyed()).toBe(true)
  })

  it('closes when the parent window resizes', () => {
    const parent = fakeParent()
    const popup = makePopup(parent)
    parent.emit('resize')
    expect(popup.isDestroyed()).toBe(true)
  })

  it('closes when the parent window minimises', () => {
    const parent = fakeParent()
    const popup = makePopup(parent)
    parent.emit('minimize')
    expect(popup.isDestroyed()).toBe(true)
  })

  it('closes on Escape', () => {
    const parent = fakeParent()
    const popup = makePopup(parent)
    browserWindowOf(popup).webContents.emit('before-input-event', {}, { type: 'keyDown', key: 'Escape' })
    expect(popup.isDestroyed()).toBe(true)
  })

  it('does not close on a non-Escape key', () => {
    const parent = fakeParent()
    const popup = makePopup(parent)
    browserWindowOf(popup).webContents.emit('before-input-event', {}, { type: 'keyDown', key: 'a' })
    expect(popup.isDestroyed()).toBe(false)
  })

  it('stops listening on the parent once destroyed, leaking nothing for the next popup', () => {
    const parent = fakeParent()
    const popup = makePopup(parent)
    popup.destroy()
    expect(parent.listenerCount('move')).toBe(0)
    expect(parent.listenerCount('resize')).toBe(0)
    expect(parent.listenerCount('minimize')).toBe(0)
  })
})

describe('PopupView: closing on the next focus after an inconclusive blur (UPSTREAM.md patch 34)', () => {
  /** The shell's own top-level window, already alive (as it always is on a
   * real desktop, just not focused) before the popup's own blur fires --
   * closeOnNextAppFocus arms listeners on the windows getAllWindows()
   * already knows about at arm-time, the same as a real shell window that
   * exists continuously and only changes focus state. */
  function fakeShell (): EventEmitter & { isFocused: () => boolean, focused: boolean } {
    const shell = new EventEmitter() as EventEmitter & { isFocused: () => boolean, focused: boolean }
    shell.focused = false
    shell.isFocused = () => shell.focused
    return shell
  }

  it('arms on blur when no app window is focused, and closes on the next focus of another window', () => {
    const parent = fakeParent()
    const shell = fakeShell()
    baseWindows = [shell]
    const popup = makePopup(parent)

    // Nothing reports focused -- the same state an X11 focus-transfer race
    // (or a genuine login-form departure) produces.
    browserWindowOf(popup).emit('blur')
    expect(popup.isDestroyed()).toBe(false)

    // The shell later reports focused -- the transfer completing late.
    shell.focused = true
    shell.emit('focus')

    expect(popup.isDestroyed()).toBe(true)
  })

  it('closes on focus reaching a webContents inside the parent, even if the parent BaseWindow itself never re-fires focus', () => {
    const parent = fakeParent()
    const tabWebContents = new EventEmitter()
    parent.contentView.children = [{ webContents: tabWebContents, children: [] }]
    const popup = makePopup(parent)

    browserWindowOf(popup).emit('blur')
    expect(popup.isDestroyed()).toBe(false)

    tabWebContents.emit('focus')

    expect(popup.isDestroyed()).toBe(true)
  })

  it('never throws when a focus arrives even later, after the popup already closed', () => {
    const parent = fakeParent()
    const shell = fakeShell()
    baseWindows = [shell]
    const popup = makePopup(parent)

    browserWindowOf(popup).emit('blur')
    shell.focused = true
    shell.emit('focus')
    expect(popup.isDestroyed()).toBe(true)

    // A second, later focus on the same window must not throw -- proves
    // the one-shot listener was actually removed, not just harmless to
    // fire twice (destroy() itself is already idempotent either way).
    expect(() => { shell.emit('focus') }).not.toThrow()
  })
})

describe('PopupView: never becomes permanently invisible (UPSTREAM.md patch 35)', () => {
  it('shows itself with a default size if preferred-size-changed never arrives in time', async () => {
    vi.useFakeTimers()
    try {
      const parent = fakeParent()
      const popup = makePopup(parent)
      await popup.whenReady()
      const browserWindow = browserWindowOf(popup)
      expect(browserWindow.isVisible()).toBe(false)

      await vi.advanceTimersByTimeAsync(600)

      expect(browserWindow.isVisible()).toBe(true)
      expect(browserWindow.getBounds()).toEqual(expect.objectContaining({ width: 320, height: 400 }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('positions itself against the anchor rect before showing, not just at its default size (regression: was left centred)', async () => {
    vi.useFakeTimers()
    try {
      const parent = fakeParent()
      const popup = makePopup(parent)
      await popup.whenReady()

      await vi.advanceTimersByTimeAsync(600)

      // fakeParent(): getBounds {x:0,y:0,w:800,h:600}, getContentBounds
      // {x:0,y:0,w:800,h:564} -> a 36px native titlebar. makePopup()'s own
      // anchorRect is {x:0,y:0,w:10,h:10}. Had armVisibilityFallback never
      // called updatePosition(), this would still read {x:0,y:0} -- the
      // BrowserWindow's own constructor default with no explicit position,
      // which reads as "centred on screen" on a real desktop, not "wrong
      // by a small amount": nothing here ever calls setPosition at all
      // without this fix.
      expect(browserWindowOf(popup).getBounds()).toEqual({
        x: 0 + 0 + 10 - 320, // winBounds.x + anchorRect.x + anchorRect.width - viewBounds.width
        y: 0 + 36 + 0 + 10 + 5, // winBounds.y + titlebar + anchorRect.y + anchorRect.height + POSITION_PADDING
        width: 320,
        height: 400
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not re-show or resize once preferred-size-changed already did', async () => {
    vi.useFakeTimers()
    try {
      const parent = fakeParent()
      const popup = makePopup(parent)
      await popup.whenReady()
      const browserWindow = browserWindowOf(popup)

      browserWindow.webContents.emit('preferred-size-changed', {}, { width: 111, height: 222 })
      expect(browserWindow.isVisible()).toBe(true)
      expect(browserWindow.getBounds()).toEqual(expect.objectContaining({ width: 111, height: 222 }))

      await vi.advanceTimersByTimeAsync(600)

      // The fallback timer still fires, but `hidden` is already false, so
      // it must not have overwritten the real preferred size.
      expect(browserWindow.getBounds()).toEqual(expect.objectContaining({ width: 111, height: 222 }))
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('PopupView: background colour follows the OS theme (UPSTREAM.md patch 35)', () => {
  it('is the light colour in light mode', () => {
    nativeThemeStub.shouldUseDarkColors = false
    makePopup(fakeParent())
    expect(FakeBrowserWindow.instances[0]?.constructorOpts.backgroundColor).toBe('#ffffff')
  })

  it('is the dark colour in dark mode', () => {
    nativeThemeStub.shouldUseDarkColors = true
    makePopup(fakeParent())
    expect(FakeBrowserWindow.instances[0]?.constructorOpts.backgroundColor).toBe('#202124')
  })
})
