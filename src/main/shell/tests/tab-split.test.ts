import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubsystemContext } from '../../registry.js'
import { GAP, MARGIN } from '../split-model.js'
import { HtmlFullscreen } from '../fullscreen.js'

// A tab manager over fake views, with a content view that keeps the order its
// children were added in: what matters in a split is which views are on screen,
// where, and in what order.
interface FakeContents extends EventEmitter {
  loadURL: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  isLoading: () => boolean
  getURL: () => string
  getTitle: () => string
  navigationHistory: { canGoBack: () => boolean, canGoForward: () => boolean }
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  ipc: { on: ReturnType<typeof vi.fn> }
  close: ReturnType<typeof vi.fn>
  focus: ReturnType<typeof vi.fn>
}
interface RecordedView { webContents: FakeContents, setBounds: ReturnType<typeof vi.fn>, setBackgroundColor: ReturnType<typeof vi.fn>, name: string }
const createdViews: RecordedView[] = []

function makeFakeWebContents (): FakeContents {
  const emitter = new EventEmitter() as FakeContents
  let destroyed = false
  emitter.loadURL = vi.fn(async () => {})
  emitter.isDestroyed = vi.fn(() => destroyed)
  emitter.isLoading = () => false
  emitter.getURL = () => 'https://a.example/'
  emitter.getTitle = () => ''
  emitter.navigationHistory = { canGoBack: () => false, canGoForward: () => false }
  emitter.setWindowOpenHandler = vi.fn()
  emitter.ipc = { on: vi.fn() }
  emitter.close = vi.fn(() => { destroyed = true; emitter.emit('destroyed') })
  emitter.focus = vi.fn()
  return emitter
}

vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: RecordedView) {
    this.webContents = makeFakeWebContents()
    this.setBounds = vi.fn()
    this.setBackgroundColor = vi.fn()
    this.name = `view-${String(createdViews.length)}`
    createdViews.push(this)
  })
}))

const { TabManager } = await import('../tabs.js')

beforeEach(() => { createdViews.length = 0 })

const AREA = { x: 0, y: 100, width: 1000, height: 600 }

interface Rig {
  manager: InstanceType<typeof TabManager>
  children: unknown[]
  contentView: { addChildView: ReturnType<typeof vi.fn>, removeChildView: ReturnType<typeof vi.fn> }
  area: { current: typeof AREA }
  backdrop: { view: { name: string, setBounds: ReturnType<typeof vi.fn> }, update: ReturnType<typeof vi.fn> }
  fullscreen: (id: string, entered: boolean) => void
  /** `HtmlFullscreen.tabId` itself (../fullscreen.ts), read the same way window.ts does: the one
   * place this rig's `fullscreen()` helper and `manager`'s own layout both ultimately read from. */
  fullscreenTabId: () => string | null
  onEmpty: ReturnType<typeof vi.fn>
}

function rig (): Rig {
  const children: unknown[] = []
  // Electron 44's own `View`: re-adding a child already there reorders it to
  // the top instead of appending a duplicate; a fresh one goes at `index`,
  // the end by default (see pane-host.test.ts's identical fake).
  const contentView = {
    addChildView: vi.fn((view: unknown, index?: number) => {
      const at = children.indexOf(view)
      if (at !== -1) children.splice(at, 1)
      if (at !== -1 || index === undefined) children.push(view)
      else children.splice(Math.min(index, children.length), 0, view)
    }),
    removeChildView: vi.fn((view: unknown) => { const at = children.indexOf(view); if (at !== -1) children.splice(at, 1) })
  }
  const area = { current: AREA }
  const backdrop = { view: { name: 'backdrop', setBounds: vi.fn() }, update: vi.fn() }
  const onEmpty = vi.fn()
  let manager!: InstanceType<typeof TabManager>
  // Wired the same way window.ts wires HtmlFullscreen and TabManager together,
  // so this rig cannot drift from what the shell really does.
  const htmlFullscreen = new HtmlFullscreen({
    relayout: () => { manager.layout() },
    exitTab: () => {},
    leaveWindowFullscreen: () => {},
    showNotice: () => {},
    hideNotice: () => {}
  })
  manager = new TabManager(contentView as never, () => area.current, onEmpty, 'http://localhost:5999/newtab/', {} as SubsystemContext, {
    window: { isDestroyed: () => false } as never,
    htmlFullscreenChanged: (id, entered) => { htmlFullscreen.changed(id, entered, manager.getState().activeTabId) },
    fullscreenTabId: () => htmlFullscreen.tabId,
    backdrop: backdrop as never
  })
  manager.onStateChange((state) => { htmlFullscreen.tabsChanged(state.activeTabId, (id) => state.tabs.some((tab) => tab.id === id)) })
  return {
    manager,
    children,
    contentView,
    area,
    backdrop,
    onEmpty,
    fullscreen: (id, entered) => { (manager as unknown as { viewHost: { htmlFullscreenChanged: (id: string, entered: boolean) => void } }).viewHost.htmlFullscreenChanged(id, entered) },
    fullscreenTabId: () => htmlFullscreen.tabId
  }
}

