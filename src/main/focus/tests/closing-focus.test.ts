import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { handOffFocusOnClose } from '../closing-focus.js'
import { wireClosingFocus } from '../install-focus.js'

class FakeContents extends EventEmitter {
  focused = false
  destroyed = false
  readonly focus = vi.fn(() => { this.focused = true })
  isFocused (): boolean { return this.focused }
  isDestroyed (): boolean { return this.destroyed }
}

describe('handOffFocusOnClose', () => {
  it('gives the keyboard to the chrome when the contents close holding it', () => {
    const popover = new FakeContents()
    const chrome = new FakeContents()
    handOffFocusOnClose(popover, () => chrome)
    popover.focused = true
    popover.emit('close')
    expect(chrome.focus).toHaveBeenCalledTimes(1)
  })

  it('leaves the keyboard alone when the closing contents do not hold it, or are the chrome itself', () => {
    const popover = new FakeContents()
    const chrome = new FakeContents()
    handOffFocusOnClose(popover, () => chrome)
    popover.emit('close')
    handOffFocusOnClose(chrome, () => chrome)
    chrome.focused = true
    chrome.emit('close')
    expect(chrome.focus).not.toHaveBeenCalled()
  })

  it('does nothing for contents in no window, or whose chrome is gone', () => {
    const popover = new FakeContents()
    const gone = new FakeContents()
    gone.destroyed = true
    handOffFocusOnClose(popover, () => undefined)
    handOffFocusOnClose(popover, () => gone)
    popover.focused = true
    popover.emit('close')
    expect(gone.focus).not.toHaveBeenCalled()
  })
})

describe('wireClosingFocus', () => {
  const wire = (platform: NodeJS.Platform): { app: EventEmitter, chrome: FakeContents } => {
    const app = new EventEmitter()
    const chrome = new FakeContents()
    wireClosingFocus(app as never, { findOwner: () => ({ chrome: { webContents: chrome } }) as never }, platform)
    return { app, chrome }
  }

  it('hands the keyboard off on macOS', () => {
    const { app, chrome } = wire('darwin')
    const popover = new FakeContents()
    app.emit('web-contents-created', {}, popover)
    popover.focused = true
    popover.emit('close')
    expect(chrome.focus).toHaveBeenCalledTimes(1)
  })

  it.each(['linux', 'win32'] as const)('changes nothing on %s, where closing contents do not crash', (platform) => {
    const { app } = wire(platform)
    expect(app.listenerCount('web-contents-created')).toBe(0)
  })
})
