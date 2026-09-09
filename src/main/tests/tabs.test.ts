import { beforeEach, describe, expect, it, vi } from 'vitest'
import { originFromUrl } from '../../broker/policy/origin.js'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import type { SubsystemContext } from '../registry.js'

// tabs.ts imports WebContentsView directly from 'electron' at module scope --
// outside a real Electron process this cannot even be imported without
// mocking it first (same reasoning as src/preload/tests/orivon-surface.test.ts).
// The fake constructor records every options object it was built with, which
// is all these tests need to inspect: they never drive a real webContents.
interface RecordedView {
  options: { webPreferences?: Record<string, unknown> }
}
const createdViews: RecordedView[] = []

function makeFakeWebContents (): Record<string, unknown> {
  return {
    on: vi.fn(),
    loadURL: vi.fn(async () => {}),
    isDestroyed: vi.fn(() => false),
    isLoading: vi.fn(() => false),
    getURL: vi.fn(() => ''),
    getTitle: vi.fn(() => ''),
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    setWindowOpenHandler: vi.fn(),
    close: vi.fn()
  }
}

vi.mock('electron', () => ({
  WebContentsView: vi.fn().mockImplementation(function (this: RecordedView, options: RecordedView['options']) {
    this.options = options
    ;(this as unknown as { webContents: unknown; setBounds: () => void }).webContents = makeFakeWebContents()
    ;(this as unknown as { setBounds: () => void }).setBounds = vi.fn()
    createdViews.push(this)
  })
}))

const { TabManager } = await import('../tabs.js')

const fakeContentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
const fakeBounds = { x: 0, y: 0, width: 800, height: 600 }
const fakeCtx = {} as SubsystemContext
const DASHBOARD_URL = 'http://localhost:5999/newtab/'

function newManager (): InstanceType<typeof TabManager> {
  return new TabManager(
    fakeContentView as never,
    () => fakeBounds,
    vi.fn(),
    DASHBOARD_URL,
    fakeCtx
  )
}

function partitionOf (view: RecordedView): unknown {
  return view.options.webPreferences?.['partition']
}

beforeEach(() => {
  createdViews.length = 0
})

describe('TabManager -- per-origin session partitions (ADR-0003, ADR-0007)', () => {
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
