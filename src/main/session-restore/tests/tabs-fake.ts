// A stand-in for a window's tabs: what open-snapshot, reopen and restore call, recorded.
import { vi } from 'vitest'
import type { ShellWindow } from '../../shell/window-registry.js'
import type { TabManager } from '../../shell/tabs.js'
import type { TabRecord } from '../../shell/tab-types.js'

export interface FakeTabs {
  readonly tabs: TabManager
  readonly records: Map<string, TabRecord>
  readonly order: string[]
  readonly calls: string[]
  active: string | null
  room: boolean
}

export function fakeTabs (room = true): FakeTabs {
  const records = new Map<string, TabRecord>()
  const order: string[] = []
  const calls: string[] = []
  let next = 1
  const fake: FakeTabs = { records, order, calls, active: null, room, tabs: undefined as never }
  const add = (extra: Partial<TabRecord>): string => {
    const id = `t${String(next++)}`
    records.set(id, { internalPage: null, pinned: false, host: {}, view: { webContents: { stop: vi.fn(), reload: vi.fn(), navigationHistory: { restore: vi.fn(() => Promise.resolve()) } } }, ...extra } as unknown as TabRecord)
    order.push(id)
    return id
  }
  const tabs = {
    hasRoom: () => fake.room,
    get tabCount () { return order.length },
    ids: () => [...order],
    record: (id: string) => records.get(id),
    createTab: vi.fn((url?: string, active = true) => {
      calls.push(`create ${url ?? '(new tab page)'} ${active ? 'front' : 'back'}`)
      const id = add({})
      if (active) fake.active = id
      return id
    }),
    openInternal: vi.fn((page: string, path = '/') => {
      calls.push(`internal ${page}${path}`)
      const existing = order.find((id) => records.get(id)?.internalPage === page)
      if (existing !== undefined) { fake.active = existing; return }
      fake.active = add({ internalPage: page as never })
    }),
    activateTab: vi.fn((id: string) => { calls.push(`activate ${id}`); fake.active = id }),
    moveTab: vi.fn((id: string, index: number) => {
      calls.push(`move ${id} ${String(index)}`)
      order.splice(order.indexOf(id), 1)
      order.splice(index, 0, id)
    }),
    changed: vi.fn(() => { calls.push('changed') })
  }
  return Object.assign(fake, { tabs: tabs as unknown as TabManager })
}

export function shellWindow (id: number, fake: FakeTabs): ShellWindow & { window: { show: ReturnType<typeof vi.fn>, focus: ReturnType<typeof vi.fn>, destroyed: boolean } } {
  const window = { id, destroyed: false, show: vi.fn(), focus: vi.fn(), isDestroyed: () => window.destroyed }
  return { window, tabs: fake.tabs } as unknown as ShellWindow & { window: typeof window }
}
