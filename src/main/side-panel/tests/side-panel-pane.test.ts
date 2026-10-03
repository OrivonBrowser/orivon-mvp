import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeWindow } from './panel-fakes.js'
import type { FakeWindow } from './panel-fakes.js'
import { createSidePanel, setGuestEntries, wireSidePanel } from '../side-panel-host.js'
import type { PanelHost } from '../side-panel-host.js'
import { MemorySidePanelStore } from '../side-panel-store.js'
import { registerStore } from '../side-panel-stores.js'
import { sidePanelPane } from '../side-panel-pane.js'

let win: FakeWindow
let host: PanelHost

function view (url: string, focused: { value: boolean }): { webContents: Record<string, unknown>, setBounds: () => void, setVisible: () => void } {
  return { setBounds: () => {}, setVisible: () => {}, webContents: { isDestroyed: () => false, getURL: () => url, isFocused: () => focused.value, focus: vi.fn(() => { focused.value = true }) } }
}

beforeEach(() => {
  setGuestEntries([])
  win = fakeWindow()
  registerStore(win.ctx.services, new MemorySidePanelStore())
  wireSidePanel(win.ctx.window.window, win.wiring)
  host = createSidePanel(win.ctx)
})

describe('the side panel as a pane of the F6 order', () => {
  it('is available only while the panel is on screen', () => {
    expect(sidePanelPane.available(win.ctx)).toBe(false)
    host.open()
    expect(sidePanelPane.available(win.ctx)).toBe(true)
    win.state.fullscreen = true
    expect(sidePanelPane.available(win.ctx)).toBe(false)
  })

  it('finds the panel page among the window views by its address, and focuses it', () => {
    const focused = { value: false }
    win.children.push(view('file:///tabs/other.html', { value: false }), view('file:///overlay/index.html?overlay=side-panel&surface=panel', focused))
    host.open()

    expect(sidePanelPane.focused(win.ctx)).toBe(false)
    sidePanelPane.focus(win.ctx)
    expect(sidePanelPane.focused(win.ctx)).toBe(true)
  })

  it('focuses the guest view instead when one is shown', () => {
    const own = { value: false }
    const guestFocus = { value: false }
    const guest = view('chrome-extension://abc/panel.html', guestFocus)
    win.children.push(view('file:///overlay/index.html?overlay=side-panel&surface=panel', own))
    setGuestEntries([{ id: 'ext:abc', title: 'Notes' }])
    host.open('ext:abc')
    host.setGuest({ id: 'ext:abc', title: 'Notes', view: guest as never })

    sidePanelPane.focus(win.ctx)
    expect(guestFocus.value).toBe(true)
    expect(own.value).toBe(false)
    expect(sidePanelPane.focused(win.ctx)).toBe(true)
  })
})