const ids = (manager: InstanceType<typeof TabManager>): string[] => manager.getState().tabs.map((tab) => tab.id)
const names = (children: unknown[]): string[] => children.map((child) => (child as { name: string }).name)
const boundsOf = (view: RecordedView): unknown => view.setBounds.mock.calls.at(-1)?.[0]

describe('two tabs in a split', () => {
  it('are both on screen, each in its pane, with the backdrop under them', () => {
    const { manager, children, backdrop } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')

    expect(manager.splits.split(a, b, 'right')).toBe(true)

    const [viewA, viewB] = createdViews as [RecordedView, RecordedView]
    expect(names(children)).toEqual(['backdrop', viewA.name, viewB.name])
    const room = AREA.width - 2 * MARGIN - GAP
    expect(boundsOf(viewA)).toEqual({ x: MARGIN, y: AREA.y + MARGIN, width: room / 2, height: AREA.height - 2 * MARGIN })
    expect(boundsOf(viewB)).toMatchObject({ x: MARGIN + room / 2 + GAP, width: room / 2 })
    expect(backdrop.view.setBounds).toHaveBeenLastCalledWith(AREA)
    expect(backdrop.update).toHaveBeenLastCalledWith(expect.objectContaining({ orientation: 'row', active: 'b' }))
    expect(manager.getState().activeTabId).toBe(b)
  })

  it('never detaches the pane already on screen just because the backdrop is appearing beside it', () => {
    // The first split: `b` is already shown alone (createTab activated it)
    // when the split adds the backdrop and `a` beside it. A stray
    // removeChildView on `b` here would be the exact bug that left a first
    // split's surviving pane briefly unpainted.
    const { manager, contentView } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    const viewB = createdViews[1] as RecordedView
    contentView.removeChildView.mockClear()

    manager.splits.split(a, b, 'right')

    expect(contentView.removeChildView).not.toHaveBeenCalledWith(viewB)
  })

  it('sit side by side in the strip, and each knows the other', () => {
    const { manager } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    const c = manager.createTab('https://c.example/')

    manager.splits.split(a, c, 'left')

    expect(ids(manager)).toEqual([c, a, b])
    const withs = Object.fromEntries(manager.getState().tabs.map((tab) => [tab.id, tab.splitWith]))
    expect(withs).toEqual({ [c]: a, [a]: c, [b]: null })
  })

  it('leave the screen when another tab is chosen, and come back together', () => {
    const { manager, children } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    const c = manager.createTab('https://c.example/')
    manager.splits.split(a, b, 'right')

    manager.activateTab(c)
    expect(names(children)).toEqual([(createdViews[2] as RecordedView).name])
    manager.activateTab(a)

    expect(names(children)).toEqual(['backdrop', (createdViews[0] as RecordedView).name, (createdViews[1] as RecordedView).name])
    expect(manager.getState().activeTabId).toBe(a)
  })

  it('change which one the person is in without touching the views', () => {
    const { manager, backdrop } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    manager.splits.split(a, b, 'right')
    const [viewA] = createdViews as [RecordedView]
    const calls = viewA.setBounds.mock.calls.length

    manager.activateTab(a)

    expect(manager.getState().activeTabId).toBe(a)
    expect(backdrop.update).toHaveBeenLastCalledWith(expect.objectContaining({ active: 'a' }))
    expect(viewA.setBounds.mock.calls.length).toBe(calls + 1)
    expect((manager as unknown as { panes: { shown: Map<string, unknown> } }).panes.shown.size).toBe(2)
  })

  it('make the pane the person presses in the one they are in, but never a tab that is not beside it', () => {
    const { manager } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    const c = manager.createTab('https://c.example/')
    manager.splits.split(a, b, 'right')
    const viewA = createdViews[0] as RecordedView
    const viewC = createdViews[2] as RecordedView

    viewA.webContents.emit('input-event', {}, { type: 'mouseDown' })
    expect(manager.getState().activeTabId).toBe(a)
    viewA.webContents.emit('input-event', {}, { type: 'mouseMove' })
    viewC.webContents.emit('input-event', {}, { type: 'mouseDown' })

    expect(manager.getState().activeTabId).toBe(a)
    expect(c).not.toBe(a)
  })

  it('leave the other alone and full-size when one is closed', () => {
    const { manager, children } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    manager.splits.split(a, b, 'right')

    manager.closeTab(b)

    expect(ids(manager)).toEqual([a])
    expect(manager.getState().tabs[0]?.splitWith).toBeNull()
    expect(names(children)).toEqual([(createdViews[0] as RecordedView).name])
    expect(boundsOf(createdViews[0] as RecordedView)).toEqual(AREA)
  })

  it('come apart on request, staying open side by side in the strip', () => {
    const { manager, children } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    manager.splits.split(a, b, 'right')

    manager.splits.separate(a)

    expect(ids(manager)).toEqual([a, b])
    expect(manager.getState().tabs.map((tab) => tab.splitWith)).toEqual([null, null])
    expect(names(children)).toEqual([(createdViews[1] as RecordedView).name])
  })

  it('are shown as one page when the window is too small for two', () => {
    const { manager, area, children } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    manager.splits.split(a, b, 'right')

    area.current = { x: 0, y: 100, width: 400, height: 600 }
    manager.layout()

    expect(names(children)).toEqual([(createdViews[1] as RecordedView).name])
    expect(boundsOf(createdViews[1] as RecordedView)).toEqual(area.current)
    expect(manager.getState().tabs.map((tab) => tab.splitWith)).toEqual([b, a])
  })

  it('give the whole area to a page that goes fullscreen, and take it back when it leaves', () => {
    const { manager, children, fullscreen } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    manager.splits.split(a, b, 'right')

    manager.activateTab(a)
    fullscreen(a, true)
    manager.layout()
    expect(names(children)).toEqual([(createdViews[0] as RecordedView).name])
    expect(boundsOf(createdViews[0] as RecordedView)).toEqual(AREA)

    fullscreen(a, false)
    manager.layout()
    expect(names(children)).toEqual(['backdrop', (createdViews[0] as RecordedView).name, (createdViews[1] as RecordedView).name])
  })

  it('move along the strip together', () => {
    const { manager } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    const c = manager.createTab('https://c.example/')
    const d = manager.createTab('https://d.example/')
    manager.splits.split(a, b, 'right')

    manager.moveTab(b, 2)

    expect(ids(manager)).toEqual([c, d, a, b])
    manager.moveTab(a, 0)
    expect(ids(manager)).toEqual([a, b, c, d])
  })

  it('are broken up when one is handed to another window', () => {
    const { manager } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    manager.splits.split(a, b, 'right')

    const taken = manager.takeTab(b)

    expect(taken).not.toBeNull()
    expect(manager.getState().tabs.map((tab) => tab.splitWith)).toEqual([null])
  })

  it('swap panes, and turn from side by side to stacked', () => {
    const { manager, backdrop } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    manager.splits.split(a, b, 'right')

    manager.splits.swap(a)
    expect(ids(manager)).toEqual([b, a])
    manager.splits.rotate(a)

    expect(backdrop.update).toHaveBeenLastCalledWith(expect.objectContaining({ orientation: 'column' }))
    expect(boundsOf(createdViews[1] as RecordedView)).toMatchObject({ x: MARGIN, width: AREA.width - 2 * MARGIN })
  })

  it('are resized by the divider, within limits, and put back to half', () => {
    const { manager } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    manager.splits.split(a, b, 'right')
    const viewA = createdViews[0] as RecordedView

    manager.splits.setRatio(a, 0.3)
    expect((boundsOf(viewA) as { width: number }).width).toBe(Math.round((AREA.width - 2 * MARGIN - GAP) * 0.3))
    manager.splits.setRatio(a, 0.01)
    expect((boundsOf(viewA) as { width: number }).width).toBe(Math.round((AREA.width - 2 * MARGIN - GAP) * 0.2))
    manager.splits.resetRatio(a)
    expect((boundsOf(viewA) as { width: number }).width).toBe((AREA.width - 2 * MARGIN - GAP) / 2)
  })

  it('toggle: join with the next tab, a new one when there is none, and break up again', () => {
    const { manager } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')

    manager.splits.toggle(a)
    expect(manager.getState().tabs.map((tab) => tab.splitWith)).toEqual([b, a])
    expect(manager.getState().activeTabId).toBe(a)
    manager.splits.toggle(a)
    expect(manager.getState().tabs.map((tab) => tab.splitWith)).toEqual([null, null])

    manager.closeTab(a)
    manager.splits.toggle(b)
    expect(manager.getState().tabs).toHaveLength(2)
    expect(manager.getState().tabs.every((tab) => tab.splitWith !== null)).toBe(true)
  })

  it('go to the other pane on request', () => {
    const { manager } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    manager.splits.split(a, b, 'right')

    expect(manager.splits.focusOther(b)).toBe(true)
    expect(manager.getState().activeTabId).toBe(a)
    expect((createdViews[0] as RecordedView).webContents.focus).toHaveBeenCalledTimes(1)
    expect((createdViews[1] as RecordedView).webContents.focus).not.toHaveBeenCalled()
    expect(manager.splits.focusOther('tab-not-here')).toBe(false)
  })
})

