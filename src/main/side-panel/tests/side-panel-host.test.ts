import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeGuestView, fakeWindow } from './panel-fakes.js'
import type { FakeWindow } from './panel-fakes.js'
import { createSidePanel, onGuestChosen, setGuestEntries, sidePanelFor, sidePanelInsets, wireSidePanel } from '../side-panel-host.js'
import type { PanelHost } from '../side-panel-host.js'
import { MemorySidePanelStore } from '../side-panel-store.js'
import { registerStore } from '../side-panel-stores.js'

let win: FakeWindow
let host: PanelHost

function make (): void {
  win = fakeWindow()
  registerStore(win.ctx.services, new MemorySidePanelStore())
  // The host is keyed by the BaseWindow the shell holds.
  wireSidePanel(win.ctx.window.window, win.wiring)
  host = createSidePanel(win.ctx)
}

beforeEach(() => {
  setGuestEntries([])
  make()
})

describe('opening and closing', () => {
  it('starts closed, takes no room and answers the view and width it will open with', () => {
    expect(host.isOpen()).toBe(false)
    expect(sidePanelInsets(win.ctx.window.window)).toEqual({ left: 0, right: 0 })
    expect(host.view()).toBe('bookmarks')
    expect(host.width()).toBe(360)
    expect(host.side()).toBe('right')
    expect(host.bodyBounds()).toBeNull()
  })

  it('lays the page out narrower, then shows the overlay', () => {
    host.open()

    expect(host.isOpen()).toBe(true)
    expect(sidePanelInsets(win.ctx.window.window)).toEqual({ left: 0, right: 360 })
    expect(win.log).toEqual(['relayout', 'show'])
  })

  it('does nothing twice when it is already open', () => {
    host.open()
    host.open()
    expect(win.log).toEqual(['relayout', 'show', 'relayout'])
  })

  it('gives the room back, closes the overlay and hands the keys to the page', () => {
    host.open()
    win.log.length = 0
    host.close()

    expect(host.isOpen()).toBe(false)
    expect(sidePanelInsets(win.ctx.window.window)).toEqual({ left: 0, right: 0 })
    expect(win.log).toEqual(['close', 'relayout'])
    expect(win.activeFocus).toHaveBeenCalledTimes(1)
  })

  it('toggles, and a toggle naming another view switches instead of closing', () => {
    host.toggle()
    expect(host.isOpen()).toBe(true)
    host.toggle('history')
    expect(host.isOpen()).toBe(true)
    expect(host.view()).toBe('history')
    host.toggle('history')
    expect(host.isOpen()).toBe(false)
  })

  it('opens on the view named, refuses a view nobody lists, and remembers the last of its own views', () => {
    host.open('nonsense')
    expect(host.isOpen()).toBe(false)
    host.open('downloads')
    expect(host.view()).toBe('downloads')
    host.close()
    expect(createSidePanel(win.ctx).view()).toBe('downloads')
  })

  it('tells its listeners about each change, and stops telling one that left', () => {
    const heard = vi.fn()
    const stop = host.onChange(heard)
    host.open()
    host.close()
    expect(heard).toHaveBeenCalledTimes(2)
    stop()
    host.open()
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('does not open in a kiosk or in a window too narrow for it', () => {
    win.state.kiosk = true
    host.open()
    expect(host.isOpen()).toBe(false)
    win.state.kiosk = false
    win.state.width = 700
    host.open()
    expect(host.isOpen()).toBe(false)
  })

  it('says so when a toggle finds the window too narrow, and not in a kiosk or when it opens', () => {
    win.state.width = 700
    host.toggle()
    expect(win.ctx.window.overlays.show).toHaveBeenCalledWith('toast', undefined, { code: 'sidePanelNarrow' })
    vi.mocked(win.ctx.window.overlays.show).mockClear()
    win.state.overlayOpen = false
    win.state.kiosk = true
    host.toggle()
    win.state.kiosk = false
    win.state.width = 1280
    host.toggle()
    expect(win.ctx.window.overlays.show).toHaveBeenCalledTimes(1)
    expect(win.ctx.window.overlays.show).toHaveBeenCalledWith('side-panel')
  })

  it('takes no room in HTML fullscreen or once the window narrows, and takes it again after', () => {
    host.open()
    win.state.fullscreen = true
    expect(sidePanelInsets(win.ctx.window.window)).toEqual({ left: 0, right: 0 })
    expect(host.bodyBounds()).toBeNull()
    win.state.fullscreen = false
    win.state.width = 700
    expect(host.isOpen()).toBe(false)
    expect(sidePanelInsets(win.ctx.window.window)).toEqual({ left: 0, right: 0 })
    win.state.width = 1280
    expect(host.isOpen()).toBe(true)
    expect(sidePanelInsets(win.ctx.window.window)).toEqual({ left: 0, right: 360 })
  })

  it('is closed by the overlay itself (its renderer died) without asking the overlay again', () => {
    host.open()
    win.log.length = 0
    host.overlayClosed('request')
    expect(host.isOpen()).toBe(false)
    expect(win.log).toEqual(['relayout'])
  })

  it('answers an inert panel for a window it never made one for', () => {
    const other = fakeWindow()
    expect(sidePanelFor(other.ctx.window).isOpen()).toBe(false)
    sidePanelFor(other.ctx.window).open()
    expect(sidePanelInsets(other.ctx.window.window)).toEqual({ left: 0, right: 0 })
    expect(sidePanelFor(win.ctx.window)).toBe(host)
  })
})

describe('width and side', () => {
  it('keeps a resize within the limits, once per turn, and remembers it', async () => {
    host.open()
    win.log.length = 0
    host.resize(500)
    host.resize(9999)
    expect(win.log).toEqual([])
    await new Promise((resolve) => { setImmediate(resolve) })

    expect(host.width()).toBe(640)
    expect(win.log).toEqual(['relayout'])
    host.close()
    host.open()
    expect(host.width()).toBe(640)
  })

  it('sends the page the width it now has, with the limits this window allows', async () => {
    win.state.width = 900
    host.open()
    host.resize(600)
    await new Promise((resolve) => { setImmediate(resolve) })
    expect(win.sent.at(-1)).toEqual({ type: 'width', width: 420, limits: { min: 280, max: 420, reset: 360 } })
  })

  it('docks on the left when the setting says so, and tells the page', () => {
    host.open()
    win.state.side = 'left'
    host.sideChanged()
    expect(sidePanelInsets(win.ctx.window.window)).toEqual({ left: 360, right: 0 })
    expect(win.sent.at(-1)).toEqual({ type: 'side', side: 'left' })
  })

  it('reports where the body is: under the header, clear of the resize edge', () => {
    host.open()
    expect(host.bodyBounds()).toEqual({ x: 920 + 6, y: 76 + 40, width: 354, height: 724 - 40 })
    win.state.side = 'left'
    expect(host.bodyBounds()).toEqual({ x: 0, y: 76 + 40, width: 354, height: 724 - 40 })
  })
})

describe('a listener that asks before the panel exists', () => {
  it('hears the panel once it is made', () => {
    const early = fakeWindow()
    registerStore(early.ctx.services, new MemorySidePanelStore())
    wireSidePanel(early.ctx.window.window, early.wiring)
    const heard = vi.fn()
    sidePanelFor(early.ctx.window).onChange(heard)
    createSidePanel(early.ctx).open()
    expect(heard).toHaveBeenCalled()
  })
})

describe('the guest slot', () => {
  const entry = { id: 'ext:abcdef', title: 'Notes' }

  beforeEach(() => { setGuestEntries([entry, { id: 'ext:one', title: 'One' }, { id: 'ext:two', title: 'Two' }]) })

  it('puts a guest view in the window at the body, above the panel once the overlay host restacks', () => {
    const guest = fakeGuestView()
    host.open(entry.id)
    host.setGuest({ id: entry.id, title: 'Notes', view: guest.view })

    expect(win.children).toContain(guest.view)
    expect(guest.shown.at(-1)).toBe(true)
    expect(guest.bounds.at(-1)).toEqual(host.bodyBounds())
    expect(host.view()).toBe('ext:abcdef')
    expect(win.sent.at(-1)).toEqual({ type: 'view', view: 'ext:abcdef', guest: { id: 'ext:abcdef', title: 'Notes' } })

    win.children.length = 0
    win.adopted[0]?.restack?.()
    expect(win.children).toContain(guest.view)
  })

  it('is never closed by the overlay host closing popups', () => {
    const guest = fakeGuestView()
    host.open(entry.id)
    host.setGuest({ id: entry.id, title: 'Notes', view: guest.view })
    win.adopted[0]?.close()
    expect(win.children).toContain(guest.view)
  })

  it('shows a guest chosen while the panel was closed once the panel opens', () => {
    const guest = fakeGuestView()
    host.open(entry.id)
    host.close()
    host.open(entry.id)
    host.setGuest({ id: entry.id, title: 'Notes', view: guest.view })
    expect(win.children).toContain(guest.view)
  })

  it('closes at once a guest handed over while the panel is closed', () => {
    const closed = vi.fn()
    const guest = fakeGuestView()
    host.setGuest({ id: entry.id, title: 'Notes', view: guest.view, closed })
    expect(closed).toHaveBeenCalledTimes(1)
    expect(win.children).not.toContain(guest.view)
    expect(host.view()).toBe('bookmarks')
    host.open()
    expect(host.view()).toBe('bookmarks')
  })

  it('drops a late answer for an entry the person has moved away from', () => {
    const closed = vi.fn()
    const guest = fakeGuestView()
    host.open(entry.id)
    host.choose('history')
    host.setGuest({ id: entry.id, title: 'Notes', view: guest.view, closed })
    expect(closed).toHaveBeenCalledTimes(1)
    expect(win.children).not.toContain(guest.view)
    expect(host.view()).toBe('history')
  })

  it('closes the outgoing guest when another entry answers with the same view', () => {
    const first = vi.fn()
    const second = vi.fn()
    const shared = fakeGuestView().view
    host.open('ext:one')
    host.setGuest({ id: 'ext:one', title: 'One', view: shared, closed: first })
    host.choose('ext:two')
    host.setGuest({ id: 'ext:two', title: 'Two', view: shared, closed: second })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('steps aside while the view picker is open, so its list is not under the guest', () => {
    const guest = fakeGuestView()
    host.open(entry.id)
    host.setGuest({ id: entry.id, title: 'Notes', view: guest.view })
    host.pickerToggled(true)
    expect(win.children).not.toContain(guest.view)
    win.children.length = 0
    win.adopted[0]?.restack?.()
    expect(win.children).not.toContain(guest.view)
    host.pickerToggled(false)
    expect(win.children).toContain(guest.view)
  })

  it('forgets an open picker when the panel closes and opens again', () => {
    const guest = fakeGuestView()
    host.open(entry.id)
    host.setGuest({ id: entry.id, title: 'Notes', view: guest.view })
    host.pickerToggled(true)
    host.close()
    host.open(entry.id)
    host.setGuest({ id: entry.id, title: 'Notes', view: guest.view })
    expect(win.children).toContain(guest.view)
  })

  it('follows the panel when the window moves it', () => {
    const guest = fakeGuestView()
    host.open(entry.id)
    host.setGuest({ id: entry.id, title: 'Notes', view: guest.view })
    win.state.width = 1000
    host.moved()
    expect(guest.bounds.at(-1)).toEqual(host.bodyBounds())
  })

  it('hides the guest in HTML fullscreen', () => {
    const guest = fakeGuestView()
    host.open(entry.id)
    host.setGuest({ id: entry.id, title: 'Notes', view: guest.view })
    win.state.fullscreen = true
    host.moved()
    expect(win.children).not.toContain(guest.view)
  })

  it('runs `closed` once when the panel closes', () => {
    const closed = vi.fn()
    host.open(entry.id)
    host.setGuest({ id: entry.id, title: 'Notes', view: fakeGuestView().view, closed })
    host.close()
    host.close()
    host.stop()
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('runs `closed` once when another view is chosen, and falls back to the last of Orivon views', () => {
    const closed = vi.fn()
    host.open(entry.id)
    host.setGuest({ id: entry.id, title: 'Notes', view: fakeGuestView().view, closed })
    host.choose('downloads')
    expect(closed).toHaveBeenCalledTimes(1)
    expect(host.view()).toBe('downloads')
  })

  it('runs `closed` once for a guest replaced by another, and once for setGuest(null)', () => {
    const first = vi.fn()
    const second = vi.fn()
    host.open('ext:one')
    host.setGuest({ id: 'ext:one', title: 'One', view: fakeGuestView().view, closed: first })
    host.open('ext:two')
    host.setGuest({ id: 'ext:two', title: 'Two', view: fakeGuestView().view, closed: second })
    expect(first).toHaveBeenCalledTimes(1)
    host.setGuest(null)
    host.setGuest(null)
    expect(second).toHaveBeenCalledTimes(1)
    expect(host.view()).toBe('bookmarks')
    expect(win.sent.at(-1)).toMatchObject({ type: 'view', guest: null })
  })

  it('answers setGuest(null) for a chosen entry with no guest by showing the last of Orivon views again', () => {
    host.open('downloads')
    host.choose(entry.id)
    expect(host.view()).toBe(entry.id)
    host.setGuest(null)
    expect(host.view()).toBe('downloads')
    expect(win.sent.at(-1)).toMatchObject({ type: 'view', view: 'downloads', guest: null })
  })

  it('survives a throwing `closed` and a view that was destroyed', () => {
    const guest = fakeGuestView()
    host.open(entry.id)
    host.setGuest({ id: entry.id, title: 'Notes', view: guest.view, closed: () => { throw new Error('boom') } })
    guest.destroy()
    expect(() => { host.close() }).not.toThrow()
  })

  it('runs `closed` at once for a guest handed to a panel that is gone', () => {
    const closed = vi.fn()
    host.stop()
    host.setGuest({ id: entry.id, title: 'Notes', view: fakeGuestView().view, closed })
    expect(closed).toHaveBeenCalledTimes(1)
  })
})

describe('canShow', () => {
  it('is true with room, false below the minimum width, in a kiosk and once stopped', () => {
    expect(host.canShow()).toBe(true)
    win.state.width = 700
    expect(host.canShow()).toBe(false)
    win.state.width = 1280
    win.state.kiosk = true
    expect(host.canShow()).toBe(false)
    win.state.kiosk = false
    host.stop()
    expect(host.canShow()).toBe(false)
  })

  it('is false for the inert host of a window that has no panel', () => {
    expect(sidePanelFor({ window: {} } as never).canShow()).toBe(false)
  })
})

describe('guest entries', () => {
  it('tells every listener which entry was chosen, by picker, open or toggle', () => {
    const heard = vi.fn()
    const stop = onGuestChosen(heard)
    setGuestEntries([{ id: 'ext:abcdef', title: 'Notes' }])

    host.open('ext:abcdef')
    expect(heard).toHaveBeenCalledExactlyOnceWith(win.ctx.window, 'ext:abcdef')
    host.close()
    host.toggle('ext:abcdef')
    expect(heard).toHaveBeenCalledTimes(2)
    host.choose('history')
    host.choose('ext:abcdef')
    expect(heard).toHaveBeenCalledTimes(3)
    stop()
    host.choose('history')
    host.choose('ext:abcdef')
    expect(heard).toHaveBeenCalledTimes(3)
  })

  it('refuses an entry nobody listed, and one a listener threw on does not stop the next', () => {
    const second = vi.fn()
    const first = onGuestChosen(() => { throw new Error('boom') })
    const other = onGuestChosen(second)
    setGuestEntries([{ id: 'ext:abcdef', title: 'Notes' }])
    host.open('ext:unlisted')
    expect(host.isOpen()).toBe(false)
    host.open('ext:abcdef')
    expect(second).toHaveBeenCalledTimes(1)
    first()
    other()
  })

  it('tells each open page when the entries change', () => {
    host.open()
    setGuestEntries([{ id: 'ext:b', title: 'Beta' }, { id: 'ext:a', title: 'Alpha' }])
    expect(win.sent.at(-1)).toEqual({ type: 'guests', guests: [{ id: 'ext:a', title: 'Alpha' }, { id: 'ext:b', title: 'Beta' }] })
  })

  it('keeps only well-formed entries, once each, and an icon only if it is an image', () => {
    host.open()
    setGuestEntries([
      { id: 'ext:ok', title: 'Fine', icon: 'data:image/png;base64,AAAA' },
      { id: 'ext:ok', title: 'Again' },
      { id: 'other:x', title: 'Not an extension' },
      { id: 'ext:blank', title: '   ' },
      { id: 'ext:evil', title: 'Evil', icon: 'https://evil.example/icon.png' }
    ])
    expect(win.sent.at(-1)).toEqual({ type: 'guests', guests: [
      { id: 'ext:evil', title: 'Evil' },
      { id: 'ext:ok', title: 'Fine', icon: 'data:image/png;base64,AAAA' }
    ] })
  })
})
