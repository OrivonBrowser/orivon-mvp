import { describe, expect, it, vi } from 'vitest'
import type { OverlayHandler, OverlayWindow } from '../../overlays/overlay-types.js'
import { setCrashLookups } from '../../diagnostics/crash-lookup.js'
import { sadTabOverlay } from '../sad-tab-overlay.js'
import { markUnresponsive } from '../sad-tab-state.js'
import type { TabRecord } from '../../shell/tab-types.js'

interface Rig {
  handler: OverlayHandler
  reload: ReturnType<typeof vi.fn>
  closeTab: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  records: Record<string, TabRecord>
  gone: Set<string>
}

const openInternal = vi.fn()

function rig (records: Record<string, TabRecord>, address = 'https://example.com/page'): Rig {
  const reload = vi.fn()
  const closeTab = vi.fn()
  const close = vi.fn()
  const gone = new Set<string>()
  const win = {
    window: {
      tabs: {
        record: (id: string) => gone.has(id) ? undefined : records[id],
        liveWebContents: (id: string) => gone.has(id) || records[id] === undefined ? undefined : { reload, id: 77 },
        getState: () => ({ tabs: Object.keys(records).map((id) => ({ id, displayUrl: address })) }),
        closeTab,
        openInternal
      }
    },
    close
  } as unknown as OverlayWindow
  return { handler: sadTabOverlay.attach(win), reload, closeTab, close, records, gone }
}

const crashed = (reason: string): TabRecord => ({ crashed: reason }) as unknown as TabRecord

describe('the sad-tab overlay', () => {
  it('is a card over the tab area that only a tab switch closes', () => {
    expect(sadTabOverlay.placement).toEqual({ kind: 'area', at: 'center', width: 420 })
    expect(sadTabOverlay.closeOn).toEqual({ blur: false, tabSwitch: true, navigation: false, layout: false })
    expect(sadTabOverlay.focus).toBe('take')
  })

  describe('show', () => {
    it('builds the card from the record and the tab\'s address', () => {
      const { handler } = rig({ a: crashed('oom') })
      expect(handler.show?.({ id: 'a' })).toEqual({
        kind: 'crashed', title: 'This page stopped working', body: 'This page ran out of memory. Closing other tabs may help.', address: 'https://example.com/page'
      })
    })

    it('says a page is not responding when it stopped answering', () => {
      const tab = { crashed: null } as unknown as TabRecord
      markUnresponsive(tab)
      const { handler } = rig({ a: tab })
      expect(handler.show?.({ id: 'a' })).toMatchObject({ kind: 'unresponsive', title: "This page isn't responding" })
    })

    it('caps the address', () => {
      const { handler } = rig({ a: crashed('crashed') }, `https://example.com/${'x'.repeat(500)}`)
      expect((handler.show?.({ id: 'a' }) as { address: string }).address).toHaveLength(200)
    })

    it('shows nothing for a tab that is gone, healthy, or named wrongly', () => {
      const { handler } = rig({ a: { crashed: null } as unknown as TabRecord })
      expect(handler.show?.({ id: 'a' })).toBeUndefined()
      expect(handler.show?.({ id: 'missing' })).toBeUndefined()
      expect(handler.show?.({ id: 7 })).toBeUndefined()
      expect(handler.show?.(null)).toBeUndefined()
      expect(handler.show?.(undefined)).toBeUndefined()
    })
  })

  describe('request', () => {
    it('reloads the tab the card was shown for, and closes', () => {
      const r = rig({ a: crashed('crashed') })
      r.handler.show?.({ id: 'a' })
      r.handler.request({ type: 'reload' })
      expect(r.reload).toHaveBeenCalledTimes(1)
      expect(r.close).toHaveBeenCalledTimes(1)
    })

    it('closes the card, then the tab', () => {
      const r = rig({ a: crashed('crashed') })
      r.handler.show?.({ id: 'a' })
      r.handler.request({ type: 'close-tab' })
      expect(r.closeTab).toHaveBeenCalledWith('a')
      expect(r.close.mock.invocationCallOrder[0]).toBeLessThan(r.closeTab.mock.invocationCallOrder[0] ?? 0)
    })

    it('opens the report page at the crash record of the page that died', () => {
      setCrashLookups({ page: (id) => id === 77 ? '0123456789abcdef' : undefined, lastRun: () => undefined })
      const r = rig({ a: crashed('crashed') })
      r.handler.show?.({ id: 'a' })
      r.handler.request({ type: 'report' })
      expect(openInternal).toHaveBeenCalledWith('report', '/crash/0123456789abcdef')
      expect(r.reload).not.toHaveBeenCalled()
      setCrashLookups({ page: () => undefined, lastRun: () => undefined })
      r.handler.request({ type: 'report' })
      expect(openInternal).toHaveBeenLastCalledWith('report', '/')
    })

    it('waits: closes without touching the page, and the hang stays quiet', () => {
      const tab = { crashed: null } as unknown as TabRecord
      markUnresponsive(tab)
      const r = rig({ a: tab })
      r.handler.show?.({ id: 'a' })
      r.handler.request({ type: 'wait' })
      expect(r.reload).not.toHaveBeenCalled()
      expect(r.close).toHaveBeenCalledTimes(1)
      expect(r.handler.show?.({ id: 'a' })).toBeUndefined()
    })

    it('ignores anything that is not exactly one of the three words', () => {
      const r = rig({ a: crashed('crashed') })
      r.handler.show?.({ id: 'a' })
      for (const bad of [null, undefined, 'reload', 4, {}, { type: 'other' }, { type: 'reload', id: 'b' }, { type: 'close-tab', extra: 1 }]) r.handler.request(bad)
      expect(r.reload).not.toHaveBeenCalled()
      expect(r.closeTab).not.toHaveBeenCalled()
      expect(r.close).not.toHaveBeenCalled()
    })

    it('never acts on an id the page sends', () => {
      const r = rig({ a: crashed('crashed'), b: crashed('crashed') })
      r.handler.show?.({ id: 'a' })
      r.handler.request({ type: 'close-tab', id: 'b' })
      expect(r.closeTab).not.toHaveBeenCalled()
    })

    it('does nothing before a show, and only closes once the tab is gone', () => {
      const r = rig({ a: crashed('crashed') })
      r.handler.request({ type: 'reload' })
      expect(r.reload).not.toHaveBeenCalled()
      r.handler.show?.({ id: 'a' })
      r.gone.add('a')
      r.handler.request({ type: 'close-tab' })
      expect(r.closeTab).not.toHaveBeenCalled()
      expect(r.close).toHaveBeenCalledTimes(1)
    })

    it('forgets the tab when the card closes', () => {
      const r = rig({ a: crashed('crashed') })
      r.handler.show?.({ id: 'a' })
      r.handler.closed?.('tab-switch')
      r.handler.request({ type: 'reload' })
      expect(r.reload).not.toHaveBeenCalled()
    })
  })
})