describe('a tab dragged over the page', () => {
  it('shrinks the page to the other half and marks where it would go, then goes back', () => {
    const { manager, backdrop, children } = rig()
    const a = manager.createTab('https://a.example/')
    manager.createTab('https://b.example/')
    manager.activateTab(a)

    manager.splits.setPreview('left')

    expect(boundsOf(createdViews[0] as RecordedView)).toEqual({ x: 500 + MARGIN, y: 100 + MARGIN, width: 500 - 2 * MARGIN, height: 600 - 2 * MARGIN })
    expect(backdrop.update).toHaveBeenLastCalledWith(expect.objectContaining({ placeholder: { x: MARGIN, y: 100 + MARGIN, width: 500 - 2 * MARGIN, height: 600 - 2 * MARGIN }, divider: null }))
    expect(names(children)[0]).toBe('backdrop')

    manager.splits.setPreview(null)

    expect(boundsOf(createdViews[0] as RecordedView)).toEqual(AREA)
    expect(names(children)).toEqual([(createdViews[0] as RecordedView).name])
  })

  it('splits when it is dropped, the dropped tab on the side it was dropped', () => {
    const { manager } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    manager.activateTab(a)
    manager.splits.setPreview('left')

    manager.splits.split(a, b, 'left')

    expect(ids(manager)).toEqual([b, a])
    expect(manager.splits.previewing).toBe(false)
    expect(manager.getState().activeTabId).toBe(b)
  })
})

