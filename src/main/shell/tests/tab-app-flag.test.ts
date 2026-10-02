import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { originFromUrl } from '../../../broker/policy/origin.js'
import type { SubsystemContext } from '../../registry.js'

// ADR-0017's synchronous fetch()-routing flag (appTabArgsFor), split out of
// tabs.test.ts as its own concern (Rule 2), alongside that file's other
// per-topic siblings (tab-move.test.ts, tab-split.test.ts, ...).
//
// THE PRIMARY USER PATH: a fresh tab (dashboard or otherwise) navigated via
// the omnibox -- ipc.ts's 'navigate' command and newtab-ipc.ts's dashboard
// navigate both funnel here. Attempt 1 only wired partitioning into
// createTab()'s own construction arguments, which a real launch proved is
// NOT the path an actual person takes: nobody's very first act in a fresh
// tab is calling createTab(url) directly, they type into the address bar,
// which is navigate(). These tests exist because the e2e test alone did not
// catch this fast enough -- it needs a real Electron launch to run at all.
interface FakeWebContents extends EventEmitter {
  loadURL: ReturnType<typeof vi.fn>
  isDestroyed: ReturnType<typeof vi.fn>
  isLoading: ReturnType<typeof vi.fn>
  getURL: ReturnType<typeof vi.fn>
  getTitle: ReturnType<typeof vi.fn>
  navigationHistory: { canGoBack: () => boolean, canGoForward: () => boolean, getAllEntries: () => never[], getActiveIndex: () => number }
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  ipc: { on: ReturnType<typeof vi.fn> }
  close: ReturnType<typeof vi.fn>
}

interface RecordedView {
  options: { webPreferences?: Record<string, unknown> }
  webContents: FakeWebContents
  setBounds: ReturnType<typeof vi.fn>
  setBackgroundColor: ReturnType<typeof vi.fn>
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
  emitter.navigationHistory = { canGoBack: () => false, canGoForward: () => false, getAllEntries: () => [], getActiveIndex: () => -1 }
  emitter.setWindowOpenHandler = vi.fn()
  emitter.ipc = { on: vi.fn() }
  emitter.close = vi.fn(() => { destroyed = true; emitter.emit('destroyed') })
  return emitter
}

vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: RecordedView, options: RecordedView['options']) {
    this.options = options
    this.webContents = makeFakeWebContents()
    this.setBounds = vi.fn()
    this.setBackgroundColor = vi.fn()
    createdViews.push(this)
  })
}))

const { TabManager } = await import('../tabs.js')

const fakeContentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
const fakeBounds = { x: 0, y: 0, width: 800, height: 600 }
const fakeCtx = {} as SubsystemContext
const DASHBOARD_URL = 'http://localhost:5999/newtab/'

function newManager (ctx: SubsystemContext = fakeCtx): InstanceType<typeof TabManager> {
  return new TabManager(fakeContentView as never, () => fakeBounds, vi.fn(), DASHBOARD_URL, ctx)
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

/** Unlike ctxWithRegisteredOrigins: registered but never granted, the
 * ordinary pre-consent state where isRegisteredSync and hasGrantsSync disagree. */
function ctxWithUngrantedApp (origin: string): SubsystemContext {
  return { broker: { app: { isRegisteredSync: (o: string) => o === origin, hasGrantsSync: () => false } } } as unknown as SubsystemContext
}

beforeEach(() => {
  createdViews.length = 0
  fakeContentView.addChildView.mockClear()
  fakeContentView.removeChildView.mockClear()
})

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

  // isRegisteredSync (the flag) and hasGrantsSync (isolation) can disagree
  // with no partition swap at all -- an in-place navigation must catch it both ways.
  it('the flag follows registration across an in-place navigation, even with no partition swap ever happening', () => {
    const manager = newManager(ctxWithUngrantedApp('https://app.example'))
    const id = manager.createTab('https://app.example/page')
    expect(additionalArgumentsOf(createdViews[0] as RecordedView)).toEqual(['--orivon-app-tab'])
    manager.navigate(id, 'https://plain-website.example/')
    expect(additionalArgumentsOf(createdViews[1] as RecordedView)).toBeUndefined()
    manager.navigate(id, 'https://app.example/page')
    // ADR-0044: this app holds no partition of its own, but the view it left
    // parked under its own origin (tab-view.ts's parkKeyFor) rather than
    // closing, so returning to it hands the SAME view back instead of
    // building a third one -- and it still carries the flag it was built
    // with, unchanged.
    expect(createdViews.length).toBe(2)
    expect(additionalArgumentsOf(createdViews[0] as RecordedView)).toEqual(['--orivon-app-tab'])
  })
})
