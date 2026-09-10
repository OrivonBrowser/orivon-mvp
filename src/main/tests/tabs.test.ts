import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { originFromUrl } from '../../broker/policy/origin.js'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import type { SubsystemContext } from '../registry.js'

// tabs.ts imports WebContentsView directly from 'electron' at module scope --
// outside a real Electron process this cannot even be imported without
// mocking it first (same reasoning as src/preload/tests/orivon-surface.test.ts).
// The fake webContents is a REAL EventEmitter, not a bag of vi.fn() no-ops:
// the swap-on-navigate behaviour below depends on exact listener wiring/
// unwiring (repartitionView() must strip the OLD view's 'destroyed' listener
// before closing it, or a deliberate view swap would mis-fire forgetTab()),
// and that is only observable by actually emitting events through it.
interface FakeWebContents extends EventEmitter {
  loadURL: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  isLoading: ReturnType<typeof vi.fn>
  getURL: ReturnType<typeof vi.fn>
  getTitle: ReturnType<typeof vi.fn>
  navigationHistory: { canGoBack: () => boolean, canGoForward: () => boolean }
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

interface RecordedView {
  options: { webPreferences?: Record<string, unknown> }
  webContents: FakeWebContents
  setBounds: ReturnType<typeof vi.fn>
}
const createdViews: RecordedView[] = []

function makeFakeWebContents (): FakeWebContents {
  const emitter = new EventEmitter() as FakeWebContents
  let destroyed = false
  emitter.loadURL = vi.fn(async () => {})
  emitter.isDestroyed = vi.fn(() => destroyed)
  emitter.isLoading = vi.fn(() => false)
  emitter.getURL = vi.fn(() => '')
  emitter.getTitle = vi.fn(() => '')
  emitter.navigationHistory = { canGoBack: () => false, canGoForward: () => false }
  emitter.setWindowOpenHandler = vi.fn()
  // Real Electron destruction can fire 'destroyed' synchronously from
  // close() -- mirrored here so a repartitionView() that forgot to strip
  // the OLD view's listener FIRST would be caught by this test file, not
  // just in a real launch.
  emitter.close = vi.fn(() => { destroyed = true; emitter.emit('destroyed') })
  return emitter
}

vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: RecordedView, options: RecordedView['options']) {
    this.options = options
    this.webContents = makeFakeWebContents()
    this.setBounds = vi.fn()
    createdViews.push(this)
  })
}))

const { TabManager } = await import('../tabs.js')

const fakeContentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
const fakeBounds = { x: 0, y: 0, width: 800, height: 600 }
const fakeCtx = {} as SubsystemContext
const DASHBOARD_URL = 'http://localhost:5999/newtab/'

function newManager (ctx: SubsystemContext = fakeCtx): InstanceType<typeof TabManager> {
  return new TabManager(
    fakeContentView as never,
    () => fakeBounds,
    vi.fn(),
    DASHBOARD_URL,
    ctx
  )
}

function partitionOf (view: RecordedView): unknown {
  return view.options.webPreferences?.['partition']
}

function additionalArgumentsOf (view: RecordedView): string[] | undefined {
  return view.options.webPreferences?.['additionalArguments'] as string[] | undefined
}

/** A fake `SubsystemContext` whose `broker.app.isRegisteredSync` answers from a caller-supplied set of registered origins -- everything else throws if touched, since no test here needs it. */
function ctxWithRegisteredOrigins (...origins: string[]): SubsystemContext {
  const registered = new Set(origins)
  return {
    broker: { app: { isRegisteredSync: (origin: string) => registered.has(origin) } }
  } as unknown as SubsystemContext
}

beforeEach(() => {
  createdViews.length = 0
  fakeContentView.addChildView.mockClear()
  fakeContentView.removeChildView.mockClear()
})

