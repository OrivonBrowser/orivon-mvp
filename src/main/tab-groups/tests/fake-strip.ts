// A strip of tabs that behaves like the real collection where groups care: the same ordering function, joined
// pairs moving as one, and the hooks and state listeners called when the real ones would be.
import { vi } from 'vitest'
import { moveInOrder } from '../../shell/tab-order.js'
import type { TabManager } from '../../shell/tabs.js'
import type { TabRecord } from '../../shell/tab-types.js'
import type { WindowContext } from '../../shell/window-context.js'
import { tabGroupsHook } from '../groups-hook.js'
import { groupsFor } from '../groups-model.js'

export interface FakeStrip {
  readonly tabs: TabManager
  readonly order: string[]
  readonly records: Map<string, TabRecord>
  readonly pairs: Array<[string, string]>
  readonly ctx: WindowContext
  readonly sent: unknown[]
  active: string | null
  created: number
  /** The group of each tab, in the strip's order, '-' for none: a compact way to read a result. */
  shape: () => string
}

export function fakeStrip (ids: string[], options: { pinned?: string[], pairs?: Array<[string, string]>, active?: string, hook?: boolean } = {}): FakeStrip {
  const order = [...ids]
  const records = new Map<string, TabRecord>(ids.map((id) => [id, { pinned: options.pinned?.includes(id) === true, groupId: null } as unknown as TabRecord]))
  const pairs = options.pairs ?? []
  const listeners = new Set<(state: { activeTabId: string | null }) => void>()
  const sent: unknown[] = []
  const isPinned = (id: string): boolean => records.get(id)?.pinned === true
  const partnerOf = (id: string): string | null => pairs.find(([a, b]) => a === id || b === id)?.find((other) => other !== id) ?? null
  const strip = { order, records, pairs, sent, active: options.active ?? ids[0] ?? null, created: 0 } as unknown as FakeStrip
  const tabs = {
    ids: () => [...order],
    record: (id: string) => records.get(id),
    get tabCount () { return order.length },
    hasRoom: () => true,
    splits: { groups: { pairs: () => pairs, partnerOf } },
    afterMove: undefined as ((id: string) => void) | undefined,
    afterOpen: undefined as ((id: string, opener: string | null) => void) | undefined,
    changed: vi.fn(() => { for (const listener of [...listeners]) listener({ activeTabId: strip.active }) }),
    getState: () => ({ activeTabId: strip.active, tabs: order.map((id) => ({ id, group: records.get(id)?.groupId ?? null })) }),
    onStateChange: (listener: (state: { activeTabId: string | null }) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    activateTab: vi.fn((id: string) => { strip.active = id; tabs.changed() }),
    createTab: vi.fn(() => {
      const id = `n${String(++strip.created)}`
      records.set(id, { pinned: false, groupId: null } as unknown as TabRecord)
      order.push(id)
      strip.active = id
      tabs.changed()
      return id
    }),
    closeTab: vi.fn((id: string) => {
      order.splice(order.indexOf(id), 1)
      records.delete(id)
      if (strip.active === id) strip.active = order[0] ?? null
      tabs.changed()
    }),
    moveTab: vi.fn((id: string, index: number) => {
      const partner = partnerOf(id)
      let moved: boolean
      if (partner === null) moved = moveInOrder(order, id, index, pairs, isPinned)
      else {
        const rest = order.filter((other) => other !== id && other !== partner)
        const at = Math.min(Math.max(0, index), rest.length)
        const [first, second] = pairs.find(([a, b]) => a === id || b === id) ?? [id, partner]
        const next = [...rest.slice(0, at), first, second, ...rest.slice(at)]
        moved = next.some((other, place) => other !== order[place])
        order.splice(0, order.length, ...next)
      }
      if (moved) { tabs.afterMove?.(id); tabs.changed() }
    })
  }
  Object.assign(strip, {
    tabs: tabs as unknown as TabManager,
    shape: () => order.map((id) => `${id}:${records.get(id)?.groupId ?? '-'}`).join(' '),
    ctx: { window: { tabs, window: { getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) }, chrome: { webContents: { isDestroyed: () => false, send: (_channel: string, event: unknown) => { sent.push(event) } } }, overlays: { show: vi.fn() }, shortcutsSuspended: () => false }, services: {} } as unknown as WindowContext
  })
  if (options.hook !== false) tabGroupsHook.opened?.(strip.ctx, {} as never)
  return strip
}

/** Gives the tabs a group, in the strip's order, and returns its id. */
export function groupOf (strip: FakeStrip, members: string[], title = ''): string {
  const id = groupsFor(strip.tabs).create(undefined, title)
  for (const member of members) { const record = strip.records.get(member); if (record !== undefined) record.groupId = id }
  return id
}
