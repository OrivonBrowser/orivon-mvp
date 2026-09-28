import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { originFromUrl } from '../../../broker/policy/origin.js'
import { partitionFor } from '../../../broker/grants/origin-hash.js'
import type { SubsystemContext } from '../../registry.js'

// tabs.ts imports WebContentsView directly from 'electron' at module scope --
// outside a real Electron process this cannot even be imported without
// mocking it first (same reasoning as src/preload/surface/tests/orivon.test.ts).
// The fake webContents is a REAL EventEmitter, not a bag of vi.fn() no-ops:
// the swap-on-navigate behaviour below depends on which view's listeners act
// for the tab (a swapped-out view's 'destroyed' must not reach forgetTab(),
// and a kept one's events must not reach the tab at all), and that is only
// observable by actually emitting events through it.
/** A tab's history as a list of URLs, which a test sets directly. Removing
 * the active entry is refused, as Electron refuses it. */
interface FakeHistory {
  entries: string[]
  active: number
  canGoBack: () => boolean
  canGoForward: () => boolean
  getActiveIndex: () => number
  length: () => number
  getEntryAtIndex: (index: number) => { url: string }
  removeEntryAtIndex: (index: number) => boolean
}

interface FakeWebContents extends EventEmitter {
  loadURL: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  isLoading: ReturnType<typeof vi.fn>
  getURL: ReturnType<typeof vi.fn>
  getTitle: ReturnType<typeof vi.fn>
  navigationHistory: FakeHistory
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

function makeFakeHistory (): FakeHistory {
  const history: FakeHistory = {
    entries: [],
    active: -1,
    canGoBack: () => false,
    canGoForward: () => false,
    getActiveIndex: () => history.active,
    length: () => history.entries.length,
    getEntryAtIndex: (index) => ({ url: history.entries[index] ?? '' }),
    removeEntryAtIndex: (index) => {
      if (index === history.active || index < 0 || index >= history.entries.length) return false
      history.entries.splice(index, 1)
      if (index < history.active) history.active--
      return true
    }
  }
  return history
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
  emitter.navigationHistory = makeFakeHistory()
  emitter.setWindowOpenHandler = vi.fn()
  // Real Electron destruction can fire 'destroyed' synchronously from
  // close() -- mirrored here so a repartitionView() that forgot to strip
  // the OLD view's listener FIRST would be caught by this test file, not
  // just in a real launch.
  emitter.close = vi.fn(() => { destroyed = true; emitter.emit('destroyed') })
  return emitter
}

vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: RecordedView, options: RecordedView['options'] & { webContents?: FakeWebContents }) {
    this.options = options
    // An adopted popup arrives with Chromium's own webContents.
    this.webContents = options.webContents ?? makeFakeWebContents()
    this.setBounds = vi.fn()
    createdViews.push(this)
  })
}))

// F35 regression test below needs to force fetchFaviconDataUrlCached to
// reject on demand -- everything else keeps the real favicon.ts (pure
// functions like pickFaviconUrl are exercised for real elsewhere in this
// file's tab-creation flow).
vi.mock('../../browsing/favicon.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../browsing/favicon.js')>()
  return { ...actual, fetchFaviconDataUrlCached: vi.fn().mockResolvedValue(null) }
})

const { TabManager } = await import('../tabs.js')
const { fetchFaviconDataUrlCached } = await import('../../browsing/favicon.js')

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

/** A fake `SubsystemContext` whose broker answers from a caller-supplied set of origins --
 * everything else throws if touched, since no test here needs it. The set answers BOTH
 * `hasGrantsSync` (which decides the partition) and `isRegisteredSync` (which decides
 * ADR-0017's app-tab fetch flag), because these tests predate the two being separate and
 * assert on both: `tab-view.test.ts` is where the distinction itself is proven. */
function ctxWithRegisteredOrigins (...origins: string[]): SubsystemContext {
  const registered = new Set(origins)
  const known = (origin: string): boolean => registered.has(origin)
  return {
    broker: { app: { isRegisteredSync: known, hasGrantsSync: known } }
  } as unknown as SubsystemContext
}

beforeEach(() => {
  createdViews.length = 0
  fakeContentView.addChildView.mockClear()
  fakeContentView.removeChildView.mockClear()
})