describe('TabManager -- per-origin session partitions at creation (ADR-0003, ADR-0007)', () => {
  it('assigns a real app tab the exact partition partitionFor(originFromUrl(url)) computes', () => {
    const manager = newManager()
    manager.createTab('https://app.example/page')

    const expected = partitionFor(originFromUrl('https://app.example/page') as string)
    expect(createdViews).toHaveLength(1)
    expect(partitionOf(createdViews[0] as RecordedView)).toBe(expected)
  })

  it('gives two different origins two different partitions', () => {
    const manager = newManager()
    manager.createTab('https://a.example/')
    manager.createTab('https://b.example/')

    const partitionA = partitionOf(createdViews[0] as RecordedView)
    const partitionB = partitionOf(createdViews[1] as RecordedView)
    expect(partitionA).not.toBe(partitionB)
    expect(partitionA).not.toBeUndefined()
    expect(partitionB).not.toBeUndefined()
  })

  it('gives two different paths on the SAME origin the SAME partition -- origin is the isolation key, not the full URL', () => {
    const manager = newManager()
    manager.createTab('https://app.example/one')
    manager.createTab('https://app.example/two')

    expect(partitionOf(createdViews[0] as RecordedView)).toBe(partitionOf(createdViews[1] as RecordedView))
  })

  it('every real app partition is persist:-prefixed -- ADR-0003 requires storage to survive a restart', () => {
    const manager = newManager()
    manager.createTab('https://app.example/')
    expect(partitionOf(createdViews[0] as RecordedView)).toMatch(/^persist:app-[0-9a-f]{64}$/)
  })

  it('the fresh-tab dashboard gets NO partition, even though its own dev-mode URL is a real http(s) address', () => {
    const manager = newManager()
    manager.createTab() // no url -- createTab()'s own dashboard branch
    expect(partitionOf(createdViews[0] as RecordedView)).toBeUndefined()
  })

  it('a rejected direct URL (dangerous scheme) falls back to about:blank with NO partition', () => {
    const manager = newManager()
    manager.createTab('javascript:alert(1)')
    expect(partitionOf(createdViews[0] as RecordedView)).toBeUndefined()
  })

  it('an invalid direct URL falls back to about:blank with NO partition', () => {
    const manager = newManager()
    manager.createTab('not a url at all')
    expect(partitionOf(createdViews[0] as RecordedView)).toBeUndefined()
  })
})

// THE PRIMARY USER PATH: a fresh tab (dashboard or otherwise) navigated via
// the omnibox -- ipc.ts's 'navigate' command and newtab-ipc.ts's dashboard
// navigate both funnel here. Attempt 1 only wired partitioning into
// createTab()'s own construction arguments, which a real launch proved is
// NOT the path an actual person takes: nobody's very first act in a fresh
// tab is calling createTab(url) directly, they type into the address bar,
// which is navigate(). These tests exist because the e2e test alone did not
// catch this fast enough -- it needs a real Electron launch to run at all.
describe("TabManager -- ADR-0017's synchronous fetch()-routing flag (appTabArgsFor)", () => {
  it('a fresh tab whose origin is a registered app gets the --orivon-app-tab additionalArgument', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://app.example'))
    manager.createTab('https://app.example/page')

    expect(additionalArgumentsOf(createdViews[0] as RecordedView)).toEqual(['--orivon-app-tab'])
  })

  it('a fresh tab whose origin is NOT a registered app gets no such argument', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://other.example'))
    manager.createTab('https://app.example/page')

    expect(additionalArgumentsOf(createdViews[0] as RecordedView)).toBeUndefined()
  })

  it('a tab with no broker at all (ctx.broker undefined) gets no argument -- never throws', () => {
    const manager = newManager({} as SubsystemContext)
    expect(() => { manager.createTab('https://app.example/page') }).not.toThrow()
    expect(additionalArgumentsOf(createdViews[0] as RecordedView)).toBeUndefined()
  })

  it('the fresh-tab dashboard never gets the flag, even if its own URL happened to be a registered origin', () => {
    const manager = newManager(ctxWithRegisteredOrigins(originFromUrl(DASHBOARD_URL) as string))
    manager.createTab() // dashboard

    expect(additionalArgumentsOf(createdViews[0] as RecordedView)).toEqual([`--orivon-newtab-url=${DASHBOARD_URL}`])
  })

  it('navigating an existing tab TO a registered app\'s origin swaps in a view carrying the flag', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://app.example'))
    const id = manager.createTab('https://a.example/')
    manager.navigate(id, 'https://app.example/page')

    expect(additionalArgumentsOf(createdViews[1] as RecordedView)).toEqual(['--orivon-app-tab'])
  })

  it('navigating away FROM a registered app\'s origin to an unregistered one drops the flag on the new view', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://app.example'))
    const id = manager.createTab('https://app.example/page')
    manager.navigate(id, 'https://plain-website.example/')

    expect(additionalArgumentsOf(createdViews[1] as RecordedView)).toBeUndefined()
  })
})

