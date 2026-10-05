import { beforeEach, describe, expect, it, vi } from 'vitest'

// The popup is a view Orivon puts in the window: the host mounts it above the other views, lifts it again when
// the window restacks, and hands the keyboard back to the tab only when the popup held it.
const attachShown = vi.fn()
vi.mock('../../shell/attach-view.js', () => ({ attachShown: (...args: unknown[]) => attachShown(...args) }))

const { createExtensionPopupHost } = await import('../extension-popup-host.js')

function fakeView (focused = false): { webContents: { isDestroyed: () => boolean, isFocused: () => boolean }, setBounds: ReturnType<typeof vi.fn>, focused: boolean, destroyed: boolean, gone: boolean } {
  const view = { focused, destroyed: false, gone: false, webContents: { isDestroyed: () => view.destroyed, isFocused: () => view.focused }, setBounds: vi.fn() }
  return view
}

function fakeWindow (): { contentView: { addChildView: ReturnType<typeof vi.fn>, removeChildView: ReturnType<typeof vi.fn> }, getContentBounds: () => { x: number, y: number, width: number, height: number } } {
  return {
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 })
  }
}

const focusTab = vi.fn()

beforeEach(() => {
  attachShown.mockReset()
  focusTab.mockReset()
})

describe('mount and unmount', () => {
  it('attaches the view to the window\'s content view and reports it open', () => {
    const { host, panelFor } = createExtensionPopupHost({ focusTab })
    const win = fakeWindow()
    const view = fakeView()
    host.mount(win as never, view as never)
    expect(attachShown).toHaveBeenCalledWith(win.contentView, view)
    expect(panelFor(win as never).isOpen()).toBe(true)
  })

  it('removes the view and reports it closed', () => {
    const { host, panelFor } = createExtensionPopupHost({ focusTab })
    const win = fakeWindow()
    const view = fakeView()
    host.mount(win as never, view as never)
    host.unmount(win as never, view as never)
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(panelFor(win as never).isOpen()).toBe(false)
  })

  it('focuses the tab when the popup held the keyboard as it left', () => {
    const { host } = createExtensionPopupHost({ focusTab })
    const win = fakeWindow()
    const view = fakeView(true)
    host.mount(win as never, view as never)
    host.unmount(win as never, view as never)
    expect(focusTab).toHaveBeenCalledWith(win)
  })

  it('leaves the keyboard alone when the popup did not hold it', () => {
    const { host } = createExtensionPopupHost({ focusTab })
    const win = fakeWindow()
    const view = fakeView(false)
    host.mount(win as never, view as never)
    host.unmount(win as never, view as never)
    expect(focusTab).not.toHaveBeenCalled()
  })

  it('reads the keyboard before the view leaves the window', () => {
    const { host } = createExtensionPopupHost({ focusTab })
    const win = fakeWindow()
    const view = fakeView(true)
    win.contentView.removeChildView.mockImplementation(() => { view.focused = false })
    host.mount(win as never, view as never)
    host.unmount(win as never, view as never)
    expect(focusTab).toHaveBeenCalledTimes(1)
  })

  it('unmounts a view whose page already closed itself and left it with no webContents', () => {
    const { host, panelFor } = createExtensionPopupHost({ focusTab })
    const win = fakeWindow()
    const view = fakeView(true)
    host.mount(win as never, view as never)
    Object.defineProperty(view, 'webContents', { value: undefined })
    expect(() => { host.unmount(win as never, view as never) }).not.toThrow()
    expect(win.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(panelFor(win as never).isOpen()).toBe(false)
    expect(focusTab).not.toHaveBeenCalled()
  })

  it('still reports closed when taking the view out throws', () => {
    const { host, panelFor } = createExtensionPopupHost({ focusTab })
    const win = fakeWindow()
    const view = fakeView()
    win.contentView.removeChildView.mockImplementation(() => { throw new Error('gone') })
    host.mount(win as never, view as never)
    expect(() => { host.unmount(win as never, view as never) }).not.toThrow()
    expect(panelFor(win as never).isOpen()).toBe(false)
  })
})

describe('place', () => {
  it('sets the view\'s bounds from the anchor, in the window\'s content', () => {
    const { host } = createExtensionPopupHost({ focusTab })
    const win = fakeWindow()
    const view = fakeView()
    host.place(win as never, view as never, { anchorRect: { x: 900, y: 40, width: 30, height: 30 }, size: { width: 300, height: 200 } })
    expect(view.setBounds).toHaveBeenCalledWith({ x: 630, y: 75, width: 300, height: 200 })
  })
})

describe('the panel the overlay host adopts', () => {
  it('never closes the popup: a tab the popup\'s own extension opens must not close it', () => {
    const { host, panelFor } = createExtensionPopupHost({ focusTab })
    const win = fakeWindow()
    const view = fakeView()
    host.mount(win as never, view as never)
    panelFor(win as never).close()
    expect(win.contentView.removeChildView).not.toHaveBeenCalled()
    expect(panelFor(win as never).isOpen()).toBe(true)
  })

  it('restacks an open popup above whatever was attached since', () => {
    const { host, panelFor } = createExtensionPopupHost({ focusTab })
    const win = fakeWindow()
    const view = fakeView()
    host.mount(win as never, view as never)
    attachShown.mockClear()
    panelFor(win as never).restack()
    expect(attachShown).toHaveBeenCalledWith(win.contentView, view)
  })

  it('restacks nothing, and forgets the popup, once its page left it with no webContents', () => {
    const { host, panelFor } = createExtensionPopupHost({ focusTab })
    const win = fakeWindow()
    const view = fakeView()
    host.mount(win as never, view as never)
    Object.defineProperty(view, 'webContents', { value: undefined })
    attachShown.mockClear()
    expect(() => { panelFor(win as never).restack() }).not.toThrow()
    expect(attachShown).not.toHaveBeenCalled()
    expect(panelFor(win as never).isOpen()).toBe(false)
  })

  it('restacks nothing, and forgets the popup, once its page is destroyed', () => {
    const { host, panelFor } = createExtensionPopupHost({ focusTab })
    const win = fakeWindow()
    const view = fakeView()
    host.mount(win as never, view as never)
    view.destroyed = true
    attachShown.mockClear()
    panelFor(win as never).restack()
    expect(attachShown).not.toHaveBeenCalled()
    expect(panelFor(win as never).isOpen()).toBe(false)
  })

  it('restacks nothing when no popup is open', () => {
    const { panelFor } = createExtensionPopupHost({ focusTab })
    panelFor(fakeWindow() as never).restack()
    expect(attachShown).not.toHaveBeenCalled()
  })

  it('restacks nothing once the popup is gone', () => {
    const { host, panelFor } = createExtensionPopupHost({ focusTab })
    const win = fakeWindow()
    const view = fakeView()
    host.mount(win as never, view as never)
    host.unmount(win as never, view as never)
    attachShown.mockClear()
    panelFor(win as never).restack()
    expect(attachShown).not.toHaveBeenCalled()
  })
})

describe('keepOpenOnBlur', () => {
  const popup = { extensionId: 'ext', parent: {} as never }

  it('is passed through to the library when given, with the popup it asks about, and absent when not', () => {
    expect(createExtensionPopupHost({ focusTab }).host.keepOpenOnBlur).toBeUndefined()
    const keep = vi.fn(() => true)
    expect(createExtensionPopupHost({ focusTab, keepOpenOnBlur: keep }).host.keepOpenOnBlur?.(popup)).toBe(true)
    expect(keep).toHaveBeenCalledWith(popup)
  })

  it('names the hand-over the library waits out before the popup takes the keyboard back', () => {
    expect(createExtensionPopupHost({ focusTab }).host.focusHandoverMs).toBeUndefined()
    expect(createExtensionPopupHost({ focusTab, focusHandoverMs: 500 }).host.focusHandoverMs).toBe(500)
  })
})