describe('splitting is refused', () => {
  it('for a tab with itself, or one that is not there', () => {
    const { manager } = rig()
    const a = manager.createTab('https://a.example/')
    expect(manager.splits.split(a, a, 'right')).toBe(false)
    expect(manager.splits.split(a, 'tab-nope', 'right')).toBe(false)
  })
})

describe('the tab beside one that closes or leaves', () => {
  it('has the whole area when the one in front closes and when it is handed on', () => {
    for (const leave of [(m: ReturnType<typeof rig>['manager'], id: string) => { m.closeTab(id) }, (m: ReturnType<typeof rig>['manager'], id: string) => { m.takeTab(id) }]) {
      createdViews.length = 0
      const { manager, children } = rig()
      const a = manager.createTab('https://a.example/')
      const b = manager.createTab('https://b.example/')
      manager.splits.split(a, b, 'right')
      manager.activateTab(a)

      leave(manager, b)

      expect(names(children)).toEqual([(createdViews[0] as RecordedView).name])
      expect(boundsOf(createdViews[0] as RecordedView)).toEqual(AREA)
    }
  })

  it('is reported once as the last tab going, however soon the closed view says so', () => {
    const { manager, onEmpty } = rig()
    manager.closeTab(manager.createTab('https://a.example/'))
    expect(onEmpty).toHaveBeenCalledTimes(1)
  })
})