describe('TabManager -- navigate() repartitions a tab when the ORIGIN changes', () => {
  it('navigating a fresh dashboard tab to a real origin swaps in a view with that origin\'s partition', () => {
    const manager = newManager()
    const id = manager.createTab() // dashboard, no partition
    manager.navigate(id, 'https://app.example/page')

    expect(createdViews).toHaveLength(2)
    const expected = partitionFor(originFromUrl('https://app.example/page') as string)
    expect(partitionOf(createdViews[1] as RecordedView)).toBe(expected)
  })

  it('navigating an existing app tab to a DIFFERENT origin swaps to a new view with the new partition', () => {
    const manager = newManager()
    const id = manager.createTab('https://a.example/')
    manager.navigate(id, 'https://b.example/')

    expect(createdViews).toHaveLength(2)
    const expected = partitionFor(originFromUrl('https://b.example/') as string)
    expect(partitionOf(createdViews[1] as RecordedView)).toBe(expected)
  })

  it('closes the OLD view\'s webContents on a swap -- no leaked WebContentsView per navigation', () => {
    const manager = newManager()
    const id = manager.createTab('https://a.example/')
    manager.navigate(id, 'https://b.example/')

    expect((createdViews[0] as RecordedView).webContents.close).toHaveBeenCalledTimes(1)
  })

  it('does NOT forget the tab when the OLD (swapped-out) view is later destroyed -- the tab is not closing', () => {
    const manager = newManager()
    const id = manager.createTab('https://a.example/')
    manager.navigate(id, 'https://b.example/')

    // close() above already emitted 'destroyed' once (see makeFakeWebContents);
    // if repartitionView() failed to strip that listener FIRST, forgetTab()
    // already ran by this point and the tab would already be gone.
    const state = manager.getState()
    expect(state.tabs.map((t) => t.id)).toContain(id)
    expect(state.tabs).toHaveLength(1)
  })

  it('navigating within the SAME origin reuses the existing view -- no swap', () => {
    const manager = newManager()
    const id = manager.createTab('https://a.example/one')
    manager.navigate(id, 'https://a.example/two')

    expect(createdViews).toHaveLength(1)
    const view = createdViews[0] as RecordedView
    expect(view.webContents.loadURL).toHaveBeenLastCalledWith('https://a.example/two')
    expect(view.webContents.close).not.toHaveBeenCalled()
  })

  it('a rejected navigation on a real app tab does NOT swap -- stays in its own partition, loads about:blank on the SAME view', () => {
    const manager = newManager()
    const id = manager.createTab('https://a.example/')
    const before = partitionOf(createdViews[0] as RecordedView)
    manager.navigate(id, 'javascript:alert(1)')

    expect(createdViews).toHaveLength(1)
    expect(partitionOf(createdViews[0] as RecordedView)).toBe(before)
    expect((createdViews[0] as RecordedView).webContents.loadURL).toHaveBeenLastCalledWith('about:blank')
  })

  it('a rejected navigation on the dashboard tab does NOT swap', () => {
    const manager = newManager()
    const id = manager.createTab()
    // A genuinely REJECTED omnibox input (parseOmniboxInput's own dangerous-
    // scheme list), not merely non-URL-shaped text -- plain text like "not a
    // url" is a legitimate DuckDuckGo SEARCH (a real https:// destination,
    // correctly not a member of this test), only a dangerous scheme or empty
    // input is a `reject`.
    manager.navigate(id, 'javascript:alert(1)')

    expect(createdViews).toHaveLength(1)
    expect(partitionOf(createdViews[0] as RecordedView)).toBeUndefined()
  })

  it('the swapped-in view\'s own popup handler (T18) still redirects window.open() to a new tab', () => {
    const manager = newManager()
    const id = manager.createTab() // dashboard
    manager.navigate(id, 'https://app.example/')

    const swappedIn = createdViews[1] as RecordedView
    const handler = swappedIn.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as
      ((details: { url: string }) => { action: string }) | undefined
    expect(handler).toBeTypeOf('function')
    handler?.({ url: 'https://popup.example/' })

    expect(createdViews).toHaveLength(3)
    const expected = partitionFor(originFromUrl('https://popup.example/') as string)
    expect(partitionOf(createdViews[2] as RecordedView)).toBe(expected)
  })

  it('reattaches the swapped view to the window only when the tab being navigated is the ACTIVE one', () => {
    const manager = newManager()
    // Each createTab() call activates itself (TabManager.activateTab), so
    // after both calls `backgroundTabId` is in the BACKGROUND and
    // `activeTabId` is the one currently shown.
    const backgroundTabId = manager.createTab('https://a.example/')
    const activeTabId = manager.createTab('https://c.example/')
    fakeContentView.addChildView.mockClear()
    fakeContentView.removeChildView.mockClear()

    // A background tab's swap must not touch the window's own child views
    // at all -- it is not currently attached to `contentView`.
    manager.navigate(backgroundTabId, 'https://b.example/')
    expect(fakeContentView.addChildView).not.toHaveBeenCalled()
    expect(fakeContentView.removeChildView).not.toHaveBeenCalled()

    // The ACTIVE tab's swap must remove the old view and attach the new one.
    manager.navigate(activeTabId, 'https://d.example/')
    expect(fakeContentView.removeChildView).toHaveBeenCalledTimes(1)
    expect(fakeContentView.addChildView).toHaveBeenCalledTimes(1)
  })
})

