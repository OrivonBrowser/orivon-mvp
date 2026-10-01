// Stand-ins for a tab collection and the pages in it, shared by the memory saver's tests.
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { TabManager } from '../../shell/tabs.js'
import type { TabRecord } from '../../shell/tab-types.js'
import type { SleepEnv } from '../sleep-facts.js'

export interface FakePage {
  url: string
  title: string
  entries: Array<{ url: string, title: string, pageState?: string }>
  active: number
  audible: boolean
  captured: boolean
  devtools: boolean
  loading: boolean
  crashed: boolean
  destroyed: boolean
  restore: Mock<() => Promise<void>>
  loadURL: Mock<() => Promise<void>>
  close: Mock<() => void>
}

export function page (url = 'https://a.example/page', over: Partial<FakePage> = {}): FakePage & { wc: unknown } {
  const fake: FakePage = {
    url, title: 'A page', entries: [{ url: 'https://a.example/first', title: 'First', pageState: 'secret' }, { url, title: 'A page', pageState: 'typed' }], active: 1,
    audible: false, captured: false, devtools: false, loading: false, crashed: false, destroyed: false,
    restore: vi.fn(async () => {}), loadURL: vi.fn(async () => {}), close: vi.fn(),
    ...over
  }
  const wc = {
    getURL: () => fake.url,
    getTitle: () => fake.title,
    isCurrentlyAudible: () => fake.audible,
    isBeingCaptured: () => fake.captured,
    isDevToolsOpened: () => fake.devtools,
    isLoading: () => fake.loading,
    isCrashed: () => fake.crashed,
    isDestroyed: () => fake.destroyed,
    navigationHistory: { getAllEntries: () => fake.entries, getActiveIndex: () => fake.active, restore: fake.restore },
    loadURL: fake.loadURL,
    close: () => { fake.destroyed = true; fake.close() }
  }
  return Object.assign(fake, { wc })
}

export interface FakeTabs {
  tabs: TabManager
  records: Map<string, TabRecord>
  ids: string[]
  changed: ReturnType<typeof vi.fn>
  viewReplaced: ReturnType<typeof vi.fn>
  setActive: (id: string | null) => void
  pair: (a: string, b: string) => void
}

export function fakeTabs (pages: Record<string, ReturnType<typeof page>>, over: Partial<TabRecord> = {}): FakeTabs {
  const records = new Map<string, TabRecord>()
  const viewReplaced = vi.fn()
  const changed = vi.fn()
  let active: string | null = null
  const partners = new Map<string, string>()
  for (const [id, fake] of Object.entries(pages)) {
    records.set(id, {
      host: { preloadPath: '/preload.js', isClosing: () => false, isShown: (shown: string) => shown === active, tabLifecycle: { viewReplaced }, window: undefined, devtools: undefined, services: undefined },
      view: { webContents: fake.wc },
      favicon: 'data:image/png;base64,AAAA', faviconOrigin: null, pendingFaviconUrl: null, partition: undefined, isDashboardTab: false, internalPage: null, parkedViews: new Map(),
      pinned: false, ...over
    } as unknown as TabRecord)
  }
  const tabs = {
    record: (id: string) => records.get(id),
    ids: () => [...records.keys()],
    liveWebContents: (id: string) => { const wc = (records.get(id)?.view.webContents as unknown as { isDestroyed: () => boolean } | undefined); return wc === undefined || wc.isDestroyed() ? undefined : wc },
    getState: () => ({ tabs: [], activeTabId: active }),
    changed,
    activateTab: (id: string) => { active = id },
    splits: { groups: { partnerOf: (id: string) => partners.get(id) ?? null } }
  } as unknown as TabManager
  return {
    tabs, records, ids: [...records.keys()], changed, viewReplaced,
    setActive: (id) => { active = id },
    pair: (a, b) => { partners.set(a, b); partners.set(b, a) }
  }
}

export function env (over: Partial<SleepEnv> = {}): SleepEnv {
  return { now: () => 5000, hasAsk: () => false, mediaInUse: () => false, keepAwakeList: () => '', unsaved: async () => false, ...over }
}