// Only an INSTALLED APP is isolated -- owner, 2026-09-15, resolving A109.
// Every test that wants a partition therefore has to say which origins are
// registered; a manager built on the bare fakeCtx has no broker at all, which
// reads as "nothing is installed" and is the ordinary-browsing case.
describe('TabManager -- an installed app gets its own session at creation (ADR-0003, ADR-0007)', () => {
  it('assigns a real app tab the exact partition partitionFor(originFromUrl(url)) computes', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://app.example'))
    manager.createTab('https://app.example/page')

    const expected = partitionFor(originFromUrl('https://app.example/page') as string)
    expect(createdViews).toHaveLength(1)
    expect(partitionOf(createdViews[0] as RecordedView)).toBe(expected)
  })

  it('gives two different apps two different partitions', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://a.example', 'https://b.example'))
    manager.createTab('https://a.example/')
    manager.createTab('https://b.example/')

    const partitionA = partitionOf(createdViews[0] as RecordedView)
    const partitionB = partitionOf(createdViews[1] as RecordedView)
    expect(partitionA).not.toBe(partitionB)
    expect(partitionA).not.toBeUndefined()
    expect(partitionB).not.toBeUndefined()
  })

  it('gives two different paths on the SAME origin the SAME partition -- origin is the isolation key, not the full URL', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://app.example'))
    manager.createTab('https://app.example/one')
    manager.createTab('https://app.example/two')

    expect(partitionOf(createdViews[0] as RecordedView)).toBe(partitionOf(createdViews[1] as RecordedView))
  })

  it('every real app partition is persist:-prefixed -- ADR-0003 requires storage to survive a restart', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://app.example'))
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

describe('TabManager -- navigate() swaps a view only when entering or leaving an installed app', () => {
  // THE REGRESSION TEST FOR A109. Before 2026-09-15 this swapped the view,
  // and a swapped-in view starts with empty navigationHistory -- so one
  // ordinary click or redirect to another site killed the back button.
  // Reusing the view is what keeps the history alive; nothing else in this
  // file would catch a return to the old rule.
  it('does NOT swap between two ordinary websites -- the view, and its history, survive', () => {
    const manager = newManager()
    const id = manager.createTab('https://news.example/')
    manager.navigate(id, 'https://search.example/')

    expect(createdViews).toHaveLength(1)
    const view = createdViews[0] as RecordedView
    expect(view.webContents.loadURL).toHaveBeenLastCalledWith('https://search.example/')
    expect(view.webContents.close).not.toHaveBeenCalled()
  })

  it('swaps an ordinary tab OUT of the default session when it reaches an installed app', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://app.example'))
    const id = manager.createTab('https://news.example/')
    manager.navigate(id, 'https://app.example/page')

    expect(createdViews).toHaveLength(2)
    expect(partitionOf(createdViews[0] as RecordedView)).toBeUndefined()
    const expected = partitionFor(originFromUrl('https://app.example/page') as string)
    expect(partitionOf(createdViews[1] as RecordedView)).toBe(expected)
  })

  // The other half of that swap, and the reason partitionChanged returns
  // { to: undefined } rather than plain undefined: an app tab leaving for an
  // ordinary website must NOT keep running it inside the app's own session.
  it('swaps an app tab back onto the shared default session when it leaves for an ordinary website', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://app.example'))
    const id = manager.createTab('https://app.example/page')
    manager.navigate(id, 'https://news.example/')

    expect(createdViews).toHaveLength(2)
    expect(partitionOf(createdViews[1] as RecordedView)).toBeUndefined()
  })

  it('navigating a fresh dashboard tab to an app origin swaps in a view with that origin\'s partition', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://app.example'))
    const id = manager.createTab() // dashboard, no partition
    manager.navigate(id, 'https://app.example/page')

    expect(createdViews).toHaveLength(2)
    const expected = partitionFor(originFromUrl('https://app.example/page') as string)
    expect(partitionOf(createdViews[1] as RecordedView)).toBe(expected)
  })

  it('navigating an existing app tab to a DIFFERENT app swaps to a new view with the new partition', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://a.example', 'https://b.example'))
    const id = manager.createTab('https://a.example/')
    manager.navigate(id, 'https://b.example/')

    expect(createdViews).toHaveLength(2)
    const expected = partitionFor(originFromUrl('https://b.example/') as string)
    expect(partitionOf(createdViews[1] as RecordedView)).toBe(expected)
  })

  it('closes the OLD view\'s webContents when a swap leaves the default session -- no leaked WebContentsView per navigation', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://b.example'))
    const id = manager.createTab('https://a.example/')
    manager.navigate(id, 'https://b.example/')

    expect((createdViews[0] as RecordedView).webContents.close).toHaveBeenCalledTimes(1)
  })

  it('does NOT forget the tab when the OLD (swapped-out) view is destroyed -- the tab is not closing', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://b.example'))
    const id = manager.createTab('https://a.example/')
    manager.navigate(id, 'https://b.example/')

    // close() above already emitted 'destroyed' once (see makeFakeWebContents);
    // had the old view's handler still acted for the tab, forgetTab() already
    // ran by this point and the tab would already be gone.
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
    const manager = newManager(ctxWithRegisteredOrigins('https://a.example'))
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

  it('the swapped-in view\'s own popup handler (T18) still opens a link into another app as a new tab', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://app.example', 'https://popup.example'))
    const id = manager.createTab() // dashboard
    manager.navigate(id, 'https://app.example/')

    const swappedIn = createdViews[1] as RecordedView
    const handler = swappedIn.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as
      ((details: { url: string, features: string, disposition: string }) => { action: string }) | undefined
    expect(handler).toBeTypeOf('function')
    handler?.({ url: 'https://popup.example/', features: '', disposition: 'foreground-tab' })

    expect(createdViews).toHaveLength(3)
    const expected = partitionFor(originFromUrl('https://popup.example/') as string)
    expect(partitionOf(createdViews[2] as RecordedView)).toBe(expected)
  })

  it('adopts a same-session popup as a new active tab, without loading anything itself', () => {
    const manager = newManager()
    const openerId = manager.createTab('https://site.example/')
    const opener = createdViews[0] as RecordedView
    const handler = opener.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as
      (details: { url: string, features: string, disposition: string }) => { action: string, createWindow?: (options: object) => unknown }

    const response = handler({ url: 'https://other.example/', features: '', disposition: 'foreground-tab' })
    const guest = makeFakeWebContents()
    const returned = response.createWindow?.({ webContents: guest, webPreferences: {} })

    expect(returned).toBe(guest)
    const state = manager.getState()
    expect(state.tabs).toHaveLength(2)
    expect(state.activeTabId).not.toBe(openerId)
    expect(fakeContentView.addChildView).toHaveBeenLastCalledWith(createdViews[1])
    expect(guest.loadURL).not.toHaveBeenCalled()
  })

  it('reattaches the swapped view to the window only when the tab being navigated is the ACTIVE one', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://app.example', 'https://b.example', 'https://c.example', 'https://d.example', 'https://popup.example'))
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
  // THE REGRESSION TEST FOR A109 on the redirect path. A redirect between
  // two ordinary websites is now an ordinary navigation inside one view --
  // it was the most common way a real browse lost its back button.
  it('a same-view redirect between two ordinary websites does not swap, so the back button survives it', () => {
    const manager = newManager()
    manager.createTab('https://news.example/')
    const ordinary = createdViews[0] as RecordedView

    ordinary.webContents.emit('did-navigate', {}, 'https://elsewhere.example/')

    expect(createdViews).toHaveLength(1)
    expect(ordinary.webContents.close).not.toHaveBeenCalled()
  })

  it('a same-view redirect INTO an installed app still ends in that app\'s partition', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://b.example'))
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

  it('a clicked link or script-driven navigation INTO an app swaps exactly like a redirect -- TabManager cannot tell them apart, and must not need to', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://app.example'))
    manager.createTab('https://a.example/')
    const view = createdViews[0] as RecordedView

    view.webContents.emit('did-navigate', {}, 'https://app.example/')

    expect(createdViews).toHaveLength(2)
    const expected = partitionFor(originFromUrl('https://app.example/') as string)
    expect(partitionOf(createdViews[1] as RecordedView)).toBe(expected)
  })

  // The escape route that matters for isolation: a script inside an app
  // sending its own tab to an unrelated site must not leave that site
  // sitting in the app's session.
  it('a script inside an app navigating the tab to an ordinary website swaps it back off the app partition', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://app.example'))
    manager.createTab('https://app.example/')
    const view = createdViews[0] as RecordedView

    view.webContents.emit('did-navigate', {}, 'https://attacker.example/')

    expect(createdViews).toHaveLength(2)
    expect(partitionOf(createdViews[1] as RecordedView)).toBeUndefined()
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
    const manager = newManager(ctxWithRegisteredOrigins('https://b.example'))
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

// A page's sessionStorage lives in its view, so a tab that left an app and
// came back in a fresh view found it empty: an OIDC login keeps its state
// there across the trip to the provider, and could never complete. The
// did-navigate events below are that trip's shape: the app sends the tab to
// the provider, and the provider sends it back.
describe('TabManager -- a tab coming back to an app it left gets the app\'s own view back', () => {
  const APP = 'https://app.example'
  const APP_PARTITION = partitionFor(APP)

  /** An app tab that has left for the provider: [0] is the app's kept view, [1] the provider's. */
  function leftForProvider (ctx = ctxWithRegisteredOrigins(APP)): { manager: InstanceType<typeof TabManager>, id: string, app: RecordedView, provider: RecordedView } {
    const manager = newManager(ctx)
    const id = manager.createTab(`${APP}/start`)
    const app = createdViews[0] as RecordedView
    app.webContents.emit('did-navigate', {}, 'https://idp.example/authorize')
    return { manager, id, app, provider: createdViews[1] as RecordedView }
  }

  it('keeps the app\'s view when the tab leaves it, emptied and off the window', () => {
    const { manager, app, provider } = leftForProvider()

    expect(app.webContents.close).not.toHaveBeenCalled()
    expect(app.webContents.loadURL).toHaveBeenLastCalledWith('about:blank')
    expect(fakeContentView.removeChildView).toHaveBeenCalledWith(app)
    expect(manager.activeWebContents()).toBe(provider.webContents)
    expect(partitionOf(provider)).toBeUndefined()
  })

  it('keeps it for a typed navigation away too', () => {
    const manager = newManager(ctxWithRegisteredOrigins(APP))
    const id = manager.createTab(`${APP}/`)
    manager.navigate(id, 'https://news.example/')

    const app = createdViews[0] as RecordedView
    expect(app.webContents.close).not.toHaveBeenCalled()
    expect(app.webContents.loadURL).toHaveBeenLastCalledWith('about:blank')
  })

  it('shows the kept view again when the provider sends the tab back, and closes the provider\'s', () => {
    const { manager, app, provider } = leftForProvider()

    provider.webContents.emit('did-navigate', {}, `${APP}/callback?code=1`)

    expect(createdViews).toHaveLength(2)
    expect(manager.activeWebContents()).toBe(app.webContents)
    expect(app.webContents.loadURL).toHaveBeenLastCalledWith(`${APP}/callback?code=1`)
    expect(fakeContentView.addChildView).toHaveBeenLastCalledWith(app)
    expect(provider.webContents.close).toHaveBeenCalledTimes(1)
    expect(manager.getState().tabs).toHaveLength(1)
  })

  it('keeps each app\'s view apart when a tab moves between two apps', () => {
    const manager = newManager(ctxWithRegisteredOrigins('https://a.example', 'https://b.example'))
    const id = manager.createTab('https://a.example/')
    manager.navigate(id, 'https://b.example/')
    manager.navigate(id, 'https://a.example/back')

    const [a, b] = createdViews as [RecordedView, RecordedView]
    expect(createdViews).toHaveLength(2)
    expect(manager.activeWebContents()).toBe(a.webContents)
    expect(b.webContents.loadURL).toHaveBeenLastCalledWith('about:blank')
    expect(b.webContents.close).not.toHaveBeenCalled()
  })

  it('drops the provider\'s page and the blank page from the app\'s history once the tab is back', () => {
    const { app, provider } = leftForProvider()
    provider.webContents.emit('did-navigate', {}, `${APP}/callback`)

    const history = app.webContents.navigationHistory
    history.entries = [`${APP}/start`, 'https://idp.example/authorize', 'about:blank', `${APP}/callback`]
    history.active = 3
    app.webContents.emit('did-navigate', {}, `${APP}/callback`)

    expect(history.entries).toEqual([`${APP}/start`, `${APP}/callback`])
    expect(history.active).toBe(1)
  })

  it('acts for the tab again once it is back: leaving a second time swaps as the first did', () => {
    const { manager, app, provider } = leftForProvider()
    provider.webContents.emit('did-navigate', {}, `${APP}/callback`)

    app.webContents.emit('did-navigate', {}, 'https://idp.example/logout')

    expect(createdViews).toHaveLength(3)
    expect(manager.activeWebContents()).toBe((createdViews[2] as RecordedView).webContents)
  })

  it('ignores the kept view\'s own events while the tab is away', () => {
    const { manager, id, app, provider } = leftForProvider()
    const unload = { preventDefault: vi.fn() }

    app.webContents.emit('did-navigate', {}, `${APP}/elsewhere`)
    app.webContents.emit('will-prevent-unload', unload)
    app.webContents.emit('destroyed')

    expect(createdViews).toHaveLength(2)
    expect(manager.activeWebContents()).toBe(provider.webContents)
    expect(manager.getState().tabs.map((t) => t.id)).toEqual([id])
    // Emptying a kept page is not the person leaving it: nobody is asked.
    expect(unload.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('builds a fresh view instead when the kept one no longer matches its origin\'s app-tab flag', () => {
    const registered = new Set<string>()
    const ctx = {
      broker: { app: { hasGrantsSync: (o: string) => o === APP, isRegisteredSync: (o: string) => registered.has(o) } }
    } as unknown as SubsystemContext
    const { manager, app, provider } = leftForProvider(ctx)
    registered.add(APP)

    provider.webContents.emit('did-navigate', {}, `${APP}/callback`)

    const fresh = createdViews[2] as RecordedView
    expect(createdViews).toHaveLength(3)
    expect(app.webContents.close).toHaveBeenCalledTimes(1)
    expect(partitionOf(fresh)).toBe(APP_PARTITION)
    expect(additionalArgumentsOf(fresh)).toEqual(['--orivon-app-tab'])
    expect(manager.activeWebContents()).toBe(fresh.webContents)
  })

  it('closes the kept views when the tab closes', () => {
    const { manager, id, app, provider } = leftForProvider()

    manager.closeTab(id)

    expect(app.webContents.close).toHaveBeenCalledTimes(1)
    expect(provider.webContents.close).toHaveBeenCalledTimes(1)
  })

  it('closes the kept views when the tab\'s own view dies', () => {
    const { manager, app, provider } = leftForProvider()

    provider.webContents.emit('destroyed')

    expect(manager.getState().tabs).toHaveLength(0)
    expect(app.webContents.close).toHaveBeenCalledTimes(1)
  })
})

// F35 (CLAUDE-SECURITY-20260910-203341): wireView() used to launch
// captureFavicon with a bare `void` and no .catch. A visited page's own
// favicon host could reject that promise (see favicon.test.ts's
// fetchFaviconDataUrl coverage for how), turning an ordinary page visit
// into an unhandledRejection -- which index.ts deliberately maps to
// app.exit(1), killing every open tab. This exercises the wiring in
// tabs.ts directly, independent of what makes captureFavicon reject.
describe('TabManager -- a rejecting captureFavicon must not escape as an unhandled rejection (F35)', () => {
  it('does not fire process "unhandledRejection" when fetchFaviconDataUrlCached rejects', async () => {
    vi.mocked(fetchFaviconDataUrlCached).mockRejectedValueOnce(new Error('simulated favicon failure'))

    const manager = newManager()
    manager.createTab('https://app.example/')
    const view = createdViews[0] as RecordedView

    const onUnhandledRejection = vi.fn()
    process.once('unhandledRejection', onUnhandledRejection)
    try {
      view.webContents.emit('page-favicon-updated', {}, ['https://evil.example/icon.png'])
      // Give captureFavicon's rejected promise, and Node's own
      // unhandledRejection detection, a full turn of the event loop to
      // surface -- a microtask-only wait (a bare `await Promise.resolve()`)
      // is not enough to reliably observe Node's check.
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection)
    }

    expect(onUnhandledRejection).not.toHaveBeenCalled()
  })
})