describe('a page that holds the window', () => {
  it('lets go of it when its tab closes, so the next tab is shown', () => {
    const { manager, children, fullscreen } = rig()
    manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    fullscreen(b, true)

    manager.closeTab(b)
    manager.layout()

    expect(names(children)).toEqual([(createdViews[0] as RecordedView).name])
    manager.createTab('https://c.example/')
    expect(names(children)).toEqual([(createdViews[2] as RecordedView).name])
  })

  it('is not given it when its tab is not the one in front', () => {
    const { manager, children, fullscreen } = rig()
    const a = manager.createTab('https://a.example/')
    manager.createTab('https://b.example/')

    fullscreen(a, true)
    manager.layout()
    expect(names(children)).toEqual([(createdViews[1] as RecordedView).name])

    fullscreen(a, false)
    manager.layout()
    expect(names(children)).toEqual([(createdViews[1] as RecordedView).name])
  })

  it('agrees with HtmlFullscreen once told, and never shows a stale fullscreen tab', () => {
    const { manager, children, fullscreen, fullscreenTabId } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    manager.activateTab(a)
    fullscreen(a, true)
    expect(fullscreenTabId()).toBe(a)
    expect(names(children)).toEqual([(createdViews[0] as RecordedView).name])

    manager.activateTab(b)

    expect(names(children)).toEqual([(createdViews[1] as RecordedView).name])
    expect(fullscreenTabId()).toBeNull()
  })

  it('never shows a tab full-screen once it stops being the tab in front, even before HtmlFullscreen is told', () => {
    // No onStateChange wiring here, unlike rig(): this manager's plan has to
    // stay right on its own the moment activeId moves, since nothing ever
    // calls HtmlFullscreen.tabsChanged() to correct it for this test.
    const children: unknown[] = []
    const contentView = {
      addChildView: vi.fn((view: unknown) => { children.push(view) }),
      removeChildView: vi.fn((view: unknown) => { const at = children.indexOf(view); if (at !== -1) children.splice(at, 1) })
    }
    const htmlFullscreen = new HtmlFullscreen({ relayout: vi.fn(), exitTab: vi.fn(), leaveWindowFullscreen: vi.fn(), showNotice: vi.fn(), hideNotice: vi.fn() })
    const manager = new TabManager(contentView as never, () => AREA, vi.fn(), 'http://localhost:5999/newtab/', {} as SubsystemContext, {
      window: { isDestroyed: () => false } as never,
      htmlFullscreenChanged: vi.fn(),
      fullscreenTabId: () => htmlFullscreen.tabId
    })
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    manager.activateTab(a)
    htmlFullscreen.changed(a, true, a)
    manager.layout()
    expect(names(children)).toEqual([(createdViews[0] as RecordedView).name])

    manager.activateTab(b)

    expect(htmlFullscreen.tabId).toBe(a)
    expect(names(children)).toEqual([(createdViews[1] as RecordedView).name])
  })
})

describe('a joined pair in the strip', () => {
  it('is passed by a tab moved into it, on the side the tab came from', () => {
    const { manager } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    const c = manager.createTab('https://c.example/')
    const d = manager.createTab('https://d.example/')
    manager.splits.split(a, b, 'right')

    manager.moveTab(c, 1)
    expect(ids(manager)).toEqual([c, a, b, d])
    manager.moveTab(c, 1)
    expect(ids(manager)).toEqual([a, b, c, d])
  })

  it('is passed by a tab that arrives from another window at a place inside it', () => {
    const { manager } = rig()
    const a = manager.createTab('https://a.example/')
    const b = manager.createTab('https://b.example/')
    manager.splits.split(a, b, 'right')
    const other = rig().manager
    const arriving = other.createTab('https://x.example/')
    const record = other.takeTab(arriving)

    manager.giveTab(arriving, record as NonNullable<typeof record>, 1)

    expect(ids(manager)).toEqual([a, b, arriving])
  })
})

describe('a split asked for in a full window', () => {
  it('leaves every existing pair alone rather than pairing with the tab in front', () => {
    const { manager } = rig()
    const tabs = Array.from({ length: 100 }, (_, n) => manager.createTab(`https://t${String(n)}.example/`))
    manager.splits.split(tabs[98] as string, tabs[99] as string, 'right')
    const openInSplit = (manager as unknown as { viewHost: { openInSplit: (id: string, url: string) => void } }).viewHost.openInSplit
    openInSplit(tabs[0] as string, 'https://more.example/')
    const withs = Object.fromEntries(manager.getState().tabs.map((tab) => [tab.id, tab.splitWith]))
    expect(withs[tabs[99] as string]).toBe(tabs[98])
    expect(withs[tabs[0] as string]).toBeNull()
  })
})