// A108/A109: navigate() is only reached via the omnibox or the dashboard's
// own navigate command -- a same-view HTTP redirect, a clicked link, a form
// submission or a script setting location.href all reach a new origin
// WITHOUT ever calling navigate(), and Chromium's did-navigate event is the
// one thing they all fire in common (electron/web-contents.md's own
// Navigation Events list). The fake webContents' 'did-navigate' is emitted
// directly here for exactly the reason the file header above states: this
// is only observable by actually emitting the event, not by calling a
// TabManager method.
describe('TabManager -- did-navigate repartitions a tab for a redirect, link, form submission or script navigation (A108/A109)', () => {
  it('a same-view redirect to a different origin ends in that origin\'s partition', () => {
    const manager = newManager()
    manager.createTab('https://a.example/')
    const view = createdViews[0] as RecordedView

    // Chromium follows the redirect inside the SAME WebContentsView --
    // did-navigate fires with the FINAL url, never navigate().
    view.webContents.emit('did-navigate', {}, 'https://b.example/')

    expect(createdViews).toHaveLength(2)
    const expected = partitionFor(originFromUrl('https://b.example/') as string)
    expect(partitionOf(createdViews[1] as RecordedView)).toBe(expected)
  })

  it('a same-origin redirect does not swap', () => {
    const manager = newManager()
    manager.createTab('https://a.example/one')
    const view = createdViews[0] as RecordedView

    view.webContents.emit('did-navigate', {}, 'https://a.example/two')

    expect(createdViews).toHaveLength(1)
  })

  it('a clicked link or script-driven navigation to a different origin swaps exactly like a redirect -- TabManager cannot tell them apart, and must not need to', () => {
    const manager = newManager()
    manager.createTab('https://a.example/')
    const view = createdViews[0] as RecordedView

    view.webContents.emit('did-navigate', {}, 'https://attacker.example/')

    expect(createdViews).toHaveLength(2)
    const expected = partitionFor(originFromUrl('https://attacker.example/') as string)
    expect(partitionOf(createdViews[1] as RecordedView)).toBe(expected)
  })

  it('a same-origin navigation (a link to another path on the same origin) does not swap', () => {
    const manager = newManager()
    manager.createTab('https://a.example/one')
    const view = createdViews[0] as RecordedView

    view.webContents.emit('did-navigate', {}, 'https://a.example/two/three')

    expect(createdViews).toHaveLength(1)
  })

  it('a dashboard tab never repartitions on its own did-navigate, even though its dev-mode URL is a real http(s) address', () => {
    const manager = newManager()
    manager.createTab() // dashboard -- no partition
    const view = createdViews[0] as RecordedView

    // The dashboard's own createTab() already loads DASHBOARD_URL, which
    // has a real, derivable origin -- without the isDashboardTab guard this
    // would look exactly like an "origin change" from undefined.
    view.webContents.emit('did-navigate', {}, DASHBOARD_URL)

    expect(createdViews).toHaveLength(1)
    expect(partitionOf(createdViews[0] as RecordedView)).toBeUndefined()
  })

  it('a dashboard tab does not repartition even if its own page navigates itself to a real, different origin outside navigate()', () => {
    const manager = newManager()
    manager.createTab() // dashboard
    const view = createdViews[0] as RecordedView

    view.webContents.emit('did-navigate', {}, 'https://app.example/')

    expect(createdViews).toHaveLength(1)
  })

  it('a did-navigate landing on about:blank never swaps -- partitionForTarget(BLANK_URL) is always undefined', () => {
    const manager = newManager()
    manager.createTab('https://a.example/')
    const view = createdViews[0] as RecordedView

    view.webContents.emit('did-navigate', {}, 'about:blank')

    expect(createdViews).toHaveLength(1)
  })

  it('closes the OLD view\'s webContents on a did-navigate-triggered swap -- no leaked WebContentsView', () => {
    const manager = newManager()
    manager.createTab('https://a.example/')
    const view = createdViews[0] as RecordedView

    view.webContents.emit('did-navigate', {}, 'https://b.example/')

    expect(view.webContents.close).toHaveBeenCalledTimes(1)
  })

  it('does not forget the tab when a did-navigate-triggered swap closes the OLD view', () => {
    const manager = newManager()
    const id = manager.createTab('https://a.example/')
    const view = createdViews[0] as RecordedView

    view.webContents.emit('did-navigate', {}, 'https://b.example/')

    const state = manager.getState()
    expect(state.tabs.map((t) => t.id)).toContain(id)
    expect(state.tabs).toHaveLength(1)
  })
})

